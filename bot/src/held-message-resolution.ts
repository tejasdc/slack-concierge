import {isDeepStrictEqual} from 'node:util';
import type {Database} from 'bun:sqlite';

/** A product reference is custody/correlation evidence, never a grant to send. */
export type HeldMessageResolution={kind:'held-message';id:string;originalRequestId:string;taskId:string;messageId:string;
  sourceInputId:string;failedReadingId:string;failedReadingSha256:string};
export const HELD_RESOLUTION_KINDS=['human-choice','revise-content','repair'] as const;
export const HELD_RESOLUTION_STATES=['pending','admitted','resolved'] as const;
export const HELD_RESOLUTION_COMPLETIONS=['revision','withdrawn','consumed'] as const;
export type HeldResolutionCompletion={kind:typeof HELD_RESOLUTION_COMPLETIONS[number];receiptId:string;messageId:string;envelopeHash:string};
export type HeldMessageSnapshot=Omit<HeldMessageResolution,'kind'>&{version:1;callerSession:string;failedReadingFormat:'assessment-manifest-v1';failedReadingJson:string;contextHash:string;envelopeHash:string;quoteSourceInputId:string|null;
  resolutionKind:typeof HELD_RESOLUTION_KINDS[number];reason:string;question:string|null;supportingQuote:string|null;state:typeof HELD_RESOLUTION_STATES[number];eligible:boolean;consumed:boolean;completion?:HeldResolutionCompletion};
export type HeldMessageBinding={version:1;resolution:HeldMessageResolution;originalInputId:string;requestId:string;
  sessionId:number;inboxSessionId:number;threadRootInputId:string;sourceInputId:string;continuationOnly:true;snapshot:HeldMessageSnapshot};
type Input={id:string;session_id:number;scope:string;origin:string;kind:string;source_input_id:string|null;
  source_run_id:string|null;request_id:string|null;payload_json:string};
export const HELD_RESOLUTION_SCOPE='feature:held-message-resolution';
export function parseHeldMessageResolution(value:unknown):HeldMessageResolution {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('A held-message resolution binding is required.');
  const input=value as Record<string,unknown>;
  const keys=['kind','id','originalRequestId','taskId','messageId','sourceInputId','failedReadingId','failedReadingSha256'];
  if(Object.keys(input).some(key=>!keys.includes(key))||keys.some(key=>typeof input[key]!=='string')
    ||input.kind!=='held-message'||!/^\w[\w:.,@-]{0,199}$/.test(String(input.id))
    ||keys.filter(key=>key!=='kind'&&key!=='id').some(key=>!(input[key] as string).trim()||(input[key] as string).length>500||/[\x00-\x1f\x7f]/.test(input[key] as string))
    ||!/^[a-f0-9]{64}$/.test(String(input.failedReadingSha256)))throw new Error('Invalid held-message resolution identity.');
  return Object.fromEntries(keys.map(key=>[key,input[key]])) as HeldMessageResolution;
}
/** The exact retained service input AND separate owner event prove this edge; caller text cannot. */
export function heldMessageBinding(database:Database,input:Input):HeldMessageBinding|null {
  if(input.scope!==HELD_RESOLUTION_SCOPE||input.origin!=='service'||input.kind!=='input'||input.source_run_id!==null)return null;
  const payload=JSON.parse(input.payload_json);
  const row=database.query("SELECT payload_json FROM session_owner_events WHERE event_id=? AND input_id=? AND session_id=? AND kind='feature_resolution_bound'")
    .get(`feature-resolution:${input.id}`,input.id,input.session_id) as {payload_json:string}|null;
  if(!row)return null;
  const binding=JSON.parse(row.payload_json) as HeldMessageBinding;
  if(binding.version!==1||binding.snapshot?.version!==1||binding.continuationOnly!==true||binding.sessionId!==input.session_id
    ||binding.originalInputId!==input.source_input_id||binding.requestId!==input.request_id
    ||!isDeepStrictEqual(payload.featureResolution,binding))return null;
  return binding;
}
/** Used both before dispatch and by the queued-turn admission predicate. No timers or extra queue. */
export function heldResolutionCurrentSql(alias:string):string {
  return `EXISTS (SELECT 1 FROM session_communication_requests resolution_request
    JOIN session_inputs resolution_original ON resolution_original.id=${alias}.source_input_id
    JOIN turns resolution_turn ON resolution_turn.id=resolution_original.turn_id AND resolution_turn.session_id=resolution_original.session_id
    WHERE resolution_request.request_id=${alias}.request_id AND resolution_request.target_input_id=resolution_original.id
      AND resolution_request.target_session_id=${alias}.session_id AND resolution_original.session_id=${alias}.session_id
      AND coalesce(resolution_request.outcome,'')<>'canceled' AND resolution_turn.provider_admission_intended_at IS NOT NULL
      AND resolution_turn.stop_requested_at IS NULL
      AND (resolution_original.steering_id IS NULL OR EXISTS (SELECT 1 FROM turn_steering_messages resolution_steering
        WHERE resolution_steering.id=resolution_original.steering_id AND resolution_steering.status IN ('sent','ambiguous')))
      AND NOT EXISTS (SELECT 1 FROM turns resolution_stop WHERE resolution_stop.session_id=${alias}.session_id
        AND resolution_stop.id>=resolution_turn.id AND resolution_stop.stop_requested_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM session_handoffs resolution_handoff WHERE resolution_handoff.predecessor_session_id=${alias}.session_id
        AND resolution_handoff.state IN ('proposed','accepted'))) `;
}
export function heldResolutionIsCurrent(database:Database,input:Input):boolean {
  return !!heldMessageBinding(database,input)&&!!database.query(`SELECT 1 FROM session_inputs resolution_input WHERE resolution_input.id=? AND ${heldResolutionCurrentSql('resolution_input')}`).get(input.id);
}


/** Exact effect evidence on the same operation receipt; execution completion alone is not resolution. */
export function heldResolutionProgress(database:Database,input:Input,isEngineeringTarget:(id:number)=>boolean) {
  const binding=heldMessageBinding(database,input);
  if(!binding)return null;
  const marker=database.query("SELECT payload_json FROM session_owner_events WHERE event_id=? AND input_id=? AND kind='feature_resolution_question'")
    .get(`feature-resolution-question:${input.id}`,input.id) as {payload_json:string}|null;
  if(marker){
    const proof=JSON.parse(marker.payload_json);
    const question=database.query('SELECT state,owner_json,topic_id FROM inbox_questions WHERE question_id=?').get(proof.questionId) as any;
    if(question&&JSON.parse(question.owner_json??'{}').heldResolutionInputId===input.id&&question.topic_id===proof.topicId)
      return {version:1,state:'question',question:{questionId:proof.questionId,state:question.state,postId:proof.postId,topicId:proof.topicId,threadRootInputId:binding.threadRootInputId}};
  }
  const revision=database.query("SELECT payload_json FROM session_owner_events WHERE event_id=? AND input_id=? AND kind='feature_resolution_revision'")
    .get(`feature-resolution-revision:${input.id}`,input.id) as {payload_json:string}|null;
  if(revision){const completion=JSON.parse(revision.payload_json);return {version:1,state:completion.kind==='revision'?'revision':'retired',completion};}
  // Writing sessions use the existing issue-report entrance. The report is owned even before an engineer is dispatched.
  const report=database.query(`SELECT report.id,request.request_id,request.topic_id,request.state FROM session_inputs report
    JOIN inbox_requests request ON request.request_id='req:agent-report:'||report.id
    WHERE report.source_input_id=? AND report.origin='agent' AND report.kind='input'
      AND json_extract(report.payload_json,'$.capture.source.kind')='agent-report' ORDER BY report.rowid LIMIT 1`).get(input.id) as any;
  const work=database.query(`SELECT request.request_id,request.target_session_id,request.target_input_id,request.status,request.outcome,session.native_metadata_json
    FROM session_communication_requests request JOIN sessions session ON session.id=request.target_session_id
    WHERE (request.source_input_id=? OR (? IS NOT NULL AND request.source_input_id=?))
      AND json_extract(request.payload_json,'$.requestedEffect')='work' AND request.target_input_id IS NOT NULL
      AND (request.outcome IS NULL OR request.outcome='answered') ORDER BY request.created_at_ms LIMIT 20`)
    .all(input.id,report?.id??null,report?.id??null) as any[];
  const handoff=work.find(row=>{const meta=JSON.parse(row.native_metadata_json??'{}');
    return !meta.inbox&&meta.interactionPolicy!=='consultation-only'&&!!(meta.projectName||meta.cwd)&&isEngineeringTarget(row.target_session_id);});
  if(handoff)return {version:1,state:'repair-handoff',handoff:{requestId:handoff.request_id,targetSessionId:`concierge:${handoff.target_session_id}`,
    operationId:handoff.target_input_id,status:handoff.status,outcome:handoff.outcome}};
  if(report)return {version:1,state:'repair-report',report:{captureInputId:report.id,requestId:report.request_id,topicId:report.topic_id,state:report.state},resolved:false};
  if(!heldResolutionIsCurrent(database,input))return {version:1,state:'fenced'};
  const turn=database.query('SELECT turn.status FROM turns turn JOIN session_inputs input ON input.turn_id=turn.id WHERE input.id=?').get(input.id) as {status:string}|null;
  return {version:1,state:turn&&['done','error','cancelled','interrupted','parked'].includes(turn.status)?'unresolved':'pending',
    reason:'No original-thread question, verified revision or accepted repair ownership is recorded.'};
}
