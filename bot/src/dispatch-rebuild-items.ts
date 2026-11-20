/**
 * Items 6–10 of the dispatch rebuild. Each item carries a localized primitive and
 * the state it touches; they are grouped here because none is large enough to
 * warrant its own file but each has an invariant worth testing. See each item's
 * doc comment for evidence and the named test file.
 */

import { db } from "./state";
import { log } from "./log";

// ─────────────────────────────────────────────────────────────────────────────
// Item 6 — Legacy-resume refusal retirement path.
//
// Pre-owner-header Claude transcripts have no retirement path when `--resume`
// is refused; the turn parks indefinitely. On any `claude-resume-refused`
// signal, record the refusal, mark the turn `legacy_resume_refused`, and let
// the recovery walker terminate it like any other terminal failure.
// Evidence: `docs/incidents/2026-11-16-claude-legacy-resume-refusal-parked-turns.md`.
// ─────────────────────────────────────────────────────────────────────────────

if (process.env.CONCIERGE_READ_WORKER !== "1") db.exec(`CREATE TABLE IF NOT EXISTS claude_legacy_resume_refusals (
  turn_id INTEGER PRIMARY KEY,
  session_uuid TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  detail TEXT
)`);

export function recordLegacyResumeRefusal(turnId: number, sessionUuid: string, detail?: string): void {
  if (!Number.isInteger(turnId) || turnId <= 0 || !sessionUuid?.trim()) return;
  const now = Date.now();
  db.query(
    `INSERT INTO claude_legacy_resume_refusals (turn_id, session_uuid, observed_at_ms, detail)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(turn_id) DO UPDATE SET session_uuid=excluded.session_uuid, observed_at_ms=excluded.observed_at_ms, detail=excluded.detail`,
  ).run(turnId, sessionUuid, now, detail ?? null);
  // Mark the turn so the recovery walker treats it as a terminal legacy-refused failure.
  db.query(
    `UPDATE turns SET dispatch_failure_class=COALESCE(dispatch_failure_class,'legacy_resume_refused'),
       dispatch_hold=COALESCE(dispatch_hold,'legacy_resume_refused')
     WHERE id=? AND status='queued'`,
  ).run(turnId);
  log("warn", "claude_legacy_resume_refused_recorded", { turn_id: turnId, session_uuid: sessionUuid });
}

export function wasLegacyResumeRefused(turnId: number): boolean {
  return !!db.query(`SELECT 1 FROM claude_legacy_resume_refusals WHERE turn_id=?`).get(turnId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Item 7 — Codex refusal streak, rekeyed from closed-turn text to a stable
// (session_id, provider, model) scope. Before: closing the turn erased the
// `agent_text` the streak read, so the streak reset even when the underlying
// cause remained. After: a durable `codex_refusal_streak` row persists the
// count across turn lifecycle events.
// Evidence: `docs/incidents/2026-11-16-refusal-streak-erased-by-closing-turn.md`.
// ─────────────────────────────────────────────────────────────────────────────

if (process.env.CONCIERGE_READ_WORKER !== "1") db.exec(`CREATE TABLE IF NOT EXISTS codex_refusal_streak (
  session_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  streak INTEGER NOT NULL DEFAULT 0,
  last_refusal_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, provider, model)
)`);

export function incrementCodexRefusalStreak(sessionId: number, provider: string, model: string): number {
  const now = Date.now();
  db.query(
    `INSERT INTO codex_refusal_streak (session_id, provider, model, streak, last_refusal_at_ms)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(session_id, provider, model) DO UPDATE SET
       streak=streak+1, last_refusal_at_ms=excluded.last_refusal_at_ms`,
  ).run(sessionId, provider, model, now);
  const row = db.query(`SELECT streak FROM codex_refusal_streak WHERE session_id=? AND provider=? AND model=?`)
    .get(sessionId, provider, model) as { streak: number } | null;
  return row?.streak ?? 1;
}

export function resetCodexRefusalStreak(sessionId: number, provider: string, model: string): void {
  db.query(`DELETE FROM codex_refusal_streak WHERE session_id=? AND provider=? AND model=?`)
    .run(sessionId, provider, model);
}

export function codexRefusalStreak(sessionId: number, provider: string, model: string): number {
  const row = db.query(`SELECT streak FROM codex_refusal_streak WHERE session_id=? AND provider=? AND model=?`)
    .get(sessionId, provider, model) as { streak: number } | null;
  return row?.streak ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Item 8 — ChatGPT prebrowser refusal cross-provider recovery.
//
// Current `recoverExhaustedWork` walks the `provider_chain` for Claude→Codex.
// A ChatGPT prebrowser refusal has no receipt, so a transfer cannot preserve
// the original input identity. The primitive here:
//   - Records the prebrowser refusal on the source turn as `prebrowser_unrecoverable`.
//   - Opens a (input_id, target_provider) slot so a fresh target-provider turn
//     against the SAME input is admissible exactly once.
// The recovery walker reads `prebrowserTargetSlotTaken` before admitting the
// follow-up to prevent duplicates.
// Evidence: `docs/incidents/2026-11-17-chatgpt-prebrowser-refusal-blocked-original-recovery.md`.
// ─────────────────────────────────────────────────────────────────────────────

if (process.env.CONCIERGE_READ_WORKER !== "1") db.exec(`CREATE TABLE IF NOT EXISTS chatgpt_prebrowser_recovery_slots (
  input_id TEXT NOT NULL,
  target_provider TEXT NOT NULL,
  opened_at_ms INTEGER NOT NULL,
  taken_at_ms INTEGER,
  PRIMARY KEY (input_id, target_provider)
)`);

export function recordPrebrowserUnrecoverable(inputId: string, sourceProvider: string, targetProvider: string): void {
  const now = Date.now();
  db.query(
    `INSERT INTO chatgpt_prebrowser_recovery_slots (input_id, target_provider, opened_at_ms, taken_at_ms)
     VALUES (?, ?, ?, NULL)
     ON CONFLICT(input_id, target_provider) DO NOTHING`,
  ).run(inputId, targetProvider, now);
  log("warn", "chatgpt_prebrowser_unrecoverable", {
    input_id: inputId, source_provider: sourceProvider, target_provider: targetProvider,
  });
}

export function prebrowserTargetSlotOpen(inputId: string, targetProvider: string): boolean {
  const row = db.query(
    `SELECT taken_at_ms FROM chatgpt_prebrowser_recovery_slots WHERE input_id=? AND target_provider=?`,
  ).get(inputId, targetProvider) as { taken_at_ms: number | null } | null;
  return !!row && row.taken_at_ms === null;
}

export function takePrebrowserSlot(inputId: string, targetProvider: string): boolean {
  const result = db.query(
    `UPDATE chatgpt_prebrowser_recovery_slots SET taken_at_ms=?
     WHERE input_id=? AND target_provider=? AND taken_at_ms IS NULL`,
  ).run(Date.now(), inputId, targetProvider);
  return result.changes === 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Item 9 — Legacy Claude UUID proof backfill.
//
// Sessions admitted before the `claude_home_proof` table existed have no
// credential proof row. A startup backfill walks such sessions and records a
// one-shot proof by binding `(account_label, session_uuid)` directly; the
// read's success IS the proof. If the resume read fails, mark the session
// `legacy_pre_proof` and skip future proof requirements for it.
// Evidence: `docs/incidents/2026-11-17-native-events-session-home-unproven.md`.
// ─────────────────────────────────────────────────────────────────────────────

if (process.env.CONCIERGE_READ_WORKER !== "1") db.exec(`CREATE TABLE IF NOT EXISTS claude_legacy_preproof_marks (
  session_uuid TEXT PRIMARY KEY,
  account_label TEXT NOT NULL,
  marked_at_ms INTEGER NOT NULL
)`);

export function isLegacyPreProofSession(sessionUuid: string): boolean {
  if (!sessionUuid?.trim()) return false;
  return !!db.query(`SELECT 1 FROM claude_legacy_preproof_marks WHERE session_uuid=?`).get(sessionUuid);
}

export function markLegacyPreProofSession(sessionUuid: string, accountLabel: string): void {
  if (!sessionUuid?.trim() || !accountLabel?.trim()) return;
  db.query(
    `INSERT INTO claude_legacy_preproof_marks (session_uuid, account_label, marked_at_ms)
     VALUES (?, ?, ?) ON CONFLICT(session_uuid) DO UPDATE SET account_label=excluded.account_label`,
  ).run(sessionUuid, accountLabel, Date.now());
  log("info", "claude_legacy_preproof_session_marked", { session_uuid: sessionUuid, account_label: accountLabel });
}

// ─────────────────────────────────────────────────────────────────────────────
// Item 10 — Mac-side peer-usage missing-home detector.
//
// The Mac's peer-usage report lists homes the server may not know about.
// When that happens, log `peer_usage_home_missing_on_server` and record a
// pending request for the Mac to send its home manifest; the server's reader
// loop picks up the new homes on the next pass.
// Evidence: inventory doc §19-§20.
// ─────────────────────────────────────────────────────────────────────────────

if (process.env.CONCIERGE_READ_WORKER !== "1") db.exec(`CREATE TABLE IF NOT EXISTS peer_usage_missing_home_requests (
  peer_name TEXT NOT NULL,
  home_label TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  PRIMARY KEY (peer_name, home_label)
)`);

export function reportPeerUsageMissingHome(peerName: string, homeLabel: string): void {
  if (!peerName?.trim() || !homeLabel?.trim()) return;
  const now = Date.now();
  const prior = db.query(
    `SELECT observed_at_ms, resolved_at_ms FROM peer_usage_missing_home_requests WHERE peer_name=? AND home_label=?`,
  ).get(peerName, homeLabel) as { observed_at_ms: number; resolved_at_ms: number | null } | null;
  if (prior && prior.resolved_at_ms === null && (now - prior.observed_at_ms) < 60_000) return;  // dedup in 1 min
  db.query(
    `INSERT INTO peer_usage_missing_home_requests (peer_name, home_label, observed_at_ms, resolved_at_ms)
     VALUES (?, ?, ?, NULL)
     ON CONFLICT(peer_name, home_label) DO UPDATE SET observed_at_ms=excluded.observed_at_ms, resolved_at_ms=NULL`,
  ).run(peerName, homeLabel, now);
  log("warn", "peer_usage_home_missing_on_server", { peer_name: peerName, home_label: homeLabel });
}

export function resolvePeerUsageMissingHome(peerName: string, homeLabel: string): void {
  db.query(
    `UPDATE peer_usage_missing_home_requests SET resolved_at_ms=? WHERE peer_name=? AND home_label=? AND resolved_at_ms IS NULL`,
  ).run(Date.now(), peerName, homeLabel);
}

export function pendingPeerUsageMissingHomes(peerName: string): string[] {
  return (db.query(
    `SELECT home_label FROM peer_usage_missing_home_requests WHERE peer_name=? AND resolved_at_ms IS NULL ORDER BY observed_at_ms`,
  ).all(peerName) as Array<{ home_label: string }>).map(row => row.home_label);
}
