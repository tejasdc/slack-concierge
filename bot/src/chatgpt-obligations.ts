import {db,getSessionById} from './state';
import {getAcceptedSessionInput,humanAuthored} from './session-inputs';
import {sessionAddress} from './session-address';

export type ChatGptTaskKind='local_request'|'peer_delivery'|'external_request'|'direct_input';
export type ChatGptTask={kind:ChatGptTaskKind;id:string};
export type ChatGptObligationState='awaiting_answer'|'reconcile_receipt'|'return_pending'|'resolution_pending'|'external_hold'|'resolved'|'withdrawn_by_tejas';

export type ChatGptObligationRow={
  obligation_id:string;task_kind:ChatGptTaskKind;task_id:string;asker_session_id:number;
  question_text:string;target_session_id:string;state:ChatGptObligationState;
  active_request_id:string;answer_event_id:string|null;answer_return_input_id:string|null;
  resolution_json:string|null;next_action:string;generation:number;due_at_ms:number|null;
  created_at_ms:number;updated_at_ms:number;
};
type ObligationRow=ChatGptObligationRow;

const OPEN="state NOT IN ('resolved','withdrawn_by_tejas')";
const TASK_KINDS:ChatGptTaskKind[]=['local_request','peer_delivery','external_request','direct_input'];
const DIRECT_TURN_KINDS=new Set(['input','create','consultation','comparison']);

export function parseChatGptTask(value:string):ChatGptTask {
  const split=value.indexOf(':');
  const kind=value.slice(0,split) as ChatGptTaskKind,id=value.slice(split+1);
  if(split<1||!TASK_KINDS.includes(kind)||!id||kind==='peer_delivery'&&!/^[^:]+:[^:]+$/.test(id))
    throw new Error('A ChatGPT ask needs --for-task local_request:<request>, peer_delivery:<origin-peer>:<request>, external_request:<request>, or direct_input:<input>.');
  return {kind,id};
}

/** Resolve only custody recorded by this owner. An originating human ID is never a substitute
 * for an exact child request: one human input may have started several independent tasks. */
export function chatGptTaskHeldBy(sessionId:number,task:ChatGptTask):boolean {
  if(task.kind==='local_request')return !!db.query(`SELECT 1 FROM session_communication_requests
    WHERE request_id=? AND target_session_id=? AND outcome IS NULL AND target_input_id IS NOT NULL`).get(task.id,sessionId);
  if(task.kind==='peer_delivery'){
    const split=task.id.indexOf(':');
    if(split<1)return false;
    return !!db.query(`SELECT 1 FROM session_peer_deliveries
      WHERE peer=? AND request_id=? AND target_session_id=? AND closed_at_ms IS NULL`).get(task.id.slice(0,split),task.id.slice(split+1),sessionId);
  }
  if(task.kind==='external_request')return !!db.query(`SELECT 1 FROM session_external_requests
    WHERE request_id=? AND target_session_id=? AND outcome IS NULL`).get(task.id,sessionId);
  const input=getAcceptedSessionInput(task.id);
  if(!input||input.session_id!==sessionId||input.origin!=='human'||!DIRECT_TURN_KINDS.has(input.kind))return false;
  // Once this input owns an answer, a later turn's outcome cannot erase that duty.
  if(openChatGptObligations(task).length)return true;
  return !db.query(`SELECT 1 FROM session_owner_events WHERE session_id=? AND kind='turn_outcome'
    AND (input_id=? OR json_extract(payload_json,'$.inputId')=?)
    AND json_extract(payload_json,'$.outcome') IN ('done','response','failed','withdrawn') LIMIT 1`)
      .get(sessionId,task.id,task.id);
}

/** Bind a later source input only when its agent selected this exact direct task. */
export function bindDirectChatGptTaskSource(task:ChatGptTask,sourceInputId:string,sessionId:number) {
  if(task.kind!=='direct_input')return;
  const source=getAcceptedSessionInput(sourceInputId),original=getAcceptedSessionInput(task.id);
  if(!source||!original||source.session_id!==sessionId||original.session_id!==sessionId)
    throw new Error('A direct task source needs two accepted inputs in the same asking session.');
  db.query('INSERT OR IGNORE INTO session_chatgpt_direct_task_inputs(task_input_id,source_input_id) VALUES(?,?)')
    .run(task.id,sourceInputId);
}

/** A declared terminal outcome cannot close an exact direct task with an open answer. */
export function requireDirectChatGptOutcomeReady(sessionId:number,inputId:string) {
  for(const task of directTaskInputs(sessionId,inputId))requireChatGptTaskResolved({kind:'direct_input',id:task});
}

function directTaskInputs(sessionId:number,inputId:string):string[] {
  const inputs=db.query(`SELECT task_input_id FROM session_chatgpt_direct_task_inputs WHERE source_input_id=?
    UNION SELECT ? AS task_input_id`).all(inputId,inputId) as {task_input_id:string}[];
  return inputs.flatMap(({task_input_id})=>{
    const original=getAcceptedSessionInput(task_input_id);
    return original?.session_id===sessionId&&humanAuthored(original)&&DIRECT_TURN_KINDS.has(original.kind)?[task_input_id]:[];
  });
}

export function hasOpenDirectChatGptOutcomeDuty(sessionId:number,inputId:string):boolean {
  return directTaskInputs(sessionId,inputId).some(id=>{
    try{requireChatGptTaskResolved({kind:'direct_input',id});return false;}
    catch{return true;}
  });
}

/** A run may carry more than one task after steering. In that case the caller has to choose;
 * request provenance or creation time cannot tell us which task needs this question. */
export function resolveChatGptTask(sessionId:number,inputId:string,selection?:string):ChatGptTask {
  if(selection){
    const task=parseChatGptTask(selection);
    if(!chatGptTaskHeldBy(sessionId,task))throw new Error('This session does not hold the selected open task.');
    return task;
  }
  const source=getAcceptedSessionInput(inputId);
  if(!source||source.session_id!==sessionId)throw new Error('The ChatGPT ask needs its exact accepted source input.');
  const candidates:ChatGptTask[]=[];
  if(source.request_id){
    for(const kind of ['local_request','peer_delivery','external_request'] as const){
      const delivery=kind==='peer_delivery'?db.query('SELECT peer FROM session_peer_deliveries WHERE request_id=? AND target_session_id=?')
        .get(source.request_id,sessionId) as {peer:string}|null:null;
      const task={kind,id:delivery?`${delivery.peer}:${source.request_id}`:source.request_id};
      if(chatGptTaskHeldBy(sessionId,task))candidates.push(task);
    }
  }
  // A later human steering input may continue an earlier work request or direct task. Even if
  // this is the only visible human input in this run, its task cannot be inferred safely.
  if(source.origin==='human')throw new Error('A ChatGPT ask from a human input needs --for-task with the exact task this question serves.');
  if(candidates.length!==1)throw new Error(`Choose the exact task with --for-task. Current input identifies ${candidates.length} open tasks${candidates.length?`: ${candidates.map(task=>`${task.kind}:${task.id}`).join(', ')}`:''}.`);
  return candidates[0]!;
}

export function openChatGptObligations(task:ChatGptTask):ObligationRow[] {
  return db.query(`SELECT * FROM session_chatgpt_obligations WHERE task_kind=? AND task_id=? AND ${OPEN} ORDER BY created_at_ms,obligation_id`)
    .all(task.kind,task.id) as ObligationRow[];
}

export function requireChatGptTaskResolved(task:ChatGptTask):void {
  requireChatGptTaskDisposition(task);
}

export function chatGptAnswerCommand(row:ObligationRow):string {
  if(row.answer_event_id)return `sessions answer ${row.obligation_id} --answer-event ${row.answer_event_id} --handling used <source-flags> --action-id <stable-id>`;
  if(row.state==='reconcile_receipt'&&row.active_request_id===row.obligation_id&&row.target_session_id.startsWith('concierge:')){
    const request=db.query('SELECT target_session_id,target_input_id,outcome FROM session_communication_requests WHERE request_id=?')
      .get(row.obligation_id) as {target_session_id:number;target_input_id:string|null;outcome:string|null}|null;
    const target=request?getSessionById(request.target_session_id):null;
    const input=request?.target_input_id?getAcceptedSessionInput(request.target_input_id):null;
    const turn=input?.turn_id?db.query('SELECT id,native_run_id,status,provider_input_acknowledged_at,provider_turn_id,outbound_text FROM turns WHERE id=?')
      .get(input.turn_id) as {id:number;native_run_id:string|null;status:string;provider_input_acknowledged_at:string|null;provider_turn_id:string|null;outbound_text:string|null}|null:null;
    if(request?.outcome==='failed'&&target?.provider_id==='chatgpt'&&row.target_session_id===`concierge:${target.id}`
      &&input?.session_id===target.id&&turn?.status==='error'&&turn.native_run_id
      &&turn.provider_input_acknowledged_at===null&&turn.provider_turn_id===null&&turn.outbound_text===null){
      const evidence=db.query(`SELECT payload_json FROM session_owner_events WHERE turn_id=? AND input_id=? AND kind='capability'
        AND json_extract(payload_json,'$.kind') IN ('start','reconcile')
        AND json_extract(payload_json,'$.receipt.result.error') LIKE 'CHATGPT_ATTACHMENT_REJECTED:%'
        ORDER BY sequence DESC LIMIT 1`)
        .all(turn.id,input.id) as {payload_json:string}[];
      const rejected=evidence.map(entry=>JSON.parse(entry.payload_json)).some(proof=>proof.run?.operationId===input.id
        &&proof.run?.inputId===input.id&&proof.run?.runId===turn.native_run_id
        &&proof.receipt?.runId===turn.native_run_id&&proof.receipt?.state==='failed'
        &&proof.receipt?.acknowledgedAt===null&&proof.receipt?.result?.turnId===null
        &&proof.receipt?.result?.text===''&&typeof proof.receipt?.result?.error==='string'
        &&proof.receipt.result.error.startsWith('CHATGPT_ATTACHMENT_REJECTED:'));
      if(rejected)return `The retained receipt for original run ${turn.native_run_id} records CHATGPT_ATTACHMENT_REJECTED before Send, with no acknowledgement or provider turn. Correct the file, preserve the exact question above, and run: sessions ask ${sessionAddress(target)} --for-task ${row.task_kind}:${row.task_id} --correction-of ${row.obligation_id} <source-flags> --action-id <stable-id> --summary "Correct the rejected ChatGPT attachment" --file <corrected-path> --text-file <file-containing-the-exact-original-question>. The owner rechecks the live receipt before admission.`;
    }
  }
  if(row.state==='reconcile_receipt'&&row.active_request_id===row.obligation_id&&row.target_session_id.includes('/')){
    const request=db.query('SELECT peer,remote_session_id,remote_address,outcome,remote_status_json,result_json FROM session_peer_requests WHERE request_id=?')
      .get(row.obligation_id) as {peer:string;remote_session_id:string|null;remote_address:string|null;outcome:string|null;remote_status_json:string|null;result_json:string|null}|null;
    const failure=[request?.remote_status_json,request?.result_json].filter(Boolean).join(' ');
    if(request?.outcome==='failed'&&request.remote_address&&request.remote_session_id
      &&row.target_session_id===`${request.peer}/${request.remote_session_id}`
      &&failure.includes('CHATGPT_ATTACHMENT_REJECTED:'))
      return `The peer status reports CHATGPT_ATTACHMENT_REJECTED for original request ${row.obligation_id}; only the ChatGPT server's retained receipt can prove no Send. Correct the file, preserve the exact question above, and run: sessions ask ${request.peer}/${request.remote_address} --for-task ${row.task_kind}:${row.task_id} --correction-of ${row.obligation_id} <source-flags> --action-id <stable-id> --summary "Correct the rejected ChatGPT attachment" --file <corrected-path> --text-file <file-containing-the-exact-original-question>. The server rechecks its original receipt before accepting this request.`;
  }
  return `Inspect original ChatGPT request ${row.obligation_id} and recover its exact answer without resending an ambiguous operation.`;
}

/** A failed/needs-decision report can be visible while the exact answer duty remains.
 * Completion requires every answer handled; a blocked report must cite every open ID. */
export function requireChatGptTaskDisposition(task:ChatGptTask,disposition?:'completed'|'failed'|'needs_decision',citedIds:string[]=[]):void {
  const open=openChatGptObligations(task);
  if(open.length){
    const names=new Set(citedIds);
    if((disposition==='failed'||disposition==='needs_decision')&&open.every(row=>names.has(row.obligation_id)))return;
    throw new Error(`This task still owes ${open.length} ChatGPT answer${open.length===1?'':'s'}: ${open.map(row=>`${row.obligation_id} (${row.state}: ${row.next_action}). ${chatGptAnswerCommand(row)}`).join('; ')}. To report a blocked or failed attempt while retaining this duty, cite every open ID with --open-chatgpt <id>.`);
  }
  const legacy=db.query(`SELECT request_id,reason FROM session_chatgpt_legacy_reconciliation legacy
    WHERE state='pending' AND EXISTS (SELECT 1 FROM json_each(legacy.candidate_tasks_json) candidate
      WHERE json_extract(candidate.value,'$.kind')=? AND json_extract(candidate.value,'$.id')=?) LIMIT 1`)
    .get(task.kind,task.id) as {request_id:string;reason:string}|null;
  if(legacy)throw new Error(`This task has an unclassified historical ChatGPT question ${legacy.request_id}: ${legacy.reason}. Its original attempt must be reconciled and linked by exact custody before the task can close.`);
}

/** Only a retained human action naming the exact task withdraws its unanswered questions. */
export function withdrawChatGptTaskByTejas(input:{task:ChatGptTask;humanInputId:string;actionId:string;reason:string;now:number}) {
  const human=getAcceptedSessionInput(input.humanInputId);
  if(!human||!humanAuthored(human)||!input.reason.trim())throw new Error('Answer withdrawal requires Tejas’s exact accepted action and reason.');
  const open=openChatGptObligations(input.task);
  for(const row of open){
    transition({obligationId:row.obligation_id,actionId:`tejas-withdraw:${input.humanInputId}:${input.actionId}`,
      state:'withdrawn_by_tejas',nextAction:'none',now:input.now,
      evidence:{task:input.task,humanInputId:input.humanInputId,actionId:input.actionId,reason:input.reason}});
  }
  return open.length;
}

/** A confirmed human Stop withdraws only duties held by inputs in that exact run.
 * The human control input is proof of authority; it is not a task identity. */
export function withdrawChatGptTasksForStoppedTurnByTejas(input:{turnId:number;humanInputId:string;actionId:string;now:number}):number {
  const human=getAcceptedSessionInput(input.humanInputId);
  const turn=db.query('SELECT session_id FROM turns WHERE id=?').get(input.turnId) as {session_id:number}|null;
  if(!human||!humanAuthored(human)||human.kind!=='stop'||!turn||human.session_id!==turn.session_id)
    throw new Error('Answer withdrawal requires the accepted human Stop for this exact session.');
  const taskRows=db.query(`WITH run_inputs AS (
      SELECT accepted_input_id AS id FROM turns WHERE id=? AND accepted_input_id IS NOT NULL
      UNION SELECT accepted_input_id AS id FROM turn_steering_messages WHERE turn_id=?
    ), owned AS (
      SELECT 'direct_input' AS kind,task_input_id AS id FROM session_chatgpt_direct_task_inputs
        WHERE source_input_id IN (SELECT id FROM run_inputs)
      UNION SELECT 'direct_input',id FROM run_inputs
      UNION SELECT 'local_request',request_id FROM session_communication_requests
        WHERE target_input_id IN (SELECT id FROM run_inputs)
      UNION SELECT 'peer_delivery',peer||':'||request_id FROM session_peer_deliveries
        WHERE target_input_id IN (SELECT id FROM run_inputs)
      UNION SELECT 'external_request',request_id FROM session_external_requests
        WHERE target_input_id IN (SELECT id FROM run_inputs)
    ) SELECT kind,id FROM owned`).all(input.turnId,input.turnId) as ChatGptTask[];
  let count=0;
  for(const task of taskRows)count+=withdrawChatGptTaskByTejas({task,humanInputId:input.humanInputId,
    actionId:input.actionId,reason:`Tejas confirmed Stop of exact turn ${input.turnId}`,now:input.now});
  return count;
}

/** Conservatively classify old asks serving still-open exact tasks. No row here sends a
 * provider input. Ambiguous membership or recipient identity stays pending for inspection. */
export function migrateOpenLegacyChatGptAsks(now:number) {
  const summary={scanned:0,linked:0,pending:0,excludedKnownNonChatGpt:0};
  const asks=db.query(`SELECT 'local' AS source_kind,ask.request_id,ask.source_input_id,ask.source_session_id AS asker_session_id,
      ask.target_session_id,ask.payload_json,ask.outcome,ask.result_json,ask.created_at_ms,NULL AS peer,NULL AS remote_session_id
      FROM session_communication_requests ask JOIN sessions target ON target.id=ask.target_session_id
      WHERE ask.source_input_id IS NOT NULL AND target.provider_id='chatgpt'
        AND (EXISTS (SELECT 1 FROM session_communication_requests parent WHERE parent.target_input_id=ask.source_input_id AND parent.outcome IS NULL)
          OR EXISTS (SELECT 1 FROM session_peer_deliveries parent WHERE parent.target_input_id=ask.source_input_id AND parent.closed_at_ms IS NULL)
          OR EXISTS (SELECT 1 FROM session_external_requests parent WHERE parent.target_input_id=ask.source_input_id AND parent.outcome IS NULL)
          OR EXISTS (SELECT 1 FROM session_inputs i WHERE i.id=ask.source_input_id AND i.origin='human'))
    UNION ALL
    SELECT 'peer' AS source_kind,ask.request_id,ask.source_input_id,ask.source_session_id AS asker_session_id,
      NULL AS target_session_id,ask.payload_json,ask.outcome,ask.result_json,ask.created_at_ms,ask.peer,ask.remote_session_id
      FROM session_peer_requests ask WHERE ask.source_input_id IS NOT NULL
        AND (json_extract(ask.payload_json,'$.provider')='chatgpt' OR json_extract(ask.payload_json,'$.address') IS NOT NULL)
        AND (EXISTS (SELECT 1 FROM session_communication_requests parent WHERE parent.target_input_id=ask.source_input_id AND parent.outcome IS NULL)
          OR EXISTS (SELECT 1 FROM session_peer_deliveries parent WHERE parent.target_input_id=ask.source_input_id AND parent.closed_at_ms IS NULL)
          OR EXISTS (SELECT 1 FROM session_external_requests parent WHERE parent.target_input_id=ask.source_input_id AND parent.outcome IS NULL)
          OR EXISTS (SELECT 1 FROM session_inputs i WHERE i.id=ask.source_input_id AND i.origin='human'))`) .all() as Array<{
    source_kind:'local'|'peer';request_id:string;source_input_id:string;asker_session_id:number;target_session_id:number|null;
    payload_json:string;outcome:string|null;result_json:string|null;created_at_ms:number;peer:string|null;remote_session_id:string|null}>;
  for(const ask of asks)db.transaction(()=>{
    summary.scanned++;
    if(db.query('SELECT 1 FROM session_chatgpt_obligations WHERE obligation_id=?').get(ask.request_id))return;
    const prior=db.query('SELECT 1 FROM session_chatgpt_legacy_reconciliation WHERE source_kind=? AND request_id=?')
      .get(ask.source_kind,ask.request_id);
    if(prior)return;
    const payload=JSON.parse(ask.payload_json);
    if(ask.source_kind==='peer'&&payload.address&&ask.remote_session_id){
      const view=db.query('SELECT view_json FROM session_peer_catalogue WHERE peer=? AND remote_session_id=?')
        .get(ask.peer,ask.remote_session_id) as {view_json:string}|null;
      const exactProvider=view?JSON.parse(view.view_json).provider:null;
      if(typeof exactProvider==='string'&&exactProvider!=='chatgpt'){
        summary.excludedKnownNonChatGpt++;
        return;
      }
    }
    const candidates:ChatGptTask[]=[];
    for(const parent of db.query(`SELECT request_id FROM session_communication_requests WHERE target_input_id=? AND target_session_id=? AND outcome IS NULL`)
      .all(ask.source_input_id,ask.asker_session_id) as {request_id:string}[])candidates.push({kind:'local_request',id:parent.request_id});
    for(const parent of db.query(`SELECT peer,request_id FROM session_peer_deliveries WHERE target_input_id=? AND target_session_id=? AND closed_at_ms IS NULL`)
      .all(ask.source_input_id,ask.asker_session_id) as {peer:string;request_id:string}[])candidates.push({kind:'peer_delivery',id:`${parent.peer}:${parent.request_id}`});
    for(const parent of db.query(`SELECT request_id FROM session_external_requests WHERE target_input_id=? AND target_session_id=? AND outcome IS NULL`)
      .all(ask.source_input_id,ask.asker_session_id) as {request_id:string}[])candidates.push({kind:'external_request',id:parent.request_id});
    const exactCandidateCount=candidates.length;
    const source=getAcceptedSessionInput(ask.source_input_id);
    if(source?.origin==='human'&&DIRECT_TURN_KINDS.has(source.kind)&&source.session_id===ask.asker_session_id){
      candidates.push({kind:'direct_input',id:source.id});
      // A later human steering input can continue any open work request in this recipient
      // session. These are ambiguity holds, not inferred links to the question.
      for(const parent of db.query('SELECT request_id FROM session_communication_requests WHERE target_session_id=? AND outcome IS NULL')
        .all(ask.asker_session_id) as {request_id:string}[])candidates.push({kind:'local_request',id:parent.request_id});
      for(const parent of db.query('SELECT peer,request_id FROM session_peer_deliveries WHERE target_session_id=? AND closed_at_ms IS NULL')
        .all(ask.asker_session_id) as {peer:string;request_id:string}[])candidates.push({kind:'peer_delivery',id:`${parent.peer}:${parent.request_id}`});
      for(const parent of db.query('SELECT request_id FROM session_external_requests WHERE target_session_id=? AND outcome IS NULL')
        .all(ask.asker_session_id) as {request_id:string}[])candidates.push({kind:'external_request',id:parent.request_id});
    }
    if(!candidates.length){
      for(const parent of db.query('SELECT request_id FROM session_communication_requests WHERE target_session_id=? AND outcome IS NULL')
        .all(ask.asker_session_id) as {request_id:string}[])candidates.push({kind:'local_request',id:parent.request_id});
      for(const parent of db.query('SELECT peer,request_id FROM session_peer_deliveries WHERE target_session_id=? AND closed_at_ms IS NULL')
        .all(ask.asker_session_id) as {peer:string;request_id:string}[])candidates.push({kind:'peer_delivery',id:`${parent.peer}:${parent.request_id}`});
      for(const parent of db.query('SELECT request_id FROM session_external_requests WHERE target_session_id=? AND outcome IS NULL')
        .all(ask.asker_session_id) as {request_id:string}[])candidates.push({kind:'external_request',id:parent.request_id});
    }
    const distinct=Array.from(new Map(candidates.map(task=>[`${task.kind}:${task.id}`,task])).values());
    // A catalogue view may have changed since the old send. Only immutable ask payload
    // provider selection can justify automatic historical binding.
    const providerKnown=ask.source_kind==='local'||payload.provider==='chatgpt';
    const target=ask.source_kind==='local'?`concierge:${ask.target_session_id}`
      :ask.remote_session_id?`${ask.peer}/${ask.remote_session_id}`:`${ask.peer}/request:${ask.request_id}`;
    const autoLink=exactCandidateCount===1&&distinct.length===1&&source?.origin!=='human'&&providerKnown;
    const reason=distinct.length!==1?'Exact accepted source input has multiple or no open task candidates.'
      :distinct[0]?.kind==='direct_input'?'A historical direct task needs explicit owner-recorded selection.'
      :!providerKnown?'Addressed peer provider identity is not confirmed as ChatGPT.'
      :!autoLink?'The historical source does not prove the task by exact delivery custody.':'Exact custody established.';
    db.query(`INSERT INTO session_chatgpt_legacy_reconciliation(source_kind,request_id,source_input_id,candidate_tasks_json,state,reason,created_at_ms)
      VALUES(?,?,?,?,?,?,?)`).run(ask.source_kind,ask.request_id,ask.source_input_id,JSON.stringify(distinct),
        autoLink?'linked':'pending',reason,now);
    if(!autoLink){summary.pending++;return;}
    summary.linked++;
    const task=distinct[0]!;
    admitChatGptObligation({requestId:ask.request_id,task,askerSessionId:ask.asker_session_id,
      question:String(payload.text??payload.message??''),targetSessionId:target,now:ask.created_at_ms});
    bindDirectChatGptTaskSource(task,ask.source_input_id,ask.asker_session_id);
    if(ask.outcome){
      const result=ask.result_json?JSON.parse(ask.result_json):{};
      recordChatGptAttemptResult({requestId:ask.request_id,outcome:ask.outcome,
        answerEventId:typeof result.event_id==='string'?result.event_id:undefined,now,reason:'Historical attempt; explicit answer handling remains required.'});
      if((ask.outcome==='answered'||ask.outcome==='undetermined')&&typeof result.event_id==='string'){
        const event=ask.source_kind==='local'
          ?db.query('SELECT accepted_input_id,status FROM session_communication_events WHERE event_id=?').get(result.event_id) as {accepted_input_id:string|null;status:string}|null
          :db.query('SELECT accepted_input_id,status FROM session_peer_events WHERE event_id=?').get(result.event_id) as {accepted_input_id:string|null;status:string}|null;
        if(event?.status==='received'&&event.accepted_input_id)
          recordChatGptReturnReceipt({eventId:result.event_id,returnInputId:event.accepted_input_id,now});
      }
    }
  })();
  return summary;
}

/** A bound agent classifies one pending historical ask using its retained IDs and inspected
 * recipient evidence. This never dispatches or creates a browser request. */
export function classifyLegacyChatGptAsk(input:{requestId:string;task:string;provider:'chatgpt'|'other';
  askerSessionId:number;reason:string;now:number}) {
  if(!input.reason.trim())throw new Error('Historical classification needs the inspected evidence and reason.');
  const task=parseChatGptTask(input.task);
  const legacy=db.query(`SELECT * FROM session_chatgpt_legacy_reconciliation WHERE request_id=? AND state='pending'`)
    .get(input.requestId) as {source_kind:'local'|'peer';request_id:string;source_input_id:string;candidate_tasks_json:string}|null;
  if(!legacy)throw new Error('This historical ask has no pending reconciliation row.');
  const candidates=JSON.parse(legacy.candidate_tasks_json) as ChatGptTask[];
  if(!candidates.some(candidate=>candidate.kind===task.kind&&candidate.id===task.id))
    throw new Error('The selected task is not among this historical ask’s retained candidates.');
  const request=legacy.source_kind==='local'
    ?db.query(`SELECT source_session_id,target_session_id,payload_json,outcome,result_json,created_at_ms,NULL AS peer,NULL AS remote_session_id
      FROM session_communication_requests WHERE request_id=? AND source_input_id=?`).get(input.requestId,legacy.source_input_id)
    :db.query(`SELECT source_session_id,NULL AS target_session_id,payload_json,outcome,result_json,created_at_ms,peer,remote_session_id
      FROM session_peer_requests WHERE request_id=? AND source_input_id=?`).get(input.requestId,legacy.source_input_id);
  const ask=request as {source_session_id:number;target_session_id:number|null;payload_json:string;outcome:string|null;
    result_json:string|null;created_at_ms:number;peer:string|null;remote_session_id:string|null}|null;
  if(!ask||ask.source_session_id!==input.askerSessionId)throw new Error('Only the historical asking session can classify this exact ask.');
  if(task.kind==='direct_input'){
    const original=getAcceptedSessionInput(task.id);
    if(!original||original.session_id!==input.askerSessionId||original.origin!=='human'||!DIRECT_TURN_KINDS.has(original.kind))
      throw new Error('The selected direct task is not an accepted human turn input in this asking session.');
  }else if(!chatGptTaskHeldBy(input.askerSessionId,task))
    throw new Error('The selected historical work task is no longer open in this asking session.');
  if(legacy.source_kind==='local'&&input.provider!=='chatgpt')
    throw new Error('The local recipient is immutably recorded as ChatGPT.');
  const selectedProvider=JSON.parse(ask.payload_json).provider;
  if(typeof selectedProvider==='string'&&selectedProvider==='chatgpt'&&input.provider!=='chatgpt')
    throw new Error('The historical request immutably selected ChatGPT; it cannot be classified as another provider.');
  if(input.provider==='chatgpt'){
    const payload=JSON.parse(ask.payload_json);
    const question=String(payload.text??payload.message??'');
    const target=legacy.source_kind==='local'?`concierge:${ask.target_session_id}`
      :ask.remote_session_id?`${ask.peer}/${ask.remote_session_id}`:`${ask.peer}/request:${input.requestId}`;
    admitChatGptObligation({requestId:input.requestId,task,askerSessionId:input.askerSessionId,
      question,targetSessionId:target,now:ask.created_at_ms,legacyCustodyVerified:true});
    bindDirectChatGptTaskSource(task,legacy.source_input_id,input.askerSessionId);
    if(ask.outcome){
      const result=ask.result_json?JSON.parse(ask.result_json):{};
      recordChatGptAttemptResult({requestId:input.requestId,outcome:ask.outcome,
        answerEventId:typeof result.event_id==='string'?result.event_id:undefined,now:input.now,
        reason:'Historical attempt classified by exact task and recipient evidence.'});
      if((ask.outcome==='answered'||ask.outcome==='undetermined')&&typeof result.event_id==='string'){
        const event=legacy.source_kind==='local'
          ?db.query('SELECT accepted_input_id,status FROM session_communication_events WHERE event_id=?').get(result.event_id) as {accepted_input_id:string|null;status:string}|null
          :db.query('SELECT accepted_input_id,status FROM session_peer_events WHERE event_id=?').get(result.event_id) as {accepted_input_id:string|null;status:string}|null;
        if(event?.status==='received'&&event.accepted_input_id)
          recordChatGptReturnReceipt({eventId:result.event_id,returnInputId:event.accepted_input_id,now:input.now});
      }
    }
    if(legacy.source_kind==='peer'&&ask.outcome!=='answered')holdChatGptPeerVersion(input.requestId,input.now);
  }
  db.query("UPDATE session_chatgpt_legacy_reconciliation SET state='linked',reason=? WHERE source_kind=? AND request_id=? AND state='pending'")
    .run(`${input.provider==='other'?'Verified non-ChatGPT recipient':'Linked exact ChatGPT task'}: ${input.reason.trim()}`,legacy.source_kind,input.requestId);
  return {requestId:input.requestId,task,provider:input.provider,classified:true};
}

/** Called within the request admission transaction, before provider dispatch. */
export function admitChatGptObligation(input:{requestId:string;task:ChatGptTask;askerSessionId:number;question:string;targetSessionId:string;now:number;legacyCustodyVerified?:boolean}):void {
  if(!input.legacyCustodyVerified&&!chatGptTaskHeldBy(input.askerSessionId,input.task))throw new Error('The ChatGPT question has no open task held by this session.');
  if(!input.question.trim()||!input.targetSessionId)throw new Error('A ChatGPT obligation needs the exact question and resolved provider target.');
  const previous=db.query('SELECT * FROM session_chatgpt_obligations WHERE obligation_id=?').get(input.requestId) as ObligationRow|null;
  if(previous){
    if(previous.task_kind!==input.task.kind||previous.task_id!==input.task.id||previous.question_text!==input.question||previous.target_session_id!==input.targetSessionId)
      throw new Error('Idempotency conflict: this ChatGPT question belongs to different task, words, or target.');
    return;
  }
  db.query(`INSERT INTO session_chatgpt_obligations(obligation_id,task_kind,task_id,asker_session_id,question_text,target_session_id,state,
    active_request_id,next_action,due_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    input.requestId,input.task.kind,input.task.id,input.askerSessionId,input.question,input.targetSessionId,'awaiting_answer',
    input.requestId,'await_original_answer',null,input.now,input.now);
  db.query(`INSERT INTO session_chatgpt_obligation_attempts(request_id,obligation_id,kind,created_at_ms) VALUES(?,?,?,?)`)
    .run(input.requestId,input.requestId,'original',input.now);
  db.query(`INSERT INTO session_chatgpt_obligation_events(event_id,obligation_id,action_id,state,evidence_json,created_at_ms)
    VALUES(?,?,?,?,?,?)`).run(`chatgpt-obligation:${input.requestId}:admitted`,input.requestId,'admitted','awaiting_answer',
    JSON.stringify({task:input.task,requestId:input.requestId,targetSessionId:input.targetSessionId}),input.now);
}

export function chatGptObligationForAttempt(requestId:string):ObligationRow|null {
  return db.query(`SELECT obligation.* FROM session_chatgpt_obligations obligation
    JOIN session_chatgpt_obligation_attempts attempt ON attempt.obligation_id=obligation.obligation_id
    WHERE attempt.request_id=?`).get(requestId) as ObligationRow|null;
}

/** A new peer ChatGPT session has no address until its owner acknowledges creation. Keep the
 * obligation before network contact, then pin the immutable remote session identity once. */
export function bindChatGptPeerTarget(requestId:string,targetSessionId:string,now:number) {
  const obligation=chatGptObligationForAttempt(requestId);
  if(!obligation)return;
  if(!targetSessionId||!/^\w[\w-]*\/concierge:\d+$/.test(targetSessionId))throw new Error('A peer ChatGPT target needs its exact instance and session.');
  if(obligation.target_session_id===targetSessionId)return;
  if(!obligation.target_session_id.endsWith(`/request:${requestId}`))throw new Error('The accepted peer target changed for an existing ChatGPT question.');
  db.query('UPDATE session_chatgpt_obligations SET target_session_id=?,updated_at_ms=? WHERE obligation_id=? AND target_session_id=?')
    .run(targetSessionId,now,obligation.obligation_id,obligation.target_session_id);
  db.query(`INSERT INTO session_chatgpt_obligation_events(event_id,obligation_id,action_id,state,evidence_json,created_at_ms)
    VALUES(?,?,?,?,?,?)`).run(`chatgpt-obligation:${obligation.obligation_id}:target:${requestId}`,obligation.obligation_id,
      `target:${requestId}`,obligation.state,JSON.stringify({targetSessionId}),now);
}

/** A missing-context follow-up is a new question in the same ChatGPT conversation after
 * the prior answer reached its asker. It is never a retry of an ambiguous browser send. */
export function admitChatGptContextFollowUp(input:{requestId:string;obligationId:string;task:ChatGptTask;
  askerSessionId:number;targetSessionId:string;now:number}) {
  const previous=db.query('SELECT * FROM session_chatgpt_obligations WHERE obligation_id=?').get(input.obligationId) as ObligationRow|null;
  if(!previous||previous.asker_session_id!==input.askerSessionId||previous.task_kind!==input.task.kind
    ||previous.task_id!==input.task.id||previous.target_session_id!==input.targetSessionId)
    throw new Error('A context follow-up must serve the same exact task in the same ChatGPT conversation.');
  const prior=db.query('SELECT * FROM session_chatgpt_obligation_attempts WHERE request_id=?').get(input.requestId) as {obligation_id:string;kind:string}|null;
  if(prior){if(prior.obligation_id!==input.obligationId||prior.kind!=='context_followup')throw new Error('Idempotency conflict: follow-up identity changed.');return;}
  if(previous.state!=='resolution_pending'||!previous.answer_event_id||!previous.answer_return_input_id)
    throw new Error('The original answer must reach its asker before a missing-context follow-up. An ambiguous send needs receipt reconciliation, never blind resend.');
  db.query(`INSERT INTO session_chatgpt_obligation_attempts(request_id,obligation_id,kind,created_at_ms) VALUES(?,?,?,?)`)
    .run(input.requestId,input.obligationId,'context_followup',input.now);
  db.query(`UPDATE session_chatgpt_obligations SET state='awaiting_answer',active_request_id=?,answer_event_id=NULL,
    answer_return_input_id=NULL,next_action='await_context_followup_answer',generation=generation+1,due_at_ms=NULL,updated_at_ms=?
    WHERE obligation_id=?`).run(input.requestId,input.now,input.obligationId);
  db.query(`INSERT INTO session_chatgpt_obligation_events(event_id,obligation_id,action_id,state,evidence_json,created_at_ms)
    VALUES(?,?,?,?,?,?)`).run(`chatgpt-obligation:${input.obligationId}:follow-up:${input.requestId}`,input.obligationId,
      `follow-up:${input.requestId}`,'awaiting_answer',JSON.stringify({requestId:input.requestId,priorAnswerEventId:previous.answer_event_id}),input.now);
}

/** A refused attachment never reached Send. A new immutable request may carry corrected bytes,
 * while the original failed request and its receipt remain evidence for the same question. */
export function admitChatGptAttachmentCorrection(input:{requestId:string;obligationId:string;task:ChatGptTask;
  askerSessionId:number;targetSessionId:string;question:string;originalRunId:string;reason:string;now:number}) {
  const previous=db.query('SELECT * FROM session_chatgpt_obligations WHERE obligation_id=?').get(input.obligationId) as ObligationRow|null;
  if(!previous||previous.asker_session_id!==input.askerSessionId||previous.task_kind!==input.task.kind
    ||previous.task_id!==input.task.id||previous.target_session_id!==input.targetSessionId
    ||previous.question_text!==input.question)
    throw new Error('Attachment correction must preserve the original open question, task, target, and failed attempt.');
  const prior=db.query('SELECT * FROM session_chatgpt_obligation_attempts WHERE request_id=?').get(input.requestId) as {obligation_id:string;kind:string}|null;
  if(prior){if(prior.obligation_id!==input.obligationId||prior.kind!=='attachment_correction')throw new Error('Idempotency conflict: correction identity changed.');return;}
  if(previous.active_request_id!==input.obligationId||previous.state!=='reconcile_receipt')
    throw new Error('The original failed ChatGPT attempt is no longer awaiting a correction.');
  db.query(`INSERT INTO session_chatgpt_obligation_attempts(request_id,obligation_id,kind,created_at_ms) VALUES(?,?,?,?)`)
    .run(input.requestId,input.obligationId,'attachment_correction',input.now);
  db.query(`UPDATE session_chatgpt_obligations SET state='awaiting_answer',active_request_id=?,answer_event_id=NULL,
    answer_return_input_id=NULL,next_action='await_corrected_attachment_answer',generation=generation+1,due_at_ms=NULL,updated_at_ms=?
    WHERE obligation_id=?`).run(input.requestId,input.now,input.obligationId);
  db.query(`INSERT INTO session_chatgpt_obligation_events(event_id,obligation_id,action_id,state,evidence_json,created_at_ms)
    VALUES(?,?,?,?,?,?)`).run(`chatgpt-obligation:${input.obligationId}:attachment-correction:${input.requestId}`,
      input.obligationId,`attachment-correction:${input.requestId}`,'awaiting_answer',
      JSON.stringify({originalRequestId:input.obligationId,originalRunId:input.originalRunId,
        correctedRequestId:input.requestId,receiptReason:input.reason}),input.now);
}

function transition(input:{obligationId:string;actionId:string;state:ChatGptObligationState;nextAction:string;
  now:number;evidence:unknown;answerEventId?:string;answerReturnInputId?:string;dueAtMs?:number|null;resolution?:unknown}) {
  db.transaction(()=>{
  const previous=db.query('SELECT * FROM session_chatgpt_obligations WHERE obligation_id=?').get(input.obligationId) as ObligationRow|null;
  if(!previous)throw new Error('Unknown ChatGPT answer obligation.');
  const eventId=`chatgpt-obligation:${input.obligationId}:${input.actionId}`;
  if(db.query('SELECT 1 FROM session_chatgpt_obligation_events WHERE event_id=?').get(eventId))return;
  db.query(`UPDATE session_chatgpt_obligations SET state=?,next_action=?,generation=generation+1,due_at_ms=?,updated_at_ms=?,
    answer_event_id=COALESCE(?,answer_event_id),answer_return_input_id=COALESCE(?,answer_return_input_id),
    resolution_json=COALESCE(?,resolution_json) WHERE obligation_id=?`).run(
      input.state,input.nextAction,input.dueAtMs??null,input.now,input.answerEventId??null,input.answerReturnInputId??null,
      input.resolution===undefined?null:JSON.stringify(input.resolution),input.obligationId);
  db.query(`INSERT INTO session_chatgpt_obligation_events(event_id,obligation_id,action_id,state,evidence_json,created_at_ms)
    VALUES(?,?,?,?,?,?)`).run(eventId,input.obligationId,input.actionId,input.state,JSON.stringify(input.evidence),input.now);
  })();
}

/** A provider attempt is evidence, not settlement of the asking task. A failed or ambiguous
 * attempt retains receipt reconciliation; it never authorizes a second browser send. */
export function recordChatGptAttemptResult(input:{requestId:string;outcome:string;answerEventId?:string;now:number;reason?:string}) {
  const obligation=chatGptObligationForAttempt(input.requestId);
  if(!obligation||obligation.active_request_id!==input.requestId||obligation.state==='resolved'||obligation.state==='withdrawn_by_tejas')return;
  // ChatGPT has no work disposition. Its confirmed answer may leave a work request
  // undetermined, but the exact question has still been answered and must return.
  if((input.outcome==='answered'||input.outcome==='undetermined')&&input.answerEventId){
    transition({obligationId:obligation.obligation_id,actionId:`answer:${input.answerEventId}`,state:'return_pending',
      nextAction:'confirm_exact_return_receipt',now:input.now,answerEventId:input.answerEventId,dueAtMs:input.now+300_000,
      evidence:{requestId:input.requestId,outcome:input.outcome,answerEventId:input.answerEventId}});
  }else{
    transition({obligationId:obligation.obligation_id,actionId:`attempt:${input.requestId}:${input.outcome}`,state:'reconcile_receipt',
      nextAction:'inspect_original_provider_operation_without_resend',now:input.now,dueAtMs:input.now,
      evidence:{requestId:input.requestId,outcome:input.outcome,reason:input.reason??null}});
  }
}

/** A proven no-send recovery keeps the original question waiting on its original run.
 * The due check observes that run; it does not send a second question. */
export function recordChatGptOriginalRequeued(input:{requestId:string;runId:string;now:number}) {
  const obligation=chatGptObligationForAttempt(input.requestId);
  if(!obligation||obligation.active_request_id!==input.requestId||obligation.state==='resolved'||obligation.state==='withdrawn_by_tejas')
    throw new Error('The original ChatGPT question is no longer an open recovery target.');
  transition({obligationId:obligation.obligation_id,actionId:`original-requeued:${input.runId}`,
    state:'awaiting_answer',nextAction:'observe_original_requeued_run',now:input.now,
    dueAtMs:input.now+300_000,evidence:{requestId:input.requestId,runId:input.runId}});
}

export function holdChatGptPeerVersion(requestId:string,now:number) {
  const obligation=chatGptObligationForAttempt(requestId);
  if(!obligation||obligation.state==='resolved'||obligation.state==='withdrawn_by_tejas')return;
  transition({obligationId:obligation.obligation_id,actionId:`peer-version-hold:${requestId}`,state:'external_hold',
    nextAction:'peer_upgrade_then_reconcile_exact_operation_without_resend',now,dueAtMs:now+300_000,
    evidence:{requestId,reason:'peer did not echo answer guarantee version'}});
}

const ASKING_SESSION_HOLD='asking_session_unavailable_retain_exact_obligation';

/** Preserve the previous answer state while its asking session cannot receive repair work. */
export function holdUnmessageableChatGptAsker(obligationId:string,now:number,reason:string):boolean {
  const row=db.query('SELECT * FROM session_chatgpt_obligations WHERE obligation_id=?').get(obligationId) as ObligationRow|null;
  if(!row||row.state==='resolved'||row.state==='withdrawn_by_tejas')return false;
  if(row.state==='external_hold'&&row.next_action===ASKING_SESSION_HOLD){
    db.query('UPDATE session_chatgpt_obligations SET due_at_ms=?,updated_at_ms=? WHERE obligation_id=?')
      .run(now+300_000,now,obligationId);
    return false;
  }
  const prior={state:row.state,nextAction:row.next_action};
  transition({obligationId,actionId:`asker-hold:${row.generation+1}`,state:'external_hold',
    nextAction:ASKING_SESSION_HOLD,now,dueAtMs:now+300_000,
    evidence:{reason,prior,requestId:row.active_request_id}});
  return true;
}

/** A messageable asker resumes the state held before pause/archive, then receives repair. */
export function resumeMessageableChatGptAsker(obligationId:string,now:number):boolean {
  const row=db.query('SELECT * FROM session_chatgpt_obligations WHERE obligation_id=?').get(obligationId) as ObligationRow|null;
  if(!row||row.state!=='external_hold'||row.next_action!==ASKING_SESSION_HOLD)return false;
  const held=db.query(`SELECT evidence_json FROM session_chatgpt_obligation_events WHERE obligation_id=?
    AND action_id LIKE 'asker-hold:%' ORDER BY rowid DESC LIMIT 1`).get(obligationId) as {evidence_json:string}|null;
  if(!held)throw new Error('An unavailable asking session has no retained prior answer state.');
  const prior=JSON.parse(held.evidence_json).prior as {state:ChatGptObligationState;nextAction:string};
  transition({obligationId,actionId:`asker-resume:${row.generation+1}`,state:prior.state,
    nextAction:prior.nextAction,now,dueAtMs:now,evidence:{from:'asking_session_unavailable'}});
  return true;
}

/** The exact event may share one accepted input with other answers. Each obligation still
 * resolves only from its own event, and only after the provider acknowledged that input. */
export function recordChatGptReturnReceipt(input:{eventId:string;returnInputId:string;now:number}) {
  const obligation=db.query('SELECT * FROM session_chatgpt_obligations WHERE answer_event_id=?').get(input.eventId) as ObligationRow|null;
  if(!obligation||obligation.state!=='return_pending')return;
  transition({obligationId:obligation.obligation_id,actionId:`return:${input.eventId}:${input.returnInputId}`,
    state:'resolution_pending',nextAction:'asker_must_handle_answer_and_missing_context',now:input.now,dueAtMs:input.now+300_000,
    answerReturnInputId:input.returnInputId,evidence:{eventId:input.eventId,returnInputId:input.returnInputId}});
}

/** The asker explicitly accounts for the answer it received. This records a process
 * disposition, not an assertion by the owner that ChatGPT's substantive answer is correct. */
export function resolveChatGptAnswer(input:{obligationId:string;askerSessionId:number;answerEventId:string;
  actionId:string;handling:'used'|'context_supplied'|'scoped';reason?:string;followUpRequestId?:string;sourceInputId:string;now:number}) {
  db.transaction(()=>{
    const obligation=db.query('SELECT * FROM session_chatgpt_obligations WHERE obligation_id=?').get(input.obligationId) as ObligationRow|null;
    if(!obligation||obligation.asker_session_id!==input.askerSessionId)throw new Error('Only the exact asking session can handle this ChatGPT answer.');
    const prior=db.query('SELECT evidence_json FROM session_chatgpt_obligation_events WHERE obligation_id=? AND action_id=?')
      .get(input.obligationId,`handled:${input.actionId}`) as {evidence_json:string}|null;
    const disposition={answerEventId:input.answerEventId,handling:input.handling,reason:input.reason??null,
      followUpRequestId:input.followUpRequestId??null,sourceInputId:input.sourceInputId};
    if(prior){if(JSON.stringify(JSON.parse(prior.evidence_json))!==JSON.stringify(disposition))throw new Error('Idempotency conflict: handled answer changed.');return;}
    if(obligation.state!=='resolution_pending'||obligation.answer_event_id!==input.answerEventId||!obligation.answer_return_input_id)
      throw new Error('The exact ChatGPT answer has not been acknowledged by the asking session.');
    if(input.handling==='scoped'&&!input.reason?.trim())throw new Error('A narrowed conclusion needs the concrete scope and reason.');
    if(input.handling==='context_supplied'&&(!input.followUpRequestId||input.followUpRequestId!==obligation.active_request_id||!db.query(`SELECT 1 FROM session_chatgpt_obligation_attempts
      WHERE request_id=? AND obligation_id=? AND kind='context_followup'`).get(input.followUpRequestId,input.obligationId)))
      throw new Error('Context supplied needs an exact follow-up request attached to this obligation.');
    if(!getAcceptedSessionInput(input.sourceInputId)||getAcceptedSessionInput(input.sourceInputId)?.session_id!==input.askerSessionId)
      throw new Error('Handling needs the asking session\'s exact accepted source input.');
    transition({obligationId:input.obligationId,actionId:`handled:${input.actionId}`,state:'resolved',nextAction:'none',now:input.now,
      evidence:disposition,resolution:disposition});
  })();
}
