import type {Database} from 'bun:sqlite';
import {acceptedBindingSnapshotDigest as digest} from './codex-accepted-binding-continuation';

const parse=(value:string|null):any=>{try{return value===null?null:JSON.parse(value);}catch{return null;}};

/** Exact-request owner projection, not a native-history witness or permission.
 * Local replies commit their event, reply operation and final disposition in
 * one transaction before delivery. Read all three, including superseded events
 * and replies whose receipt never reached the caller. Bodies stay private.
 * No public request access or source authority is granted by this helper. */
export function readCodexRecoveryLogicalEffects(db:Database,input:{sessionId:number;inputId:string;requestId:string}){
  return db.transaction(()=>{
    const selected=db.query('SELECT * FROM session_inputs WHERE id=?').get(input.inputId) as any;
    const request=db.query('SELECT * FROM session_communication_requests WHERE request_id=?').get(input.requestId) as any;
    const reasons:string[]=[];
    const refuse=(code:string)=>{if(!reasons.includes(code))reasons.push(code);};
    if(!selected||!request||selected.session_id!==input.sessionId||selected.origin!=='service'
      ||selected.id!==`report-back:${input.requestId}`||selected.request_id!==input.requestId
      ||request.target_session_id!==input.sessionId||request.target_input_id!==selected.source_input_id
      ||parse(request.payload_json)?.requestedEffect!=='work')return {
        policy:'codex_recovery_logical_effects_v1' as const,diagnosticOnly:true as const,authorizesProviderStart:false as const,
        sessionId:input.sessionId,selectedInputId:input.inputId,requestId:input.requestId,state:'unproved' as const,
        reasons:['LOGICAL_EFFECT_EXACT_REQUEST_CUSTODY_UNPROVED'],eventCount:0,replyOperationCount:0,eventIds:[] as string[],
        snapshotDigest:digest({scope:input,reason:'LOGICAL_EFFECT_EXACT_REQUEST_CUSTODY_UNPROVED'})};
    const events=db.query('SELECT rowid AS ordinal,* FROM session_communication_events WHERE request_id=? ORDER BY rowid')
      .all(input.requestId) as any[];
    const replies=db.query("SELECT rowid AS ordinal,* FROM session_inputs WHERE request_id=? AND kind='reply' ORDER BY rowid")
      .all(input.requestId) as any[];
    const deliveries=events.map(event=>{
      const accepted=event.accepted_input_id?db.query('SELECT * FROM session_inputs WHERE id=?').get(event.accepted_input_id) as any:null;
      const turn=accepted?.turn_id?db.query('SELECT * FROM turns WHERE id=?').get(accepted.turn_id):null;
      const steering=accepted?.steering_id?db.query('SELECT * FROM turn_steering_messages WHERE id=?').get(accepted.steering_id):null;
      if(event.accepted_input_id&&!accepted)refuse('LOGICAL_REPLY_DELIVERY_CUSTODY_MISSING');
      if(accepted&&(accepted.session_id!==request.source_session_id||accepted.origin!=='service'
        ||accepted.source_input_id!==request.source_input_id))refuse('LOGICAL_REPLY_DELIVERY_IDENTITY_CONFLICT');
      if(accepted&&(accepted.id!==`return:${event.event_id}`||accepted.request_id!==input.requestId))
        refuse('LOGICAL_GROUPED_RETURN_RECONCILIATION_UNPROVED');
      return {eventId:event.event_id,accepted,turn,steering};
    });
    if(!request||request.outcome!==null||request.result_json!==null||request.status!=='admitted')
      refuse('LOGICAL_REQUEST_NOT_OUTSTANDING');
    // A superseded final is still an earlier effect requiring reconciliation.
    // Neither later supersession nor a null current disposition erases it.
    for(const event of events){
      const payload=parse(event.payload_json);
      if(!payload||!['progress','final','overdue'].includes(event.kind))refuse('LOGICAL_REPLY_EVENT_UNCLASSIFIED');
      if(event.kind==='final'||payload?.final===true)refuse('LOGICAL_REPLY_FINAL_EFFECT_PRESENT');
      if(event.status!=='received'||event.error!==null)refuse('LOGICAL_REPLY_DELIVERY_UNRECONCILED');
      if(event.kind==='progress'){
        const source=payload?.source;
        const accepted=source?.input_id?db.query('SELECT * FROM session_inputs WHERE id=?').get(source.input_id) as any:null;
        const turn=source?.run_id?db.query('SELECT * FROM turns WHERE native_run_id=? AND session_id=?')
          .get(source.run_id,input.sessionId) as any:null;
        if(!accepted||!turn||accepted.session_id!==input.sessionId||payload.responding_session_id!==`concierge:${input.sessionId}`
          ||turn.accepted_input_id!==accepted.id&&accepted.turn_id!==turn.id)
          refuse('LOGICAL_REPLY_SOURCE_IDENTITY_UNPROVED');
        if(source?.input_id===input.inputId)refuse('SELECTED_INPUT_PRIOR_REPLY_EFFECT_PRESENT');
      }
    }
    for(const reply of replies){
      const receipt=parse(reply.receipt_json),payload=parse(reply.payload_json);
      const event=events.find(event=>event.event_id===receipt?.eventId);
      if(reply.session_id!==input.sessionId||reply.origin!=='agent'||receipt?.state!=='completed'||!event
        ||payload?.sourceInputId!==reply.source_input_id||payload?.sourceRunId!==reply.source_run_id
        ||parse(event?.payload_json??null)?.source?.input_id!==reply.source_input_id
        ||parse(event?.payload_json??null)?.source?.run_id!==reply.source_run_id)
        refuse('LOGICAL_REPLY_OPERATION_UNRECONCILED');
      if(payload?.kind==='final')refuse('LOGICAL_REPLY_FINAL_EFFECT_PRESENT');
      if(reply.source_input_id===input.inputId)refuse('SELECTED_INPUT_PRIOR_REPLY_EFFECT_PRESENT');
    }
    // Exclude the selected receipt's mutable admission/result projection here;
    // those have independent immutable accounting in the recovery authorization.
    const selectedIdentity=selected?{id:selected.id,sessionId:selected.session_id,requestId:selected.request_id,
      sourceInputId:selected.source_input_id,sourceRunId:selected.source_run_id,payloadJson:selected.payload_json}:null;
    return {policy:'codex_recovery_logical_effects_v1' as const,diagnosticOnly:true as const,authorizesProviderStart:false as const,
      sessionId:input.sessionId,selectedInputId:input.inputId,requestId:input.requestId,
      state:reasons.length?'unproved' as const:'outstanding' as const,reasons,
      eventCount:events.length,replyOperationCount:replies.length,eventIds:events.map(event=>event.event_id),
      snapshotDigest:digest({selected:selectedIdentity,request:request??null,events,replies,deliveries})};
  })();
}
