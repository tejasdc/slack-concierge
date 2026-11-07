import type {Database} from 'bun:sqlite';

/** Find the last machine that actually received this conversation's input. Launch intents are not custody. */
export function acknowledgedProviderRunner(db:Database,session:{id:number;provider_id:string}):{status:'found';runner:string|null}|{status:'missing'} {
  const row=db.query(`SELECT execution.supervisor,attempt.runner FROM executions execution
    JOIN turns turn ON turn.id=execution.turn_id
    LEFT JOIN runner_attempts attempt ON attempt.job_id='turn:'||execution.execution_id
    WHERE execution.session_id=? AND execution.provider=?
      AND turn.provider_input_acknowledged_at IS NOT NULL
      AND (execution.state<>'intended' OR attempt.runner IS NOT NULL)
    ORDER BY execution.created_at_ms DESC,attempt.started_at_ms DESC LIMIT 1`).get(session.id,session.provider_id) as
    {supervisor:string;runner:string|null}|null;
  if(!row)return {status:'missing'};
  if(row.supervisor==='runner'){
    if(!row.runner)throw new Error(`This ${session.provider_id} conversation ran on a runner, but its exact runner lease is unavailable.`);
    return {status:'found',runner:row.runner};
  }
  return {status:'found',runner:null};
}
