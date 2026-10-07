import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { db, type SessionRow } from './state';
import { getAcceptedSessionInput, sessionInputProvenance, sessionMetadata } from './session-inputs';
import { claudeConfigDir, locateClaudeTranscript } from './claude-transcript-watch';
import { log } from './log';
import { takesManySubjects } from './session-roles';

/**
 * Whether a session is a sensible place for a piece of work. Concierge records facts; the router and
 * the receiving session judge.
 *
 * On 2026-10-07 the Inbox sent one session — named for building the retrospective's changes — a
 * reminder change, a background-jobs simplification, an update-gate change, a Provider Accounts
 * investigation and a sign-in guard, because "Concierge internals" read as one owner. Tejas: "Why are
 * they complete random things like being handled with the same fucking session agent?" A first
 * version made Concierge demand a stated reason; he removed it the same evening: "Concerts has no
 * intelligence, he doesn't know, if you hear like reason is actually sound enough … make it so that,
 * The agent can push back on it." So: the subject of work is its Inbox topic; the router sees which
 * topics a session already handles; a session given a topic it does not handle is told so, and may
 * hand the request back (`--hand-back`), which reaches the router with a ready fresh-session command.
 * Design: docs/plans/2026-10-07-session-fit-for-routing.md.
 */

db.run(`CREATE TABLE IF NOT EXISTS session_workload (
  session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  context_tokens INTEGER,
  context_window INTEGER,
  compactions INTEGER NOT NULL DEFAULT 0,
  compactions_before INTEGER,
  last_compaction_at_ms INTEGER,
  measured_at_ms INTEGER,
  since_ms INTEGER NOT NULL
)`);
// The thread a request's topic is read through: its own thread, else the Inbox thread of the human
// message its work started from. Stored at send time so the rule and "holds" use one derivation;
// joined to topics on read because topics are re-placed and merged. '' means none.
if (!(db.query("SELECT 1 FROM pragma_table_info('session_communication_requests') WHERE name='topic_root_input_id'").get()))
  db.run('ALTER TABLE session_communication_requests ADD COLUMN topic_root_input_id TEXT');

type WorkloadRow = { session_id: number; context_tokens: number | null; context_window: number | null; compactions: number;
  compactions_before: number | null; last_compaction_at_ms: number | null; measured_at_ms: number | null; since_ms: number };


const upsert = db.query(`INSERT INTO session_workload(session_id,context_tokens,context_window,compactions,last_compaction_at_ms,measured_at_ms,since_ms)
  VALUES(?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
  context_tokens=coalesce(excluded.context_tokens,context_tokens), context_window=coalesce(excluded.context_window,context_window),
  compactions=compactions+excluded.compactions, last_compaction_at_ms=coalesce(excluded.last_compaction_at_ms,last_compaction_at_ms),
  measured_at_ms=excluded.measured_at_ms`);

function write(sessionIds: number[], measured: { contextTokens?: number | null; contextWindow?: number | null; compactions?: number; lastCompactionAtMs?: number | null }) {
  const now = Date.now();
  for (const id of sessionIds)
    upsert.run(id, measured.contextTokens ?? null, measured.contextWindow ?? null, measured.compactions ?? 0, measured.lastCompactionAtMs ?? null, now, now);
}

/** Claude, as its events pass through the owner: a compaction when it happens, context at each result. */
export function recordClaudeWorkload(sessionUuid: string | null | undefined, measured: { contextTokens?: number | null; contextWindow?: number | null; compactions?: number; lastCompactionAtMs?: number | null }) {
  if (!sessionUuid) return;
  try {
    const ids = (db.query(`SELECT id FROM sessions WHERE provider_id='claude-code' AND agent_session_uuid=?`).all(sessionUuid) as { id: number }[]).map(row => row.id);
    write(ids, measured);
  } catch (error) { log('warn', 'session_workload_record_failed', { provider: 'claude-code', error: error instanceof Error ? error.message : String(error) }); }
}

/** Codex, from the observer: compactions as they happen, context when Codex reports token usage. */
export function recordCodexWorkload(sessionId: number, measured: { contextTokens?: number | null; contextWindow?: number | null; compactions?: number }) {
  try { write([sessionId], { ...measured, lastCompactionAtMs: measured.compactions ? Date.now() : null }); }
  catch (error) { log('warn', 'session_workload_record_failed', { provider: 'codex', error: error instanceof Error ? error.message : String(error) }); }
}

// --- Backfill: sessions that worked before recording existed, counted once from their own record. ---

const CHUNK = 4 * 1024 * 1024;
const TAIL = 2 * 1024 * 1024;
const BOUNDARY = Buffer.from('"subtype":"compact_boundary"');

/** Byte search for compaction rows, JSON-parsing only those rows; context from the transcript's tail. */
async function claudeTranscriptLoad(path: string, beforeMs: number, stopped: () => boolean) {
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    let compactions = 0, lastCompactionAtMs: number | null = null, carry = Buffer.alloc(0);
    const buffer = Buffer.alloc(CHUNK);
    for (let offset = 0; offset < size; ) {
      if (stopped()) return null;
      const { bytesRead } = await file.read(buffer, 0, Math.min(CHUNK, size - offset), offset);
      if (!bytesRead) break;
      offset += bytesRead;
      const data = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
      let at = data.indexOf(BOUNDARY), consumed = 0;
      while (at !== -1) {
        const start = data.lastIndexOf(10, at) + 1, end = data.indexOf(10, at);
        if (end === -1) break;
        try { const row = JSON.parse(data.toString('utf8', start, end)); const atMs = Date.parse(row.timestamp); if (row.type === 'system' && atMs < beforeMs) { compactions++; lastCompactionAtMs = atMs; } } catch {}
        consumed = end + 1;
        at = data.indexOf(BOUNDARY, consumed);
      }
      const lastLine = data.lastIndexOf(10);
      carry = Buffer.from(data.subarray(Math.max(consumed, lastLine + 1)));
      await new Promise(resolve => setImmediate(resolve));
    }
    const tailStart = Math.max(0, size - TAIL), tail = Buffer.alloc(size - tailStart);
    await file.read(tail, 0, tail.length, tailStart);
    let contextTokens: number | null = null;
    const lines = tail.toString('utf8').split('\n');
    for (let index = lines.length - 1; index >= 0 && contextTokens === null; index--) {
      const line = lines[index]!;
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
      try {
        const row = JSON.parse(line), usage = row.type === 'assistant' && !row.isSidechain ? row.message?.usage : null;
        const tokens = usage ? (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : 0;
        if (tokens) contextTokens = tokens;
      } catch {}
      if (line.includes('"compact_boundary"')) break;
    }
    return { compactions, lastCompactionAtMs, contextTokens };
  } finally { await file.close(); }
}

const BACKFILL_DAYS = 14;

/**
 * Once per start: sessions active in the last two weeks whose earlier history is not yet counted get
 * it from their own record — Claude's transcript (read one at a time, yielding between chunks) or the
 * Codex compaction events the owner holds. Only compactions before the row's live recording began are
 * counted, into their own field, so a turn that finishes first never hides the history. Requests sent
 * before topics were stored on them get their topic thread filled the same way.
 */
export async function backfillSessionWorkload(stopped: () => boolean) {
  const started = Date.now();
  let requests = 0;
  for (const row of db.query(`SELECT request_id, thread_root_input_id AS root, source_input_id AS source FROM session_communication_requests
    WHERE topic_root_input_id IS NULL AND created_at_ms >= ?`).all(started - BACKFILL_DAYS * 86_400_000) as { request_id: string; root: string | null; source: string | null }[]) {
    if (stopped()) return;
    db.query('UPDATE session_communication_requests SET topic_root_input_id=? WHERE request_id=?').run(topicRootFor(row.root, row.source) ?? '', row.request_id);
    if (++requests % 100 === 0) await new Promise(resolve => setImmediate(resolve));
  }
  const since = new Date(started - BACKFILL_DAYS * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
  const sessions = (db.query(`SELECT s.* FROM sessions s LEFT JOIN session_workload w ON w.session_id=s.id
    WHERE w.compactions_before IS NULL AND s.agent_session_uuid IS NOT NULL AND s.provider_id IN ('claude-code','codex')
      AND coalesce(s.last_turn_at,s.created_at) >= ? ORDER BY s.id DESC`).all(since) as SessionRow[]).filter(session => !takesManySubjects(session));
  let counted = 0;
  for (const session of sessions) {
    if (stopped()) return;
    db.query('INSERT OR IGNORE INTO session_workload(session_id,measured_at_ms,since_ms) VALUES(?,?,?)').run(session.id, Date.now(), Date.now());
    const beforeMs = workloadRow(session.id)!.since_ms;
    let load: { compactions: number; lastCompactionAtMs: number | null; contextTokens: number | null } | null = null;
    try {
      if (session.provider_id === 'claude-code') {
        const path = await locateClaudeTranscript(claudeConfigDir(), session.agent_session_uuid!);
        load = path ? await claudeTranscriptLoad(path, beforeMs, stopped) : { compactions: 0, lastCompactionAtMs: null, contextTokens: null };
      } else {
        const turns = db.query(`SELECT coalesce(json_extract(payload_json,'$.providerTurnId'),event_id) AS turn, max(created_at) AS at FROM session_owner_events
          WHERE session_id=? AND kind='provider-activity' AND json_extract(payload_json,'$.activity')='compaction' AND created_at < ? GROUP BY 1`)
          .all(session.id, new Date(beforeMs).toISOString().replace('T', ' ').slice(0, 19)) as { turn: string; at: string }[];
        load = { compactions: turns.length, lastCompactionAtMs: turns.length ? Math.max(...turns.map(row => Date.parse(`${row.at.replace(' ', 'T')}Z`) || 0)) : null, contextTokens: null };
      }
    } catch (error) { log('warn', 'session_workload_backfill_failed', { sessionId: session.id, error: error instanceof Error ? error.message : String(error) }); }
    if (!load) continue;
    db.query(`UPDATE session_workload SET compactions_before=?, last_compaction_at_ms=coalesce(last_compaction_at_ms,?),
      context_tokens=coalesce(context_tokens,?) WHERE session_id=?`).run(load.compactions, load.lastCompactionAtMs, load.contextTokens, session.id);
    counted++;
  }
  log('info', 'session_workload_backfilled', { sessions: counted, requests, durationMs: Date.now() - started });
}

// --- Topics a session holds, and what a request is about. ---

const topicOfRoot = (root: string | null | undefined) => root
  ? (db.query('SELECT topic_id FROM inbox_topic_roots WHERE root_input_id=?').get(root) as { topic_id: string } | null)?.topic_id ?? null
  : null;

/**
 * The thread a request's topic is read through: its own Inbox thread, else the Inbox thread of the
 * human message its work started from, so a worker's hand-off inherits the topic it serves (that is
 * how one session drifts across subjects). Null when neither is in the Inbox: outside this rule.
 */
export function topicRootFor(threadRoot: string | null | undefined, sourceInputId: string | null | undefined): string | null {
  if (topicOfRoot(threadRoot)) return threadRoot!;
  const source = sourceInputId ? getAcceptedSessionInput(sourceInputId) : null;
  const human = source ? (source.origin === 'human' ? source.id : sessionInputProvenance(source)?.originatingHuman?.inputId) : null;
  if (!human) return null;
  if (topicOfRoot(human)) return human;
  // His reply inside a thread is not a root; the Inbox's own request from it names the thread.
  const routed = db.query(`SELECT thread_root_input_id AS root FROM session_communication_requests
    WHERE source_input_id=? AND thread_root_input_id IS NOT NULL ORDER BY created_at_ms DESC LIMIT 1`).get(human) as { root: string } | null;
  return routed && topicOfRoot(routed.root) ? routed.root : null;
}

export const topicOf = (topicRoot: string | null) => topicOfRoot(topicRoot);

type HeldTopic = { topic: string; title: string; open: boolean; requests: number; lastMs: number };

/** Topics this session has been given work on, newest first (bounded: the last 300 work requests). */
export function heldTopics(sessionId: number): HeldTopic[] {
  const rows = db.query(`SELECT t.topic_id AS topic, it.title, it.state, r.created_at_ms AS at FROM session_communication_requests r
    JOIN inbox_topic_roots t ON t.root_input_id=coalesce(nullif(r.topic_root_input_id,''),r.thread_root_input_id)
    LEFT JOIN inbox_topics it ON it.topic_id=t.topic_id
    WHERE r.target_session_id=? AND json_extract(r.payload_json,'$.requestedEffect')='work' AND coalesce(r.outcome,'')<>'failed'
    ORDER BY r.created_at_ms DESC LIMIT 300`).all(sessionId) as { topic: string; title: string | null; state: string | null; at: number }[];
  const held = new Map<string, HeldTopic>();
  for (const row of rows) {
    const entry = held.get(row.topic);
    if (entry) entry.requests++;
    else held.set(row.topic, { topic: row.topic, title: row.title ?? row.topic, open: row.state === 'open', requests: 1, lastMs: row.at });
  }
  return [...held.values()];
}

// --- What the router reads, what a receiving session is told, and its hand-back. ---

const iso = (ms: number | null | undefined) => ms ? new Date(ms).toISOString() : null;

export type ForTopic = { topic: string; title: string; holds: boolean; otherOpen: string[] };

/** Whether a session already handles this topic, and which other open topics it is on. Facts only. */
export function forTopic(session: SessionRow, topic: string | null): ForTopic | null {
  if (!topic) return null;
  const held = heldTopics(session.id);
  const title = (db.query('SELECT title FROM inbox_topics WHERE topic_id=?').get(topic) as { title: string } | null)?.title ?? topic;
  return { topic, title, holds: held.some(entry => entry.topic === topic),
    otherOpen: held.filter(entry => entry.open && entry.topic !== topic).map(entry => entry.title) };
}

function workloadRow(sessionId: number) {
  return db.query('SELECT * FROM session_workload WHERE session_id=?').get(sessionId) as WorkloadRow | null;
}

/**
 * The facts beside a candidate in search and context; computed per returned session, never in view().
 * Compactions are recorded but not shown: one job can compact several times, so a count says nothing
 * about fit (Tejas, 2026-10-07).
 */
export function sessionWorkload(session: SessionRow, execution: unknown, topic: string | null) {
  const row = workloadRow(session.id), held = heldTopics(session.id);
  execution ??= db.query("SELECT 1 FROM turns WHERE session_id=? AND status='running' LIMIT 1").get(session.id) ? 'running' : 'idle';
  const open = held.filter(entry => entry.open);
  return {
    context: row?.context_tokens != null ? { tokens: row.context_tokens, window: row.context_window,
      share: row.context_window ? Math.round(row.context_tokens / row.context_window * 100) / 100 : null, measuredAt: iso(row.measured_at_ms) } : null,
    execution,
    topics: { open: open.slice(0, 8).map(entry => ({ topic: entry.topic, title: entry.title, requests: entry.requests, last: iso(entry.lastMs) })),
      openCount: open.length },
    ...(topic ? { forTopic: forTopic(session, topic) } : {}),
    ...(takesManySubjects(session) ? { role: 'takes many topics by design' } : {}),
  };
}

/**
 * What a receiving session reads first when a work request is on a topic it does not handle yet,
 * so it can judge fit with the facts in front of it. It informs; the session decides.
 */
export function newTopicNote(fit: ForTopic): string {
  const others = fit.otherOpen.length ? ` You are also on ${fit.otherOpen.length} other open topic${fit.otherOpen.length === 1 ? '' : 's'}: ${fit.otherOpen.slice(0, 4).map(title => `“${title}”`).join(', ')}.` : '';
  return `This is a new topic for you: “${fit.title}”.${others} If it is not your subject, or you are too loaded to do it well, hand it back (--work-disposition failed --hand-back not-my-subject|too-loaded) and say what context you can give.`;
}

export const HAND_BACK_KINDS = { 'not-my-subject': 'not my subject', 'too-loaded': 'too loaded to do this well' } as const;
export type HandBack = keyof typeof HAND_BACK_KINDS;

/**
 * A receiving session's push-back, as the requester reads it: a fixed first line naming the kind,
 * then the ready-made command for a fresh session that consults the one that handed it back.
 */
export function handBackText(kind: unknown, text: string, session: SessionRow, address: string | null): string {
  if (typeof kind !== 'string' || !Object.hasOwn(HAND_BACK_KINDS, kind)) throw new Error(`--hand-back takes ${Object.keys(HAND_BACK_KINDS).join(' or ')}.`);
  const project = basename(sessionMetadata(session).cwd ?? '') || '<project>';
  if (!address) return `Handed back (${HAND_BACK_KINDS[kind as HandBack]}).\nStart a fresh session that can ask this one for context; it runs on another machine, so use its peer address from sessions search with --consult.\n\n${text}`;
  return `Handed back (${HAND_BACK_KINDS[kind as HandBack]}).\nStart a fresh session that can ask this one for context: sessions ask --provider cc-opus --project ${project} --session-name "<this topic>" --consult ${address} <source-flags> --action-id <new id> --requested-effect work [--thread <message-id>] -- <text>\n\n${text}`;
}

/** The pointer a fresh session starts with, so consulting the old one is as easy as reusing it. */
export function consultPointer(address: string): string {
  return `Earlier related work lives in session ${address}. Read it with sessions context ${address}, and ask it for context with sessions ask ${address} --requested-effect informational -- <question>. It is a consultant: do not send it work.`;
}
