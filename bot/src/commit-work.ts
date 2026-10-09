import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { db } from './state';

const run = promisify(execFile);

/**
 * Which of this instance's sessions made a commit, found from what Concierge already holds, so a
 * change links to its conversation and thread whether or not the agent's checkout stamped it
 * (Tejas, 2026-10-09: "I don't think we should be relying on agents ... I think it should be
 * automatically detract here"). A commit is made inside a turn: the candidates are the sessions
 * with a turn running when it was first written (its author time; a rebase moves the commit time
 * and the hash, never the subject or author time). The one that made it is the one whose agent
 * itself wrote the subject: in its commit command or the message file it wrote for it, a line the
 * provider records as the agent's own. A bare mention does not count, because every session that
 * reads the log sees every subject and hash in its tool output; that is how a first version
 * matched the wrong sessions. Several authors, which nothing seen so far produces, answer the one
 * that wrote it closest to the commit. The turn's message, followed back through continuations
 * to what started them, is the work. A found commit is kept for the life of the process.
 */
export type CommitWork = { sessionId: number; turnId: number; input: string | null };
const found = new Map<string, CommitWork | null>();
const SLACK_MS = 3 * 60_000;

const sqliteTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

export function originInput(input: string | null): string | null {
  let current = input;
  for (let hops = 0; current?.startsWith('turn-continuation:') && hops < 20; hops++) {
    const row = db.query('SELECT accepted_input_id AS input FROM turns WHERE id=?').get(Number(current.slice('turn-continuation:'.length))) as { input: string | null } | null;
    if (!row?.input) return current;
    current = row.input;
  }
  return current;
}

async function exists(path: string) { try { return (await stat(path)).isFile(); } catch { return false; } }

/** Every place a provider keeps this session's transcript on this machine. */
async function transcripts(provider: string, uuid: string, atMs: number): Promise<string[]> {
  if (provider === 'codex') {
    const root = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
    // A Codex thread's file sits under the day it began, so look back from the commit's day.
    for (let back = 0; back < 21; back++) {
      const day = new Date(atMs - back * 86_400_000);
      const dir = join(root, String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, '0'), String(day.getUTCDate()).padStart(2, '0'));
      let names: string[] = [];
      try { names = await readdir(dir); } catch { continue; }
      const name = names.find(entry => entry.includes(uuid) && entry.endsWith('.jsonl'));
      if (name) return [join(dir, name)];
    }
    return [];
  }
  const homes = [join(homedir(), '.claude')];
  try { for (const account of await readdir(join(homedir(), '.claude-accounts'))) homes.push(join(homedir(), '.claude-accounts', account)); } catch {}
  const files: string[] = [];
  for (const home of homes) {
    let projects: string[] = [];
    try { projects = await readdir(join(home, 'projects')); } catch { continue; }
    for (const project of projects) {
      const candidate = join(home, 'projects', project, `${uuid}.jsonl`);
      if (await exists(candidate)) files.push(candidate);
    }
  }
  return files;
}

/** The newest moment before `beforeMs` at which the agent itself wrote `subject`, or null. */
async function authored(files: string[], subject: string, beforeMs: number): Promise<number | null> {
  // Search for a stretch of the subject that JSON leaves as it is, then read the lines properly.
  const needle = subject.split(/["\\]/).sort((a, b) => b.length - a.length)[0] ?? '';
  if (needle.length < 12) return null;
  let best: number | null = null;
  for (const file of files) {
    let output = '';
    try { output = (await run('grep', ['-F', '--', needle, file], { maxBuffer: 1 << 26 })).stdout; } catch { continue; }
    for (const line of output.split('\n')) {
      let row: any; try { row = JSON.parse(line); } catch { continue; }
      const own = row.type === 'assistant'
        || (row.type === 'response_item' && ['function_call', 'custom_tool_call', 'local_shell_call'].includes(row.payload?.type));
      const at = Date.parse(row.timestamp);
      if (!own || !Number.isFinite(at) || at > beforeMs || !JSON.stringify(row.message ?? row.payload).includes(JSON.stringify(subject).slice(1, -1))) continue;
      if (best === null || at > best) best = at;
    }
  }
  return best;
}

export async function commitWork(commit: string, subject: string | null, atIso: string): Promise<CommitWork | null> {
  if (!/^[0-9a-f]{7,40}$/.test(commit)) return null;
  if (found.has(commit)) return found.get(commit)!;
  const at = Date.parse(atIso);
  if (!Number.isFinite(at)) return null;
  const turns = db.query(`SELECT t.id, t.session_id AS session, t.accepted_input_id AS input, t.started_at AS started, s.agent_session_uuid AS uuid, s.provider_id AS provider
    FROM turns t JOIN sessions s ON s.id=t.session_id
    WHERE t.status<>'queued' AND t.started_at<=? AND (t.ended_at IS NULL OR t.ended_at>=?) AND s.agent_session_uuid IS NOT NULL
    ORDER BY t.id`)
    .all(sqliteTime(at + SLACK_MS), sqliteTime(at - SLACK_MS)) as { id: number; session: number; input: string | null; started: string; uuid: string; provider: string }[];
  // One candidate per session: its latest turn begun by the commit's time (the slack only admits
  // a turn whose recorded start trails the commit by a clock's worth).
  const bySession = new Map<number, (typeof turns)[number]>();
  for (const turn of turns) if (!bySession.has(turn.session) || turn.started <= sqliteTime(at)) bySession.set(turn.session, turn);
  const candidates = [...bySession.values()];
  const located = await Promise.all(candidates.map(async turn => ({ turn, files: await transcripts(turn.provider, turn.uuid, at) })));
  if (!subject) return null;
  let turn: (typeof candidates)[number] | null = null, nearest = -Infinity;
  for (const entry of located) {
    const writtenAt = await authored(entry.files, subject, at + SLACK_MS);
    if (writtenAt !== null && writtenAt > nearest) { nearest = writtenAt; turn = entry.turn; }
  }
  const answer = turn ? { sessionId: turn.session, turnId: turn.id, input: originInput(turn.input) } : null;
  // Only a found commit is kept: one not yet in a transcript (the turn still writing) is asked again later.
  if (answer) found.set(commit, answer);
  return answer;
}
