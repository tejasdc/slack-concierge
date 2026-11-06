import type { Database } from 'bun:sqlite';

/** The last host that actually started this native provider conversation. */
export function lastLaunchedConversationHome(db:Database,sessionId:number,provider:string):
    {supervisor:string;runner:string|null}|null {
  return db.query(`SELECT execution.supervisor,attempt.runner FROM executions execution
    LEFT JOIN runner_attempts attempt ON attempt.job_id='turn:'||execution.execution_id
    WHERE execution.session_id=? AND execution.provider=? AND execution.unit IS NOT NULL
    ORDER BY execution.created_at_ms DESC,attempt.started_at_ms DESC LIMIT 1`)
    .get(sessionId,provider) as {supervisor:string;runner:string|null}|null;
}
