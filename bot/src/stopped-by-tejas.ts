import { db } from './state';
import { nativeRunId } from './session-inputs';
import { noticeTime } from './provider-free-notice';

/**
 * Whether Tejas stopped this exact run himself. His Stop is retained as a human `stop` operation
 * naming the run it stopped (SessionOwner.stop), so the record already says who stopped it; a
 * crash, restart, usage limit or outside interruption leaves no such operation. On 2026-10-08 the
 * request a run he stopped was serving came back as a bare "ended with cancelled", the Inbox read
 * it as news, and he was notified about an agent he had just stopped himself.
 */
export function stoppedByTejas(turnId: number): { inputId: string; atMs: number } | null {
  const row = db.query(`SELECT id, created_at FROM session_inputs WHERE kind='stop' AND origin='human'
    AND json_extract(payload_json,'$.runId')=? ORDER BY created_at LIMIT 1`).get(nativeRunId(turnId)) as { id: string; created_at: string } | null;
  return row ? { inputId: row.id, atMs: Date.parse(`${row.created_at.replace(' ', 'T')}Z`) } : null;
}

/** The settled words for a request whose run he stopped: the asker must not report it back to him. */
export function stoppedByTejasText(atMs: number, where = ''): string {
  return `Tejas stopped this run himself with Stop${where} at ${noticeTime(db, atMs)}. It was his choice, not a failure: do not report it back to him or notify him about it. The request is closed; ask again only if he asks for the work again.`;
}

/** The words for a run that was cancelled without his Stop: someone has to follow it up. */
export function cancelledWithoutHisStopText(where = ''): string {
  return `The recipient execution${where} was cancelled without Tejas pressing Stop (a restart, a crash, an outside interruption or another session's cancel). The work did not finish; follow it up.`;
}
