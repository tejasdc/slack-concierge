import assert from 'node:assert/strict';
import {proveAcceptedBindingContinuation,type AcceptedBindingContinuationSnapshot,
  type ContinuationInput,type ContinuationTurn} from '../src/codex-accepted-binding-continuation';

const binding={sessionId:8245,provider:'codex',threadId:'same-retained-thread',generation:1,
  model:'gpt-6-astra',effort:'medium',runner:'ax41'};
const retained=(id:string,ordinal:number,turnId:number|null,patch:Partial<ContinuationInput>={}):ContinuationInput=>({
  id,ordinal,session_id:8245,kind:'request',origin:'agent',turn_id:turnId,steering_id:null,
  request_id:null,source_input_id:null,source_run_id:null,payload_json:'{}',receipt_json:null,...patch});
const turn=(id:number,inputId:string,acknowledged:boolean):ContinuationTurn=>({id,session_id:8245,
  accepted_input_id:inputId,native_run_id:`run:${id}`,dispatch_attempt:1,status:'done',
  provider_input_acknowledged_at:acknowledged?'retained-acknowledgement':null,stop_requested_at:null});
const admission=(inputId:string,turnId:number)=>({provider:'codex',inputId,runId:`run:${turnId}`,
  bindingGeneration:1,model:'gpt-6-astra',nativeBinding:null});
const create=retained('request:create',1,10,{kind:'create',
  payload_json:JSON.stringify({provider:'codex',model:'gpt-6-astra',reasoningEffort:'medium'}),
  receipt_json:JSON.stringify({admission:admission('request:create',10)})});
const source=retained('request:work',4,20,{request_id:'work'});
const selected=retained('report-back:work',8,30,{origin:'service',request_id:'work',
  source_input_id:source.id,source_run_id:'run:20',payload_json:JSON.stringify({text:'private retained reminder'}),
  receipt_json:JSON.stringify({admission:admission('report-back:work',30)})});
// One later informational admission and one never-admitted input. Both must be
// accounted for without treating text overlap as an ordering decision.
const later=retained('request:later-info',11,40,{receipt_json:JSON.stringify({state:'failed'})});
const neverAdmitted=retained('action:later-no-turn',15,null,{kind:'action'});
const make=():AcceptedBindingContinuationSnapshot=>({binding:{...binding},
  creation:{input:structuredClone(create),turn:turn(10,create.id,true)},
  source:{input:structuredClone(source),turn:turn(20,source.id,true)},
  selected:{input:structuredClone(selected),turn:turn(30,selected.id,false)},
  request:{request_id:'work',target_session_id:8245,target_input_id:source.id,outcome:null,
    payload_json:JSON.stringify({requestedEffect:'work'})},
  creationBinding:{reference:'retained-create-native-result',binding:{...binding}},
  selectedBinding:{reference:'retained-selected-native-attempt',binding:{...binding}},
  events:[{event_id:'prompt-cache-identity:30:1',session_id:8245,input_id:null,turn_id:30,
    kind:'prompt_cache_identity',payload_json:JSON.stringify({effort:'medium'})}],
  controls:{reference:'current-owner-controls:15',outside:false,suspended:false,archived:false,
    consultationOnly:false,stopRequested:false,activeHandoffIds:[]},
  interval:{complete:true,fromOrdinal:8,throughOrdinal:15,inputs:structuredClone([selected,later,neverAdmitted]),
    classifications:[{inputId:selected.id,reference:'selected-input:8',significance:'selected'},
      {inputId:later.id,reference:'exact-later-input-effects:11',significance:'neutral'},
      {inputId:neverAdmitted.id,reference:'exact-nondispatched-action:15',significance:'neutral'}],
    mutationCoverage:{complete:true,reference:'owner-mutation-history:1:15',fromInputId:create.id,changes:[]},
    fifo:{complete:true,reference:'scheduler-queue:15',selectedInputId:selected.id,runnablePredecessorInputIds:[]}},
  ownerSnapshot:{earlierTerminalReminderIds:['report-back:earlier-work'],activeTurns:[],
    retainedObligations:[{requestId:'original-writing-request',state:'open',custodian:8245}],
    steering:[],pendingDelivery:[]}});

const initial=make(),original=JSON.stringify(initial),proof=proveAcceptedBindingContinuation(initial);
assert.equal(proof.proven,true,'legacy omitted effort and null nativeBinding work with independent exact binding witnesses');
assert.equal(proof.basis,'accepted_binding_continuation');
assert.equal(proof.identity.binding.effort,'medium');
assert.equal(proof.identity.sourceInputId,source.id);
assert.equal(proof.authorizesProviderStart,false,'factual continuation never substitutes for native coverage or reservation');
assert.equal(proof.diagnosticOnly,true);
assert.equal(JSON.stringify(initial),original,'pure proof preserves all input bytes, earlier reminders and original obligations');
assert.equal(proveAcceptedBindingContinuation(make()).decisionDigest,proof.decisionDigest);
assert.ok(!JSON.stringify(proof).includes('private retained reminder'),'the diagnostic emits references, never retained prompt bytes');
assert.ok(!JSON.stringify(proof).includes('explicit human model choice'));
assert.ok(!JSON.stringify(proof).includes('explicitThinkingModelChoice'));

function refuses(code:string,mutate:(snapshot:AcceptedBindingContinuationSnapshot)=>void){
  const snapshot=make();mutate(snapshot);
  const actual=proveAcceptedBindingContinuation(snapshot);
  assert.equal(actual.proven,false,code);
  assert.ok(actual.reasons.some(reason=>reason.code===code),`${code}: ${JSON.stringify(actual.reasons)}`);
  assert.notEqual(actual.decisionDigest,proof.decisionDigest,'different evidence cannot reuse the decision digest');
}
refuses('ACKNOWLEDGED_CREATION_BINDING_NOT_PROVEN',s=>{s.creation.turn.provider_input_acknowledged_at=null;});
refuses('ACKNOWLEDGED_CREATION_BINDING_NOT_PROVEN',s=>{s.creation.input.payload_json=JSON.stringify({provider:'codex',model:'gpt-6-astra'});});
refuses('CREATION_NATIVE_BINDING_NOT_PROVEN',s=>{s.creationBinding=null;});
refuses('SELECTED_NATIVE_BINDING_NOT_PROVEN',s=>{s.selectedBinding!.binding.threadId='another-thread';});
refuses('SELECTED_NATIVE_BINDING_NOT_PROVEN',s=>{s.selectedBinding!.binding.runner='another-runner';});
refuses('SELECTED_NATIVE_BINDING_NOT_PROVEN',s=>{s.selectedBinding!.binding.generation=2;});
refuses('PRESERVED_ACCEPTED_BINDING_NOT_PROVEN',s=>{s.binding.effort='unknown-effort';});
refuses('PRESERVED_ACCEPTED_BINDING_NOT_PROVEN',s=>{s.binding.model='unrelated-new-top-model';});
const high=make();
high.binding.effort='high';high.creationBinding!.binding.effort='high';high.selectedBinding!.binding.effort='high';
high.creation.input.payload_json=JSON.stringify({provider:'codex',model:'gpt-6-astra',reasoningEffort:'high'});
high.events[0]!.payload_json=JSON.stringify({effort:'high'});
assert.equal(proveAcceptedBindingContinuation(high).proven,true,'another accepted effort is preserved rather than upgraded or defaulted');
refuses('ACKNOWLEDGED_SOURCE_CUSTODY_NOT_PROVEN',s=>{s.source.turn.provider_input_acknowledged_at=null;});
refuses('ACKNOWLEDGED_SOURCE_CUSTODY_NOT_PROVEN',s=>{s.selected.input.source_run_id='wrong-source-run';});
refuses('EXACT_UNACKNOWLEDGED_SERVICE_INPUT_NOT_PROVEN',s=>{s.selected.turn.provider_input_acknowledged_at='observed';});
refuses('EXACT_SELECTED_EFFORT_NOT_PROVEN',s=>{s.events=[];});
refuses('EXACT_SELECTED_EFFORT_NOT_PROVEN',s=>{s.events[0]!.event_id='prompt-cache-identity:30:2';});
refuses('EXACT_SELECTED_EFFORT_NOT_PROVEN',s=>{s.events[0]!.payload_json=JSON.stringify({effort:'xhigh'});});
refuses('EXACT_SELECTED_EFFORT_NOT_PROVEN',s=>{s.selected.input.receipt_json=JSON.stringify({admission:{...admission(selected.id,30),reasoningEffort:'xhigh'}});});
refuses('OPEN_WORK_CUSTODY_NOT_PROVEN',s=>{s.request.outcome='completed';});
refuses('CURRENT_SEND_CONTROL_REFUSES',s=>{s.controls.suspended=true;});
refuses('CURRENT_SEND_CONTROL_REFUSES',s=>{s.controls.activeHandoffIds=['transfer-in-progress'];});
refuses('BINDING_CONTROL_CUSTODY_HISTORY_INCOMPLETE',s=>{s.interval.mutationCoverage.complete=false;});
for(const kind of ['binding','control','custody'] as const)
  refuses('BINDING_CONTROL_OR_CUSTODY_CHANGED',s=>{s.interval.mutationCoverage.changes.push({kind,reference:`retained-${kind}-change`});});
const reconciled=make();
reconciled.interval.mutationCoverage.changes.push({kind:'control',reference:'old-pause',reconciledBy:'exact-owner-resume'});
assert.equal(proveAcceptedBindingContinuation(reconciled).proven,true,
  'a prior pause with exact owner reconciliation is not a permanent refusal');
refuses('BINDING_CONTROL_OR_CUSTODY_CHANGED',s=>{s.interval.mutationCoverage.changes.push({kind:'binding',reference:'changed-native-binding',reconciledBy:'later-idle'});});
refuses('COMPLETE_ACCEPTED_INPUT_INTERVAL_NOT_PROVEN',s=>{s.interval.inputs.pop();});
refuses('COMPLETE_ACCEPTED_INPUT_INTERVAL_NOT_PROVEN',s=>{s.interval.complete=false;});
refuses('ACCEPTED_INPUT_CLASSIFICATION_INCOMPLETE',s=>{s.interval.classifications.pop();});
for(const significance of ['control','custody','ordering','unknown'] as const)
  refuses('ACCEPTED_INPUT_CHANGES_CONTROL_CUSTODY_OR_ORDER',s=>{s.interval.classifications[2]!.significance=significance;});
refuses('ACTUAL_FIFO_WITNESS_MISSING',s=>{s.interval.fifo.complete=false;});
refuses('RUNNABLE_FIFO_PREDECESSOR_PRESENT',s=>{s.interval.fifo.runnablePredecessorInputIds=['report-back:earlier-work'];});

const changed=make();
(changed.ownerSnapshot as any).retainedObligations[0].custodian=8866;
assert.notEqual(proveAcceptedBindingContinuation(changed).snapshotDigest,proof.snapshotDigest,
  'even unprojected obligation custody bytes participate in the inspected snapshot digest');
const neverAdmittedChanged=make();neverAdmittedChanged.interval.inputs[2]!.payload_json='{"action":"pause"}';
assert.notEqual(proveAcceptedBindingContinuation(neverAdmittedChanged).snapshotDigest,proof.snapshotDigest,
  'never-admitted action bytes invalidate a previously inspected snapshot');
console.log('Accepted binding continuation: Astra/Medium legacy evidence, exact source, complete accepted interval, controls/custody/FIFO and digest refusals passed');
