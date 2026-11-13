import {createHash} from 'node:crypto';
import {db,getClaudePreferredModel,getSessionById} from './state';
import {isCodeEditTool,isThinkingModel} from './implementation-models';
import {nativeRunId,recordSessionEvent,sessionMetadata} from './session-inputs';
import {humanChoseThinkingModel} from './model-escalation-custody';

type GateInput={providerSessionId:string;sourceRunId?:string;providerTurnId?:string;providerModel?:string;providerAgentId?:string;ownerTurnId?:number;toolId:string;toolName:string;toolInput?:unknown};
type Running={id:number;session_id:number;accepted_input_id:string|null;provider_turn_id:string|null};
const name=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=256?value:null;
const editEvent=(turnId:number,toolId:string)=>`implementation-edit:${turnId}:${createHash('sha256').update(toolId).digest('hex')}`;

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
    WHERE session_id=? AND status IN ('running','delivering') ORDER BY id DESC LIMIT 2`).all(session.id) as Running[];
  const bound=getSessionById(session.id)!;
  const exact=input.providerTurnId?running.find(row=>input.providerTurnId===row.provider_turn_id):undefined;
  // The reported model decides whether a mismatched Codex turn is exempt; turn identity is needed only to count it.
  const mismatched=bound.provider_id==='codex'&&!!input.providerTurnId&&!exact;
  const parent=mismatched?(input.ownerTurnId?running.find(row=>input.ownerTurnId===row.id):running.length===1?running[0]:undefined):undefined;
  if(mismatched){
    if(!parent)return {hold:true,message:'Concierge cannot identify this Codex execution and model. Retry when its identity is available.'};
    const helperModel=name(input.providerModel);
    if(helperModel&&!isThinkingModel(helperModel)){
      const key=`implementation-helper-edit:${createHash('sha256').update(JSON.stringify([session.id,input.providerTurnId,input.toolId])).digest('hex')}`;
      db.transaction(()=>{
        if(!db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(key))
          recordSessionEvent({eventId:key,sessionId:session.id,inputId:parent.accepted_input_id,turnId:parent.id,
            kind:'implementation_helper_edit',payload:{providerTurnId:input.providerTurnId,toolId:input.toolId,model:helperModel}});
      })();
      return {hold:false,exempt:'codex-helper'};
    }
  }
  const turn=exact??parent??(!input.providerTurnId?running.find(row=>input.ownerTurnId===row.id)??(running.length===1?running[0]:null):null);
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
