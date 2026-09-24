import { db, executionChanged } from "./state";
import { nativeRunId } from "./session-inputs";
import { log } from "./log";
import type { ClaudeBackgroundWait } from "./claude-code";

// A run waiting on its own background work lives only as long as this process, so
// its wait is process state: it cannot outlive the provider process that holds it.
const waits = new Map<number, ClaudeBackgroundWait>();
const releases = new Map<number, () => boolean>();
const releaseDetails = new Map<number, string>();
const notices = new Set<string>();
const noticeSentAt = new Map<string, number>();

export function recordTurnBackgroundWait(turnId: number, wait: ClaudeBackgroundWait | null) {
  const prior = waits.get(turnId);
  if (wait) waits.set(turnId, wait);
  else if (!waits.delete(turnId)) return;
  const previousJobs = prior?.tasks.map(task => `${task.id}:${task.startedAt}:${task.description}`).join("\n");
  const currentJobs = wait?.tasks.map(task => `${task.id}:${task.startedAt}:${task.description}`).join("\n");
  if (previousJobs === currentJobs) return;
  const currentIds = new Set((wait?.tasks ?? []).map(task => task.id));
  const old = db.query("SELECT task_id FROM background_job_status WHERE turn_id=?").all(turnId) as { task_id: string }[];
  for (const row of old) if (!currentIds.has(row.task_id))
    db.query("DELETE FROM background_job_status WHERE turn_id=? AND task_id=?").run(turnId, row.task_id);
  for (const task of wait?.tasks ?? []) db.query(`INSERT INTO background_job_status
    (turn_id,task_id,description,started_at_ms,holding_only) VALUES (?,?,?,?,?)
    ON CONFLICT(turn_id,task_id) DO UPDATE SET description=excluded.description,
      started_at_ms=excluded.started_at_ms,holding_only=excluded.holding_only`)
    .run(turnId, task.id, task.description, task.startedAt, releases.has(turnId) ? 1 : 0);
  executionChanged();
}

export function turnBackgroundWait(turnId: number) {
  const wait = waits.get(turnId);
  return wait ? { since: new Date(wait.since).toISOString(), tasks: wait.tasks.map(task => task.description),
    jobs: wait.tasks.map(task => ({ id: task.id, description: task.description,
      startedAt: new Date(task.startedAt).toISOString(), ageMs: Date.now() - task.startedAt,
      told30: notices.has(`background-job:${nativeRunId(turnId)}:${task.id}:30`),
      told60: notices.has(`background-job:${nativeRunId(turnId)}:${task.id}:60`) })),
    holdingOnlyOnJobs: releases.has(turnId) } : null;
}

export function registerBackgroundRelease(turnId: number, release: (() => boolean) | null) {
  if (release) releases.set(turnId, release);
  else releases.delete(turnId);
  db.query("UPDATE background_job_status SET holding_only=? WHERE turn_id=?").run(release ? 1 : 0, turnId);
  executionChanged();
}

export function takeBackgroundReleaseDetail(turnId: number): string | null {
  const detail = releaseDetails.get(turnId) ?? null;
  releaseDetails.delete(turnId);
  return detail;
}

/** The live owner checks jobs without adding a second durable timer or a provider turn. */
export function startBackgroundJobWatch(admit: (input: {
  sessionId: number; inputId: string; origin: "service"; sourceInputId: string;
  sourceRunId: string; requestId: string; text: string; delivery: "steer";
}) => unknown): () => void {
  const tick = () => {
    const updateWaiting = !!db.query(`SELECT 1 FROM deployment_runs
      WHERE target='concierge' AND status IN ('prepared','draining') LIMIT 1`).get();
    const now = Date.now();
    for (const [turnId, wait] of waits) {
      const turn = db.query("SELECT session_id,status FROM turns WHERE id=?").get(turnId) as
        { session_id: number; status: string } | null;
      if (!turn || turn.status !== "running") continue;
      for (const task of wait.tasks) {
        const age = now - task.startedAt;
        for (const mark of [30, 60] as const) {
          if (age < mark * 60_000) continue;
          const id = `background-job:${nativeRunId(turnId)}:${task.id}:${mark}`;
          if (notices.has(id)) continue;
          try {
            admit({ sessionId: turn.session_id, inputId: id, origin: "service", sourceInputId: id,
              sourceRunId: nativeRunId(turnId), requestId: id, delivery: "steer",
              text: `Your background job “${task.description}” has been running for ${Math.floor(age / 60_000)} minutes.${updateWaiting ? " A Concierge update is waiting for this run." : ""} Do you still intend to keep it running? If not, stop it now. This is a service notice, not a request; no reply is owed.` });
            notices.add(id);
            noticeSentAt.set(id, now);
            db.query(`UPDATE background_job_status SET ${mark === 30 ? "told_30" : "told_60"}=1
              WHERE turn_id=? AND task_id=?`).run(turnId, task.id);
            executionChanged();
            log("info", "background_job_notice_sent", { turn_id: turnId, task_id: task.id, mark });
          } catch (error) {
            log("info", "background_job_notice_skipped", { turn_id: turnId, task_id: task.id,
              mark, reason: error instanceof Error ? error.message : String(error) });
          }
        }
        if (updateWaiting && age >= 30 * 60_000) {
          const id = `background-job:${nativeRunId(turnId)}:${task.id}:update`;
          if (!notices.has(id)) {
            try {
              admit({ sessionId: turn.session_id, inputId: id, origin: "service", sourceInputId: id,
                sourceRunId: nativeRunId(turnId), requestId: id, delivery: "steer",
                text: `A Concierge update is waiting for this run while your background job “${task.description}” has been running for ${Math.floor(age / 60_000)} minutes. Do you still intend to keep it running? If not, stop it now. No reply is owed.` });
              notices.add(id);
            } catch { /* The exact run may have ended before pinned admission. */ }
          }
        }
      }
      if (!updateWaiting || !releases.has(turnId) || now - wait.lastAssistantOutputAt < 15 * 60_000) continue;
      const abandoned = wait.tasks.find(task => {
        const sent = noticeSentAt.get(`background-job:${nativeRunId(turnId)}:${task.id}:60`);
        return now - task.startedAt >= 60 * 60_000 && sent !== undefined
          && now - Math.max(sent, wait.lastAssistantOutputAt) >= 15 * 60_000;
      });
      if (!abandoned) continue;
      if (!releases.get(turnId)?.()) continue;
      releaseDetails.set(turnId, `your background job '${abandoned.description}' was ended so an update could install`);
      log("warn", "background_job_released_for_update", { turn_id: turnId, task_id: abandoned.id,
        age_ms: now - abandoned.startedAt });
      releases.delete(turnId);
    }
  };
  const timer = setInterval(tick, 10_000);
  tick();
  return () => clearInterval(timer);
}
