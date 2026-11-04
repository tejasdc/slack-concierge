import type { Database } from "bun:sqlite";
import type { CodexResumeWait } from "./codex";
import { recordRepairNotice, resolveRepairNotice } from "./repair-notices";

/**
 * A Codex turn waits for its thread/resume answer with no deadline (giving up and asking again
 * only stacked cold loads and refused turns, 2026-11-04). The wait still has to be seen: past the
 * notice bound it becomes a repair notice for the standing repair agent, and its end resolves the
 * notice, or adds a recovery fact once the agent was already handed it. The turn keeps waiting.
 */
export function noticeCodexResumeWait(db: Database, turn: { sessionId: number; turnId: number }, wait: CodexResumeWait): void {
  const key = `codex-resume-unanswered:${turn.turnId}:${wait.providerThreadId}:${wait.startedAtMs}`;
  const minutes = Math.round(wait.waitedMs / 60_000);
  if (wait.state === "waiting") {
    recordRepairNotice(db, { key, kind: "stuck_work", text:
      `Codex session ${turn.sessionId}'s turn ${turn.turnId} has waited ${minutes} minutes for the shared Codex App Server `
      + `to answer thread/resume for conversation ${wait.providerThreadId}, and is still waiting. A cold load of the largest `
      + `conversation took about 2.5 minutes, so the App Server may be stuck rather than loading. Check whether it answers `
      + `other requests (Codex App Server runbook, "Resumes Never Ask For History") before acting; Stop on that session ends the wait.` });
    return;
  }
  resolveRepairNotice(db, { key, recoveryKey: `${key}:ended`, kind: "stuck_work", text:
    `Codex session ${turn.sessionId}'s turn ${turn.turnId} stopped waiting for its thread/resume of conversation `
    + `${wait.providerThreadId} after ${minutes} minutes (answered, stopped, or the connection closed).` });
}
