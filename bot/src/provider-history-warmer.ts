import {db,getChannel,type SessionRow} from './state';
import {sessionMetadata} from './session-inputs';
import {prepareClaudeHistory} from './provider-history';
import {log} from './log';

const SWEEP_MS=60_000;

/**
 * Keeps every Claude conversation's history snapshot matching its transcript, so opening one
 * reads a prepared page instead of waiting for an import (2026-10-13: most conversations had
 * no snapshot and opened blank until one finished). Each pass prepares conversations whose
 * latest finished turn this process has not prepared yet, one at a time, through the same
 * import and verification children reads use; the first pass after a start covers the backlog.
 * A conversation with a turn under way waits: its transcript is still growing.
 */
export function startProviderHistoryWarmer(defaultCwd:string):()=>void {
  const prepared=new Map<number,number>();
  let stopped=false,timer:ReturnType<typeof setTimeout>|null=null;
  const cwd=(session:SessionRow)=>{
    const channel=session.slack_channel_id?getChannel(session.slack_channel_id):null;
    return sessionMetadata(session).cwd??channel?.code_path??channel?.vault_path??defaultCwd;
  };
  const pass=async()=>{
    const due=(db.query(`SELECT s.*,MAX(t.id) AS latest_turn_id FROM sessions s JOIN turns t ON t.session_id=s.id
      WHERE s.provider_id='claude-code' AND s.agent_session_uuid IS NOT NULL
      GROUP BY s.id HAVING SUM(t.status IN ('queued','running','delivering'))=0
      ORDER BY latest_turn_id DESC`).all() as (SessionRow&{latest_turn_id:number})[])
      .filter(session=>prepared.get(session.id)!==session.latest_turn_id);
    if(!due.length)return;
    const started=performance.now(),outcomes:Record<string,number>={};
    for(const session of due){
      if(stopped)return;
      const outcome=await prepareClaudeHistory(session.agent_session_uuid!,cwd(session),session.id)
        .catch(()=>'unprepared' as const);
      outcomes[outcome]=(outcomes[outcome]??0)+1;
      // An unprepared conversation is tried again after its next turn or restart, not every pass.
      prepared.set(session.id,session.latest_turn_id);
    }
    log('info','provider_history_warmed',{conversations:due.length,...outcomes,duration_ms:Math.round(performance.now()-started)});
  };
  const schedule=(delay:number)=>{
    if(stopped)return;
    timer=setTimeout(()=>{void pass().catch(error=>log('warn','provider_history_warm_failed',
      {reason:error instanceof Error?error.message:'unknown'})).finally(()=>schedule(SWEEP_MS));},delay);
    timer.unref?.();
  };
  schedule(30_000);
  return ()=>{stopped=true;if(timer)clearTimeout(timer);};
}
