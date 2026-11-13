import {createHash} from 'node:crypto';
import {db,getClaudePreferredModel,getSessionById} from './state';
import {isCodeEditTool,isThinkingModel} from './implementation-models';
import {nativeRunId,recordSessionEvent,sessionMetadata} from './session-inputs';
import {humanChoseThinkingModel} from './model-escalation-custody';

type GateInput={providerSessionId:string;sourceRunId?:string;providerTurnId?:string;providerModel?:string;providerAgentId?:string;ownerTurnId?:number;toolId:string;toolName:string;toolInput?:unknown};
type Running={id:number;session_id:number;accepted_input_id:string|null;provider_turn_id:string|null};
type HelperBinding={turn_id:number;accepted_input_id:string|null;provider_turn_id:string|null;payload_json:string;status:string;stop_requested_at:string|null;session_status:string;native_metadata_json:string};
const name=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=256?value:null;
const editEvent=(turnId:number,toolId:string)=>`implementation-edit:${turnId}:${createHash('sha256').update(toolId).digest('hex')}`;
const codexBindingEvent=(sessionId:number,providerTurnId:string)=>`implementation-codex-helper-binding:${createHash('sha256').update(JSON.stringify([sessionId,providerTurnId])).digest('hex')}`;

/** The owner is the sole counter writer; retries of one provider tool ID return the same decision. */
export function implementationEditDecision(input:GateInput):{hold:boolean;message?:string;edits?:number;exempt?:string}{
  if((!name(input.providerSessionId)&&!name(input.sourceRunId))||!name(input.toolId)||!name(input.toolName))return {hold:false};
  if(!isCodeEditTool(input.toolName,input.toolInput))return {hold:false};
  const session=(input.providerSessionId?db.query('SELECT id FROM sessions WHERE agent_session_uuid=? AND provider_id IN (\'claude-code\',\'codex\')')
    .get(input.providerSessionId) as {id:number}|null:null)
    ??(input.providerTurnId?db.query(`SELECT session.id FROM turns turn JOIN sessions session ON session.id=turn.session_id
      WHERE turn.provider_turn_id=? AND session.provider_id='codex' AND turn.status IN ('running','delivering') LIMIT 1`)
      .get(input.providerTurnId) as {id:number}|null:null)
    ??(input.sourceRunId?db.query(`SELECT session.id FROM turns turn JOIN sessions session ON session.id=turn.session_id
      WHERE turn.native_run_id=? AND session.provider_id='claude-code' AND turn.status IN ('running','delivering') LIMIT 1`)
      .get(input.sourceRunId) as {id:number}|null:null);
  if(!session)return {hold:false};
  const running=db.query(`SELECT id,session_id,accepted_input_id,provider_turn_id FROM turns
    WHERE session_id=? AND status IN ('running','delivering') AND stop_requested_at IS NULL ORDER BY id DESC LIMIT 2`).all(session.id) as Running[];
  const bound=getSessionById(session.id)!;
  const bindingKey=bound.provider_id==='codex'&&name(input.providerTurnId)?codexBindingEvent(session.id,input.providerTurnId):null;
  const binding=bindingKey?db.query(`SELECT event.turn_id,turn.status,turn.stop_requested_at,turn.accepted_input_id,turn.provider_turn_id,event.payload_json,session.status AS session_status,
      session.native_metadata_json
    FROM session_owner_events event JOIN turns turn ON turn.id=event.turn_id
    JOIN sessions session ON session.id=event.session_id
    WHERE event.event_id=? AND event.kind='implementation_codex_helper_binding' AND event.session_id=?`)
    .get(bindingKey,session.id) as HelperBinding|null:null;
  let retainedParent:Running|undefined;
  if(binding){
    const saved=JSON.parse(binding.payload_json) as {providerTurnId?:unknown;model?:unknown};
    const providerTurnId=name(input.providerTurnId);
    const retainedModel=name(input.providerModel);
    if(!providerTurnId||saved.providerTurnId!==providerTurnId||!retainedModel||saved.model!==retainedModel
      ||(input.ownerTurnId!==undefined&&input.ownerTurnId!==binding.turn_id)
      ||binding.stop_requested_at!==null||!['running','delivering','done'].includes(binding.status)
      ||binding.session_status==='archived'||sessionMetadata({native_metadata_json:binding.native_metadata_json} as any).suspended)
      return {hold:true,message:'Concierge cannot verify this Codex helper execution is still eligible. Retry when its identity is available.'};
    retainedParent={id:binding.turn_id,session_id:session.id,accepted_input_id:binding.accepted_input_id,provider_turn_id:binding.provider_turn_id};
    if(!isThinkingModel(retainedModel))
      return recordCodexHelperEdit(session.id,binding.turn_id,providerTurnId,input.toolId,retainedModel,binding.accepted_input_id);
  }
  const exact=input.providerTurnId?running.find(row=>input.providerTurnId===row.provider_turn_id):undefined;
  // The reported model decides whether a mismatched Codex turn is exempt; turn identity is needed only to count it.
  const mismatched=bound.provider_id==='codex'&&!!input.providerTurnId&&!exact;
  const parent=mismatched?(retainedParent??(input.ownerTurnId?running.find(row=>input.ownerTurnId===row.id):running.length===1?running[0]:undefined)):undefined;
  if(mismatched&&!binding){
    if(!parent)return {hold:true,message:'Concierge cannot identify this Codex execution and model. Retry when its identity is available.'};
    const helperModel=name(input.providerModel);
    if(!helperModel||bound.status==='archived'||sessionMetadata(bound).suspended)
      return {hold:true,message:'Concierge cannot identify this Codex execution and model. Retry when its identity is available.'};
    const parentState=db.query('SELECT status,stop_requested_at FROM turns WHERE id=?').get(parent.id) as {status:string;stop_requested_at:string|null}|null;
    if(!parentState||!['running','delivering'].includes(parentState.status)||parentState.stop_requested_at!==null)
      return {hold:true,message:'Concierge cannot identify this Codex execution and model. Retry when its identity is available.'};
    const key=bindingKey!;
    const existing=db.query("SELECT turn_id,payload_json FROM session_owner_events WHERE event_id=? AND kind='implementation_codex_helper_binding'")
      .get(key) as {turn_id:number;payload_json:string}|null;
    if(existing&&(existing.turn_id!==parent.id||JSON.parse(existing.payload_json).model!==helperModel))
      return {hold:true,message:'Concierge cannot verify this Codex helper execution is still eligible. Retry when its identity is available.'};
    db.transaction(()=>{
      if(!existing)recordSessionEvent({eventId:key,sessionId:session.id,inputId:parent.accepted_input_id,turnId:parent.id,
        kind:'implementation_codex_helper_binding',payload:{providerTurnId:input.providerTurnId,model:helperModel}});
    })();
    retainedParent=parent;
    if(!isThinkingModel(helperModel))
      return recordCodexHelperEdit(session.id,parent.id,input.providerTurnId!,input.toolId,helperModel,parent.accepted_input_id);
  }
  const turn=retainedParent??exact??parent??(!input.providerTurnId?running.find(row=>input.ownerTurnId===row.id)??(running.length===1?running[0]:null):null);
  if(!turn)return {hold:true,message:'Concierge cannot identify the active turn for this code edit. Retry when its owner is available.'};
  if(bound.provider_id==='claude-code'&&name(input.providerAgentId)){
    if((input.ownerTurnId&&input.ownerTurnId!==turn.id)||(input.sourceRunId&&input.sourceRunId!==nativeRunId(turn.id)))
      return {hold:true,message:'Concierge cannot identify the active turn for this Claude helper edit. Retry when its owner is available.'};
    const key=`implementation-helper-edit:${createHash('sha256').update(JSON.stringify([session.id,turn.id,input.providerAgentId,input.toolId])).digest('hex')}`;
    db.transaction(()=>{
      if(!db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(key))
        recordSessionEvent({eventId:key,sessionId:session.id,inputId:turn.accepted_input_id,turnId:turn.id,
          kind:'implementation_helper_edit',payload:{providerAgentId:input.providerAgentId,toolId:input.toolId}});
    })();
    return {hold:false,exempt:'claude-helper'};
  }
  const meta=sessionMetadata(bound);
  const model=bound.provider_id==='claude-code'
    ?getClaudePreferredModel(session.id,turn.id)??meta.model:meta.model;
  if(!isThinkingModel(model))return {hold:false,exempt:'lower-tier'};
  if(meta.implementationFor)return {hold:false,exempt:'implementation-worker'};
  const creation=db.query("SELECT source_input_id FROM session_inputs WHERE session_id=? AND kind='create' ORDER BY rowid LIMIT 1")
    .get(session.id) as {source_input_id:string|null}|null;
  if(meta.explicitThinkingModelChoice===model||humanChoseThinkingModel(creation?.source_input_id??undefined,model!)
    ||humanChoseThinkingModel(turn.accepted_input_id??undefined,model!))
    return {hold:false,exempt:'human-model-choice'};
  return db.transaction(()=>{
    const key=editEvent(turn.id,input.toolId);
    if(db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(key))return {hold:false,exempt:'already-counted'};
    const edits=(db.query("SELECT COUNT(*) AS count FROM session_owner_events WHERE turn_id=? AND kind='implementation_edit'").get(turn.id) as {count:number}).count;
    const reason=db.query("SELECT json_extract(payload_json,'$.reason') AS reason FROM session_owner_events WHERE turn_id=? AND kind='implementation_top_model_reason' LIMIT 1")
      .get(turn.id) as {reason:string}|null;
    const handoff=db.query(`SELECT 1 FROM session_communication_requests request
      JOIN session_inputs target ON target.id=request.target_input_id AND target.session_id=request.target_session_id
      JOIN turns execution ON execution.id=target.turn_id AND execution.session_id=request.target_session_id
      WHERE request.source_turn_id=? AND request.source_session_id=?
        AND json_extract(request.payload_json,'$.implementation')=1
        AND request.status NOT IN ('failed','uncertain','canceled')
        AND (request.outcome IS NULL OR request.outcome='answered')
        AND execution.status NOT IN ('failed','cancelled') LIMIT 1`).get(turn.id,session.id);
    if(edits>=4&&!reason&&!handoff){
      const source=turn.accepted_input_id;
      const sourceFlags=source?`--source-input ${source} --source-run ${nativeRunId(turn.id)}`:'--source-input <this input> --source-run <this run>';
      const holdId=createHash('sha256').update(JSON.stringify([model,edits])).digest('hex');
      recordSessionEvent({eventId:`implementation-edit-hold:${turn.id}:${holdId}`,sessionId:session.id,inputId:source,turnId:turn.id,
        kind:'implementation_edit_hold',payload:{model,afterEdits:edits}});
      return {hold:true,edits,message:`The fifth code edit is held. If the design is fixed, hand implementation to a cheaper session: router-actions.sh sessions implement --project <registered-project> --session-name "<task>" --summary "<acceptance criterion>" ${sourceFlags} --action-id <stable-id> -- <fixed design>. To continue here, state why this turn still needs ${model}: router-actions.sh sessions edit-reason --reason "<specific reason>" ${sourceFlags} --action-id top-edit-${turn.id}. Retry the edit after that command. The designer reviews the implementer's result.`};
    }
    recordSessionEvent({eventId:key,sessionId:session.id,inputId:turn.accepted_input_id,turnId:turn.id,
      kind:'implementation_edit',payload:{toolId:input.toolId,model}});
    return {hold:false,edits:edits+1};
  })();
}

function recordCodexHelperEdit(sessionId:number,turnId:number,providerTurnId:string,toolId:string,model:string,inputId:string|null){
  if(!isThinkingModel(model)){
    const key=`implementation-helper-edit:${createHash('sha256').update(JSON.stringify([sessionId,providerTurnId,toolId])).digest('hex')}`;
    db.transaction(()=>{
      if(!db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(key))
        recordSessionEvent({eventId:key,sessionId,inputId,turnId,kind:'implementation_helper_edit',payload:{providerTurnId,toolId,model}});
    })();
    return {hold:false,exempt:'codex-helper'};
  }
  return {hold:true,message:'Concierge cannot identify the active turn for this code edit. Retry when its owner is available.'};
}

export function recordImplementationEditReason(turnId:number,sessionId:number,inputId:string,reason:string,actionId:string){
  const text=reason.trim();
  if(text.length<8||text.length>1000)throw new Error('State a specific reason this turn still needs its thinking model (8–1000 characters).');
  const prior=db.query("SELECT payload_json FROM session_owner_events WHERE turn_id=? AND kind='implementation_top_model_reason' LIMIT 1")
    .get(turnId) as {payload_json:string}|null;
  if(prior){const saved=JSON.parse(prior.payload_json);
    if(saved.reason!==text)throw new Error('This turn already recorded a different reason; use the one you gave.');
    return {turnId,reason:text,recorded:true};}
  recordSessionEvent({eventId:`implementation-top-model-reason:${turnId}`,sessionId,inputId,turnId,
    kind:'implementation_top_model_reason',payload:{reason:text,actionId}});
  return {turnId,reason:text,recorded:true};
}
