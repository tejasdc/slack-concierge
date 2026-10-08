import { basename } from 'node:path';
import { db, type SessionRow } from './state';
import { getAcceptedSessionInput, sessionInputProvenance, sessionMetadata } from './session-inputs';
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
  measured_at_ms INTEGER,
  since_ms INTEGER NOT NULL
)`);
// Compaction counts were recorded for a fit signal Tejas rejected (2026-10-07); nothing reads them.
for (const column of ['compactions', 'compactions_before', 'last_compaction_at_ms'])
  if (db.query("SELECT 1 FROM pragma_table_info('session_workload') WHERE name=?").get(column))
    db.run(`ALTER TABLE session_workload DROP COLUMN ${column}`);
// The thread a request's topic is read through: its own thread, else the Inbox thread of the human
// message its work started from. Stored at send time so the rule and "holds" use one derivation;
// joined to topics on read because topics are re-placed and merged. '' means none.
if (!(db.query("SELECT 1 FROM pragma_table_info('session_communication_requests') WHERE name='topic_root_input_id'").get()))
  db.run('ALTER TABLE session_communication_requests ADD COLUMN topic_root_input_id TEXT');

type WorkloadRow = { session_id: number; context_tokens: number | null; context_window: number | null; measured_at_ms: number | null; since_ms: number };


const upsert = db.query(`INSERT INTO session_workload(session_id,context_tokens,context_window,measured_at_ms,since_ms)
  VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
  context_tokens=coalesce(excluded.context_tokens,context_tokens), context_window=coalesce(excluded.context_window,context_window),
  measured_at_ms=excluded.measured_at_ms`);

type Measured = { contextTokens?: number | null; contextWindow?: number | null };

function write(sessionIds: number[], measured: Measured) {
  const now = Date.now();
  for (const id of sessionIds) upsert.run(id, measured.contextTokens ?? null, measured.contextWindow ?? null, now, now);
}

/** Claude, as its results pass through the owner: the conversation's latest context. */
export function recordClaudeWorkload(sessionUuid: string | null | undefined, measured: Measured) {
  if (!sessionUuid) return;
  try {
    const ids = (db.query(`SELECT id FROM sessions WHERE provider_id='claude-code' AND agent_session_uuid=?`).all(sessionUuid) as { id: number }[]).map(row => row.id);
    write(ids, measured);
  } catch (error) { log('warn', 'session_workload_record_failed', { provider: 'claude-code', error: error instanceof Error ? error.message : String(error) }); }
}

/** Codex, from the observer: context when Codex reports token usage. */
export function recordCodexWorkload(sessionId: number, measured: Measured) {
  try { write([sessionId], measured); }
  catch (error) { log('warn', 'session_workload_record_failed', { provider: 'codex', error: error instanceof Error ? error.message : String(error) }); }
}

const BACKFILL_DAYS = 14;

/**
 * Once per start: requests sent before topics were stored on them get their topic thread filled from
 * the ledger alone, so "which topics a session handles" covers them too.
 */
export async function backfillRequestTopics(stopped: () => boolean) {
  const started = Date.now();
  let requests = 0;
  for (const row of db.query(`SELECT request_id, thread_root_input_id AS root, source_input_id AS source FROM session_communication_requests
    WHERE topic_root_input_id IS NULL AND created_at_ms >= ?`).all(started - BACKFILL_DAYS * 86_400_000) as { request_id: string; root: string | null; source: string | null }[]) {
    if (stopped()) return;
    db.query('UPDATE session_communication_requests SET topic_root_input_id=? WHERE request_id=?').run(topicRootFor(row.root, row.source) ?? '', row.request_id);
    if (++requests % 100 === 0) await new Promise(resolve => setImmediate(resolve));
  }
  if (requests) log('info', 'request_topics_backfilled', { requests, durationMs: Date.now() - started });
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

/** The facts beside a candidate in search and context; computed per returned session, never in view(). */
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
  // Not its subject means the work belongs elsewhere, so only a too-loaded hand-back names its own project.
  const project = kind === 'too-loaded' ? basename(sessionMetadata(session).cwd ?? '') || '<project>' : '<the project this work belongs to>';
  if (!address) return `Handed back (${HAND_BACK_KINDS[kind as HandBack]}).\nStart a fresh session that can ask this one for context; it runs on another machine, so use its peer address from sessions search with --consult.\n\n${text}`;
  return `Handed back (${HAND_BACK_KINDS[kind as HandBack]}).\nStart a fresh session that can ask this one for context: sessions ask --provider cc-opus --project ${project} --session-name "<this topic>" --consult ${address} <source-flags> --action-id <new id> --requested-effect work [--thread <message-id>] -- <text>\n\n${text}`;
}

/** The pointer a fresh session starts with, so consulting the old one is as easy as reusing it. */
export function consultPointer(address: string): string {
  return `Earlier related work lives in session ${address}. Read it with sessions context ${address}, and ask it for context with sessions ask ${address} --requested-effect informational -- <question>. It is a consultant: do not send it work.`;
}
