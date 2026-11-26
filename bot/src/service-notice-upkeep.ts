import { db } from "./state";
import { log } from "./log";
import { fileServiceNotices, settleServiceNotice } from "./session-topics";
import { markServiceNoticeResolutionSettled, pendingServiceNoticeResolutions } from "./service-notice-resolutions";

/**
 * Notices and resolutions written by host scripts (bun run …/service-notice.js) land in the
 * ledger from another process, so nothing in the owner learns of them. Before this pass a notice
 * was filed into its thread only at the next owner restart, and a question he had to act on could
 * sit unfiled for days. Each minute the owner files any unfiled service notice and settles any
 * recorded resolution. A minute matches the repair-notice pass and the "within a minute"
 * promise to callers; an in-process publisher still files immediately itself.
 */
export function serviceNoticeUpkeepPass(): { filed: number; settled: number } {
  const { filed } = fileServiceNotices();
  let settled = 0;
  for (const resolution of pendingServiceNoticeResolutions(db)) {
    const inputId = `service:service-notice:${resolution.key}`;
    try {
      if (settleServiceNotice({ inputId, text: resolution.text })) settled++;
    } catch (error) {
      // One bad row must not hold every later resolution; it stays pending and is retried.
      if (!failuresLogged.has(resolution.key)) log("error", "service_notice_resolution_failed", { key: resolution.key, error: String(error) });
      failuresLogged.add(resolution.key);
      continue;
    }
    // Done only once its resolution is in the thread; with no Inbox yet it stays pending.
    if (db.query("SELECT 1 FROM session_owner_events WHERE event_id=?").get(`post:service-resolved:${inputId}`))
      markServiceNoticeResolutionSettled(db, resolution.key);
  }
  return { filed, settled };
}
const failuresLogged = new Set<string>();

export function startServiceNoticeUpkeep(log: (level: "info" | "error", event: string, fields: Record<string, unknown>) => void): () => void {
  const pass = () => {
    try {
      const result = serviceNoticeUpkeepPass();
      if (result.filed || result.settled) log("info", "service_notice_upkeep", result);
    } catch (error) {
      log("error", "service_notice_upkeep_failed", { error: String(error) });
    }
  };
  const timer = setInterval(pass, 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
