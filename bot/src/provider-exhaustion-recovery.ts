import {db,executionChanged,getSessionById} from './state';
import {createNativeSession,enqueueSessionInput,getAcceptedSessionInput,recordSessionEvent,retainSessionInput,sessionMetadata,updateSessionMetadata,type AcceptedSessionInput} from './session-inputs';
import {newWorkCapacity} from './provider-start-choice';
import {sessionAddress} from './session-address';
import {log} from './log';

type WaitingTurn={id:number;session_id:number;accepted_input_id:string;status:string;dispatch_attempt:number;
  dispatch_hold:string|null;provider_admission_intended_at:string|null;provider_started_at:string|null;
  provider_turn_id:string|null;provider_input_acknowledged_at:string|null;saved_kind:string|null};

let reconciling=false;
let scanAfterTurnId=0;

function waitingTurns(sessionId:number):WaitingTurn[] {
  return db.query(`SELECT id,session_id,accepted_input_id,status,dispatch_attempt,dispatch_hold,
    provider_admission_intended_at,provider_started_at,provider_turn_id,
    provider_input_acknowledged_at,saved_kind FROM turns WHERE session_id=? AND status='queued'
    ORDER BY queue_priority DESC,id LIMIT 52`).all(sessionId) as WaitingTurn[];
}

function safeTurn(turn:WaitingTurn,input:AcceptedSessionInput):boolean {
  if(turn.status!=='queued'||turn.saved_kind!==null||input.turn_id!==turn.id||input.session_id!==turn.session_id
    ||!['input','create'].includes(input.kind)||input.steering_id!==null
    ||turn.provider_input_acknowledged_at!==null)return false;
  const receipt=input.receipt_json?JSON.parse(input.receipt_json):{};
  if(Object.keys(receipt).some(key=>key!=='admission')
    ||(receipt.admission&&(receipt.admission.provider!=='claude-code'||receipt.admission.inputId!==input.id)))return false;
  // A usage hold is written only after the provider's refusal was classified replay safe.
  // Admission intent alone is not proof of execution; a fresh untouched queued turn has none.
  if(turn.dispatch_attempt>0&&turn.dispatch_hold!=='usage')return false;
  if(turn.dispatch_attempt===0&&(turn.provider_admission_intended_at!==null
    ||turn.provider_started_at!==null||turn.provider_turn_id!==null))return false;
  const payload=JSON.parse(input.payload_json);
  if(input.kind==='create'&&(!payload.firstInput||typeof payload.firstInput.text!=='string'))return false;
  if(payload.continuation)return false; // A prior turn may already have made effects.
  return !db.query(`SELECT 1 FROM turn_dependencies WHERE turn_id=? AND satisfied_at IS NULL
      UNION ALL SELECT 1 FROM turn_steering_messages WHERE turn_id=?
      UNION ALL SELECT 1 FROM turn_artifact_deliveries WHERE turn_id=?
      UNION ALL SELECT 1 FROM turn_artifact_batches WHERE turn_id=? AND status<>'collecting'
      UNION ALL SELECT 1 FROM session_peer_deliveries WHERE target_input_id=?
      UNION ALL SELECT 1 FROM turn_dependencies WHERE prerequisite_turn_id=? AND satisfied_at IS NULL LIMIT 1`)
    .get(turn.id,turn.id,turn.id,turn.id,input.id,turn.id);
}

function contextPrompt(sourceAddress:string,sourceInputId:string,original:string):string {
  return `The session owner transferred accepted work from a Claude conversation after all usable Claude accounts ran out. `+
    `The original input was not executed there; its exact accepted identity is ${sourceInputId}. `+
    `This is an independent Codex conversation. Before acting, read the original conversation at ${sourceAddress} `+
    `with router-actions.sh sessions context, following the available pages needed to understand prior work and effects. `+
    `The owner's retained history is the transferable context; provider-private state is not reproduced. `+
    `Do not repeat effects already recorded in that conversation. The exact original accepted message follows:\n\n${original}`;
}

function transferSession(sessionId:number):number {
  const source=getSessionById(sessionId);
  if(!source||source.provider_id!=='claude-code'||source.status==='archived')return 0;
  const meta=sessionMetadata(source);
  if(meta.inbox||meta.suspended||meta.repairAgent||meta.interactionPolicy==='consultation-only')return 0;
  const turns=waitingTurns(sessionId);
  if(!turns.length||turns.length>50||turns[0]!.dispatch_hold!=='usage')return 0;
  const inputs=turns.map(turn=>getAcceptedSessionInput(turn.accepted_input_id));
  if(inputs.some((input,index)=>!input||!safeTurn(turns[index]!,input)))return 0;
  const turnIds=turns.map(turn=>turn.id);
  const placeholders=turnIds.map(()=>'?').join(',');
  // An earlier unresolved obligation or an outbound helper can make the new message depend on
  // work whose effects are not reconciled. Keep that session in its original, visible hold.
  if(db.query(`SELECT 1 FROM turns WHERE session_id=? AND status IN ('running','delivering','parked','interrupted','delivery_parked') LIMIT 1`).get(sessionId))return 0;
  if(db.query(`SELECT 1 FROM session_communication_requests request
    LEFT JOIN session_inputs input ON input.id=request.target_input_id
    WHERE request.target_session_id=? AND request.outcome IS NULL
      AND (input.turn_id IS NULL OR input.turn_id NOT IN (${placeholders})) LIMIT 1`)
    .get(sessionId,...turnIds))return 0;
  if(db.query(`SELECT 1 FROM session_communication_requests WHERE source_session_id=? AND outcome IS NULL LIMIT 1`).get(sessionId))return 0;
  if(db.query(`SELECT 1 FROM session_external_requests request
    LEFT JOIN session_inputs input ON input.id=request.target_input_id
    WHERE request.target_session_id=? AND request.outcome IS NULL
      AND (input.turn_id IS NULL OR input.turn_id NOT IN (${placeholders})) LIMIT 1`)
    .get(sessionId,...turnIds))return 0;
  const sourceAddress=sessionAddress(source);
  const previous=db.query(`SELECT generation,successor_session_id FROM provider_recovery_sessions
    WHERE source_session_id=? ORDER BY generation DESC LIMIT 1`).get(sessionId) as
    {generation:number;successor_session_id:number}|null;
  const current=previous?getSessionById(previous.successor_session_id):null;
  let successor=current&&current.status!=='archived'&&!sessionMetadata(current).suspended?current:null;
  if(!successor){
    successor=createNativeSession('codex',{title:`${meta.title??'Claude work'} (continued on Codex)`,
      purpose:meta.purpose??'develop',cwd:meta.cwd,project:meta.project??null,
      additionalDirs:meta.additionalDirs,origin:'native',recovery:{sourceAddress,reason:'claude_usage_exhausted'}});
    db.query('UPDATE sessions SET parent_session_id=?,parent_message_idx=? WHERE id=?')
      .run(source.id,turns[0]!.id,successor.id);
    db.query(`INSERT INTO provider_recovery_sessions(source_session_id,generation,successor_session_id)
      VALUES(?,?,?)`).run(sessionId,(previous?.generation??0)+1,successor.id);
  }
  let transferred=0;
  for(let index=0;index<turns.length;index++){
    const turn=turns[index]!,input=inputs[index]!;
    if(db.query('SELECT 1 FROM provider_recovery_inputs WHERE source_input_id=?').get(input.id))continue;
    const retained=JSON.parse(input.payload_json);
    const original=input.kind==='create'?retained.firstInput:retained;
    const accepted=retainSessionInput({id:`recovery:${input.id}`,sessionId:successor.id,
      scope:`provider-recovery:${source.id}`,actionId:input.id,kind:'input',origin:input.origin,
      payload:{...original,preparedPrompt:contextPrompt(sourceAddress,input.id,original.preparedPrompt??original.text)},
      ...(input.source_input_id?{sourceInputId:input.source_input_id}:{}),
      ...(input.source_run_id?{sourceRunId:input.source_run_id}:{}),
      ...(input.request_id?{requestId:input.request_id}:{})}).input;
    const queued=enqueueSessionInput(accepted.id);
    if(!queued.turn_id)throw new Error('Provider recovery successor was not queued.');
    db.query(`INSERT INTO provider_recovery_inputs(source_input_id,source_turn_id,source_session_id,
      successor_input_id,successor_turn_id,successor_session_id,reason) VALUES(?,?,?,?,?,?,'claude_usage_exhausted')`)
      .run(input.id,turn.id,source.id,accepted.id,queued.turn_id,successor.id);
    db.query(`UPDATE session_communication_requests SET target_session_id=?,target_input_id=?,target_turn_id=?,
      payload_json=json_set(payload_json,'$.address',?,'$.recoverySourceAddress',?)
      WHERE target_session_id=? AND target_input_id=? AND outcome IS NULL`)
      .run(successor.id,accepted.id,queued.turn_id,sessionAddress(successor),sourceAddress,source.id,input.id);
    db.query(`UPDATE session_external_requests SET target_session_id=?,target_input_id=?
      WHERE target_session_id=? AND target_input_id=? AND outcome IS NULL`)
      .run(successor.id,accepted.id,source.id,input.id);
    db.query(`UPDATE turns SET status='cancelled',ended_at=CURRENT_TIMESTAMP,
      agent_text='Continued in a Codex session after Claude usage ran out.',owner_instance_id=NULL
      WHERE id=? AND session_id=? AND status='queued'`).run(turn.id,source.id);
    if((db.query('SELECT changes() AS count').get() as {count:number}).count!==1)
      throw new Error('Provider recovery lost the source turn.');
    db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(JSON.stringify({state:'canceled',movedTo:`concierge:${successor.id}`,continuedAs:accepted.id}),input.id);
    recordSessionEvent({eventId:`provider-recovery:${input.id}`,sessionId:source.id,inputId:input.id,
      turnId:turn.id,kind:'provider_recovery',payload:{successorSessionId:`concierge:${successor.id}`,
        successorAddress:sessionAddress(successor),successorInputId:accepted.id,reason:'claude_usage_exhausted'}});
    transferred++;
  }
  if(transferred) {
    updateSessionMetadata(source.id,{generation:(sessionMetadata(getSessionById(source.id)!).generation??0)+1});
    log('warn','provider_recovery_transferred',{source_session_id:source.id,successor_session_id:successor.id,inputs:transferred});
  }
  return transferred;
}

/** Runs on the owner after a confirmed usage hold, on fresh readings and after restart.
 * The same SQLite writer serializes this transaction with the FIFO claim. */
export function recoverExhaustedClaudeWork():number {
  if(reconciling)return 0;
  const claude=newWorkCapacity('claude-code');
  const codex=newWorkCapacity('codex');
  if(!claude||claude.used<100||!codex||codex.used>=100){scanAfterTurnId=0;return 0;}
  reconciling=true;
  try {
    let moved=0;
    const sessions=db.query(`SELECT turn.session_id AS id,MIN(turn.id) AS oldest_turn_id FROM turns turn
      JOIN sessions session ON session.id=turn.session_id
      WHERE session.provider_id='claude-code' AND turn.status='queued' AND turn.dispatch_hold='usage'
        AND turn.id>?
      GROUP BY turn.session_id ORDER BY oldest_turn_id LIMIT 20`).all(scanAfterTurnId) as
      {id:number;oldest_turn_id:number}[];
    for(const session of sessions){
      try{moved+=db.transaction(()=>transferSession(session.id)).immediate();}
      catch(error){log('error','provider_recovery_failed',{source_session_id:session.id,
        error:error instanceof Error?error.message:String(error)});}
    }
    if(sessions.length===20){
      scanAfterTurnId=sessions[sessions.length-1]!.oldest_turn_id;
      setImmediate(recoverExhaustedClaudeWork);
    } else scanAfterTurnId=0;
    if(moved)executionChanged();
    return moved;
  } finally {reconciling=false;}
}
