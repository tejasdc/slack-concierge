import type {Database} from 'bun:sqlite';
import {noticeTime} from './notice-time';
import {inputExecutionFacts,receiptOperationState,type ReceiptTurnFacts,type ReceiptSteeringFacts} from './session-receipt-state';
import {receiptStatusFromFacts,type StatusContext,type InputStatusDetail} from './session-receipt-status';
import {survivableRunKinds} from './execution-survival';
import {modelDisplayName} from './aliases';

type SourceInput={id:string;session_id:number;kind:string;origin:string;source_input_id:string|null;
  request_id:string|null;turn_id:number|null;steering_id:number|null;created_at:string;updated_at:string;
  payload_json:string;receipt_json:string|null};
type Turn=NonNullable<ReceiptTurnFacts>&{id:number;native_run_id:string|null;ended_at:string|null;agent_text:string|null;
  dispatch_failure_class:string|null;dispatch_next_attempt_ms:number|null;dispatch_attempt:number;
  saved_kind:'scheduled'|'banked'|null};
type Steering=ReceiptSteeringFacts&{error:string|null};
type Conversation={known:boolean;outcome:string|null;targetSessionId:string|null;targetAddress:string|null;
  sourceInputId:string|null;resultPreview:string|null};
export type ReceiptDynamicFacts={kind:'exact';statusDetail:InputStatusDetail|null;providerOutage:unknown|null};
type ThreadLink={thread:string;attached:boolean;routedBy:unknown}|null;
export type PreparedReceipt=Readonly<{
  operationId:string;sessionId:string;inputId:string|null;requestId:string|null;runId:string|null;
  kind:string;origin:string;state:string;acknowledgedAt:string|null;createdAt:string;updatedAt:string;
  sourceInputId:string|null;targetSessionId:string|null;targetAddress:string|null;
  replyToMessage:unknown|null;routedBy:unknown|null;settlementOutcome:string|null;childSessionId:string|null;
  textPreview:string|null;resultPreview:string|null;errorPreview:string|null;
  statusDetail:{code:string;message:string;messageTruncated:boolean;clearsAt:string|null;automaticRetry:boolean}|null;
  providerOutage:unknown|null;statusCoverage:'complete'|'catching_up';nextRefreshAtMs:number|null;detail:{operationId:string};
}>;
const iso=(value:string|null|undefined)=>value?new Date(value.includes('T')?value:value+'Z').toISOString():null;
const preview=(value:unknown,maxBytes=384):{text:string|null;truncated:boolean}=>{
  if(typeof value!=='string')return {text:null,truncated:false};
  let text='',bytes=0;for(const character of value){const next=Buffer.byteLength(character);if(bytes+next>maxBytes)break;text+=character;bytes+=next;}
  return {text,truncated:text.length<value.length};
};
const json=(value:string|null|undefined):any=>value?JSON.parse(value):{};

/** The worker provides exact live facts separately. A pending fact cannot masquerade as a
 * complete receipt; exact full bodies and return events stay behind the selected detail ID. */
export function compactReceiptFromFacts(input:SourceInput,turn:Turn|null,steering:Steering|null,
  conversation:Conversation,stopTurnStatus:string|null,dynamic:ReceiptDynamicFacts,nowMs=Date.now(),link:ThreadLink=null):PreparedReceipt {
  const payload=json(input.payload_json),saved=json(input.receipt_json);
  const execution=inputExecutionFacts(turn,steering);
  const state=receiptOperationState({kind:input.kind,savedState:saved.state,executionState:execution.state,
    requestKnown:conversation.known,requestOutcome:conversation.outcome,stopTurnStatus});
  const control=['action','stop','reconcile','cancel','bind','fork','project-task','inbox-capture','resurrect',
    'resurrect-native','outage-choice'].includes(input.kind);
  const text=control?null:payload.text??payload.firstInput?.text??null;
  const result=control?null:input.kind==='request'?conversation.resultPreview:turn?.agent_text??null;
  const error=saved.error?.message??saved.error??steering?.error??(['failed','uncertain'].includes(execution.state)?turn?.agent_text:null);
  const detail=dynamic.statusDetail;
  const detailMessage=preview(detail?.message,384);
  const card:PreparedReceipt={operationId:input.id,sessionId:`concierge:${input.session_id}`,
    inputId:['input','create','consultation','comparison'].includes(input.kind)?input.id:
      ['request','reply'].includes(input.kind)?input.source_input_id:null,
    requestId:input.request_id,runId:input.kind==='stop'?payload.runId??null:control?null:turn?.native_run_id??null,
    kind:input.kind,origin:input.origin,state,acknowledgedAt:iso(execution.acknowledgedAt),
    createdAt:iso(input.created_at)!,updatedAt:iso(turn?.ended_at??input.updated_at)!,
    sourceInputId:input.source_input_id,targetSessionId:conversation.targetSessionId,
    targetAddress:conversation.targetAddress,
    replyToMessage:payload.replyToMessage??(link?.attached?{kind:'message',sessionId:`concierge:${input.session_id}`,messageId:link.thread}:null),
    routedBy:payload.replyToMessage?null:link?.attached?link.routedBy:null,
    settlementOutcome:conversation.outcome??saved.settlement?.outcome??null,
    childSessionId:saved.childSessionId??null,textPreview:preview(text).text,
    resultPreview:preview(result).text,errorPreview:preview(typeof error==='string'?error:error?.message).text,
    statusDetail:detail?{code:detail.code,message:detailMessage.text??'',messageTruncated:detailMessage.truncated,
      clearsAt:detail.clearsAt,automaticRetry:detail.automaticRetry}:null,
    providerOutage:dynamic.providerOutage,statusCoverage:'complete',
    nextRefreshAtMs:turn?.status==='queued'&&turn.dispatch_failure_class==='backoff'&&
      turn.dispatch_next_attempt_ms!==null&&turn.dispatch_next_attempt_ms>nowMs
      ?turn.dispatch_next_attempt_ms:null,
    detail:{operationId:input.id}};
  // The list contract is a finite preview. A new field must not smuggle full retained text in.
  if(Buffer.byteLength(JSON.stringify(card))>4*1024)throw new Error('PREPARED_RECEIPT_EXCEEDS_BOUND');
  return card;
}

/** One canonical input at a time. Every lookup is by a retained exact key, never by history. */
export function readCompactReceipt(source:Database,inputId:string):PreparedReceipt|null {
  const nowMs=Date.now();
  const input=source.query('SELECT * FROM session_inputs WHERE id=?').get(inputId) as SourceInput|null;
  if(!input)return null;
  const turn=input.turn_id?source.query('SELECT * FROM turns WHERE id=?').get(input.turn_id) as Turn|null:null;
  const steering=input.steering_id?source.query('SELECT status,provider_sent_at,error FROM turn_steering_messages WHERE id=?')
    .get(input.steering_id) as Steering|null:null;
  let conversation:Conversation={known:false,outcome:null,targetSessionId:null,targetAddress:null,sourceInputId:null,resultPreview:null};
  if(input.request_id){
    const local=source.query(`SELECT outcome,target_session_id,source_input_id,
      substr(json_extract(result_json,'$.text'),1,512) AS result_preview
      FROM session_communication_requests WHERE request_id=?`).get(input.request_id) as
      {outcome:string|null;target_session_id:number;source_input_id:string|null;result_preview:string|null}|null;
    const peer=local?null:source.query(`SELECT outcome,remote_session_id,remote_address,source_input_id,
      substr(json_extract(result_json,'$.text'),1,512) AS result_preview
      FROM session_peer_requests WHERE request_id=?`).get(input.request_id) as
      {outcome:string|null;remote_session_id:string;remote_address:string;source_input_id:string;result_preview:string|null}|null;
    if(local)conversation={known:true,outcome:local.outcome,targetSessionId:`concierge:${local.target_session_id}`,
      targetAddress:null,sourceInputId:local.source_input_id,resultPreview:local.result_preview};
    else if(peer)conversation={known:true,outcome:peer.outcome,targetSessionId:peer.remote_session_id,
      targetAddress:peer.remote_address,sourceInputId:peer.source_input_id,resultPreview:peer.result_preview};
  }
  const runId=input.kind==='stop'?source.query("SELECT json_extract(payload_json,'$.runId') AS id FROM session_inputs WHERE id=?")
    .get(input.id) as {id:string|null}|null:null;
  const stopped=runId?.id?source.query('SELECT status FROM turns WHERE native_run_id=? AND session_id=?').get(runId.id,input.session_id) as
    {status:string}|null:null;
  const outage=(turnId:number)=>{
    const row=source.query('SELECT payload_json,choice,chosen_at,rerun_session_id FROM provider_outage_offers WHERE turn_id=?')
      .get(turnId) as {payload_json:string;choice:string|null;chosen_at:string|null;rerun_session_id:string|null}|null;
    return row?{...json(row.payload_json),choice:row.choice,chosenAt:row.chosen_at,rerunSessionId:row.rerun_session_id}:null;
  };
  const context:StatusContext={
    retry:(turnId)=>{
      const row=source.query(`SELECT o.attempt,o.max_retries,o.status,o.retry_at_ms FROM provider_retry_observations o
        JOIN provider_retry_incarnation i ON i.singleton=1 AND i.incarnation=o.incarnation WHERE o.turn_id=?`)
        .get(turnId) as {attempt:number;max_retries:number|null;status:number|null;retry_at_ms:number|null}|null;
      return row?{attempt:row.attempt,maxRetries:row.max_retries,status:row.status,retryAt:row.retry_at_ms}:null;
    },
    outage,
    requestWait:(requestId,acceptedInputId)=>{
      const row=source.query('SELECT payload_json,outcome FROM session_communication_requests WHERE request_id=? AND target_input_id=?')
        .get(requestId,acceptedInputId) as {payload_json:string;outcome:string|null}|null;
      const after:string[]=row&&!row.outcome?json(row.payload_json).after??[]:[];
      const held=after.length?source.query(`SELECT request_id,outcome FROM session_communication_requests WHERE request_id IN (${after.map(()=>'?').join(',')})
        AND outcome IN ('unanswered','decision_needed','undetermined') LIMIT 1`).get(...after) as {request_id:string;outcome:string}|null:null;
      return {after:after.length>0,held:held?{requestId:held.request_id,outcome:held.outcome}:null};
    },
    savedTurn:(turnId)=>{
      const row=source.query(`SELECT saved_kind,dispatch_failure_class,dispatch_next_attempt_ms FROM turns
        WHERE id=? AND saved_kind IS NOT NULL`).get(turnId) as {saved_kind:'scheduled'|'banked';dispatch_failure_class:string|null;dispatch_next_attempt_ms:number|null}|null;
      return row;
    },
    session:(sessionId)=>{
      const row=source.query('SELECT status,provider_id,native_metadata_json FROM sessions WHERE id=?').get(sessionId) as
        {status:string;provider_id:string;native_metadata_json:string};
      return {status:row.status,providerId:row.provider_id,suspended:!!json(row.native_metadata_json).suspended};
    },
    deploymentHold:(providerId,inputKind)=>{
      if(!source.query('SELECT 1 FROM deployment_drain WHERE singleton=1').get())return false;
      const survivable=survivableRunKinds(source);
      return !(inputKind!=='fork'&&(providerId==='claude-code'?survivable.claude:providerId==='codex'?survivable.codexShared:false));
    },
    olderBlockingStatus:(sessionId,turnId)=>(source.query(`SELECT status FROM turns older WHERE session_id=? AND id<?
      AND (older.status='queued' OR (older.status='parked' AND older.turn_kind<>'native')) ORDER BY id LIMIT 1`)
      .get(sessionId,turnId) as {status:string}|null)?.status??null,
    dependencyPending:(turnId)=>!!source.query('SELECT 1 FROM turn_dependencies WHERE turn_id=? AND satisfied_at IS NULL').get(turnId),
    now:()=>nowMs,formatTime:ms=>noticeTime(source,ms)
  };
  const execution=inputExecutionFacts(turn,steering);
  const saved=json(input.receipt_json);
  const statusDetail=['input','create','consultation','comparison'].includes(input.kind)
    ?receiptStatusFromFacts(input,{turn,steering,state:execution.state},saved,context):null;
  const offer=turn?outage(turn.id):null;
  const providerOutage=offer?{offeredAt:offer.offeredAt,provider:offer.provider,model:offer.model,
    modelLabel:modelDisplayName(offer.model)||'the selected model',status:offer.status,incident:offer.incident,
    alternatives:offer.alternatives.map(({alias,label,provider}:any)=>({alias,label,provider})),
    open:!offer.choice&&['queued','running'].includes(turn!.status),choice:offer.choice,chosenAt:offer.chosenAt,
    rerunSessionId:offer.rerunSessionId}:null;
  const linkRow=input.origin==='human'?source.query(`SELECT payload_json FROM session_owner_events
    WHERE session_id=? AND kind='thread_link' AND input_id=? ORDER BY sequence DESC LIMIT 1`)
    .get(input.session_id,input.id) as {payload_json:string}|null:null;
  const link=linkRow?json(linkRow.payload_json) as ThreadLink:null;
  return compactReceiptFromFacts(input,turn,steering,conversation,stopped?.status??null,
    {kind:'exact',statusDetail,providerOutage},nowMs,link);
}
