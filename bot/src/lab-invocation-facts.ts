import {db,getSessionById} from './state';
import {getAcceptedSessionInput,nativeRunId,sessionMetadata,type AcceptedSessionInput} from './session-inputs';

const action=(scope:string,id:string)=>db.query('SELECT * FROM session_inputs WHERE scope=? AND action_id=?').get(scope,id) as AcceptedSessionInput|null;
const labBindingFields=['sessionId','provider','model','reasoningEffort','project','projectPath','generation'] as const;
export function retainedLabMembership(input:AcceptedSessionInput):any {
 const {binding}=JSON.parse(input.payload_json);
 if(input.kind==='lab-conversation'&&binding&&binding.membershipRevision===undefined)return {...binding,membershipRevision:1};
 return binding;
}
export function activationBinding(input:AcceptedSessionInput):any {
 const payload=JSON.parse(input.payload_json);
 return payload.binding??retainedLabMembership(getAcceptedSessionInput(payload.membershipInputId??payload.conversationInputId)!);
}
export function boundLabInvocation(input:AcceptedSessionInput):boolean {
 if(input.origin!=='service'||input.kind!=='input'||input.scope!=='lab:invocation'||!input.request_id||!input.source_input_id)return false;
 const binding=action('lab:binding',input.request_id),parent=getAcceptedSessionInput(input.source_input_id),payload=JSON.parse(input.payload_json);
 return !!binding&&binding.source_input_id===parent?.id&&binding.session_id===input.session_id&&parent?.kind==='lab-activation'
  &&payload.labInvocation?.requestId===input.request_id&&payload.labInvocation?.thread===JSON.parse(parent.payload_json).thread;
}
export function labInvocationBindingMatches(input:AcceptedSessionInput):boolean {
 if(!boundLabInvocation(input))return false;
 const member=activationBinding(getAcceptedSessionInput(input.source_input_id!)!).participants.find((value:any)=>value.sessionId===`concierge:${input.session_id}`);
 const session=getSessionById(input.session_id),metadata=session?sessionMetadata(session):null;
 return !!member&&!!session&&session.status!=='archived'&&!metadata?.suspended&&session.provider_id===member.provider&&(session.binding_generation??1)===member.generation
  &&(metadata?.model??null)===member.model&&(metadata?.reasoningEffort??null)===member.reasoningEffort&&(metadata?.project??null)===member.project&&(metadata?.projectPath??null)===member.projectPath;
}
/** Find the membership that selected this voice, even after unrelated roster changes. */
export function labInvocationSelection(input:AcceptedSessionInput,model:string):{membership:AcceptedSessionInput;key:string}|null {
 if(!labInvocationBindingMatches(input))return null;
 const activation=getAcceptedSessionInput(input.source_input_id!)!,source=JSON.parse(activation.payload_json);
 const selected=JSON.parse(input.payload_json).labInvocation;
 const binding=activationBinding(activation);
 const member=binding.participants.find((value:any)=>value.key===selected.key);
 const legacy=binding.membershipRevision===1&&source.membershipInputId===undefined
   &&source.membershipRevision===undefined&&(selected.membershipRevision===undefined||selected.membershipRevision===1);
 const revisionAtActivation=binding.membershipRevision;
 if(!member||member.sessionId!==`concierge:${input.session_id}`||member.provider!=='codex'||member.model!==model
   ||!Array.isArray(source.targets)||!source.targets.includes(member.key)
   ||!legacy&&(selected.membershipRevision!==revisionAtActivation||source.membershipRevision!==revisionAtActivation))return null;
 let membershipId=source.membershipInputId??source.conversationInputId;
 for(let revision=revisionAtActivation;revision>=1&&typeof membershipId==='string';revision--){
   const membership=getAcceptedSessionInput(membershipId);
   if(!membership)return null;
   const retained=JSON.parse(membership.payload_json),roster=retainedLabMembership(membership);
   if(roster?.thread!==source.thread||roster.membershipRevision!==revision)return null;
   const prior=roster.participants.find((value:any)=>value.key===member.key);
   if(!prior||labBindingFields.some(key=>prior[key]!==member[key]))return null;
   if(revision===1)return membership.kind==='lab-conversation'&&membership.id===source.conversationInputId?{membership,key:member.key}:null;
   if(membership.kind!=='lab-roster'||retained.conversationInputId!==source.conversationInputId)return null;
   if(retained.added?.includes(member.sessionId))return {membership,key:member.key};
   membershipId=retained.previousMembershipInputId;
 }
 return null;
}
export type ComparisonContext={version:1;thread:string;requestId:string;independent:boolean;openingOnly:boolean};
export function comparisonContext(input:AcceptedSessionInput):ComparisonContext|null {
 if(input.scope!=='lab:invocation'){
  const turnId=input.turn_id??(input.steering_id?(db.query('SELECT turn_id FROM turn_steering_messages WHERE id=?').get(input.steering_id) as any)?.turn_id:null);
  const acceptedId=turnId?(db.query('SELECT accepted_input_id FROM turns WHERE id=? AND session_id=?').get(turnId,input.session_id) as any)?.accepted_input_id:null;
  const original=acceptedId&&acceptedId!==input.id?getAcceptedSessionInput(acceptedId):null;
  return original?.scope==='lab:invocation'?comparisonContext(original):null;
 }
 if(!boundLabInvocation(input))throw new Error('LAB_INVOCATION_UNCONFIRMED');
 const parent=getAcceptedSessionInput(input.source_input_id!)!,payload=JSON.parse(parent.payload_json);
 const turn=input.turn_id===null?null:db.query('SELECT * FROM turns WHERE id=? AND accepted_input_id=? AND session_id=?').get(input.turn_id,input.id,input.session_id) as any;
 const admission=JSON.parse(input.receipt_json??'{}').admission;
 const proof=turn?db.query("SELECT payload_json FROM session_owner_events INDEXED BY session_owner_events_turn_kind WHERE turn_id=? AND kind='lab_binding_verified' AND input_id=? ORDER BY sequence DESC LIMIT 1").get(turn.id,input.id) as {payload_json:string}|null:null;
 const member=activationBinding(parent).participants.find((value:any)=>value.sessionId===`concierge:${input.session_id}`),verified=proof?JSON.parse(proof.payload_json):null;
 if(!turn||!turn.provider_admission_intended_at||!member||!verified||!['provider','model','reasoningEffort','project','projectPath','generation'].every(key=>verified[key]===member[key])
  ||admission?.inputId!==input.id||admission?.runId!==nativeRunId(turn.id)||admission?.provider!==member.provider||admission?.model!==member.model||admission?.bindingGeneration!==member.generation)
  throw new Error('LAB_INVOCATION_UNCONFIRMED');
 return {version:1,thread:payload.thread,requestId:input.request_id!,independent:payload.independent===true,
  openingOnly:payload.independent===true&&!['done','error','cancelled'].includes(turn.status)};
}
