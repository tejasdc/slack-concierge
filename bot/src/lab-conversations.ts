import {createHash} from 'node:crypto';
import {db,getSessionById,executionChanged,type ProviderId} from './state';
import {createNativeSession,getAcceptedSessionInput,retainSessionInput,recordSessionEvent,sessionMetadata,stablePayload,type AcceptedSessionInput,type NativeSessionMetadata} from './session-inputs';
import {agentIdentity} from './session-presence';
import {topModel} from './model-escalation';

export class LabConversationError extends Error {
  constructor(message:string,readonly status=400,readonly code='LAB_CONVERSATION_REFUSED'){super(message);}
}
export type LabParticipantChoice={key:string;label:string;sessionId?:string;provider?:string;model?:string;reasoningEffort?:string;project?:string;sources?:unknown[];escalationReason?:string;instructions?:string};
export type LabParticipant={key:string;label:string;agentName:string|null;sessionId:string;provider:string;model:string|null;reasoningEffort:string|null;project:string|null;projectPath:string|null;generation:number;existing:boolean;sources:unknown[];instructions:string|null;tools:'none'|'native'};
export type LabContext={version:1;thread:string;entryId:string;sessionId:string;entries:Array<{id:string;revision?:string;address?:string;author?:unknown;text:string}>;responseTargets?:string[];[key:string]:unknown};
type Invocation={key:string;requestId:string;inputId:string;state:'context_pending'|'accepted'|'published'|'failed'|'refused';context?:LabContext;eventId?:string;publication?:unknown;error?:string};
type ActionReceipt={state:'pending'|'completed';invocations:Invocation[];entries?:LabContext['entries']};
type Conversation={thread:string;questionEntryId:string;coordinatorSessionId:string;participants:LabParticipant[];opening:LabContext['entries'][number]};
export type LabActor={inputId:string;runId:string;sessionId:number};
export type LabPreparedParticipant={choice:LabParticipantChoice;sessionId?:number;provider?:ProviderId;metadata?:NativeSessionMetadata};
export type LabConversationPorts={
  bootstrap(thread:string):Promise<{version:1;state:{owner:string;[key:string]:unknown};entries:LabContext['entries']}>;
  prepare(choice:LabParticipantChoice,actor?:LabActor):Promise<LabPreparedParticipant>;
  sources(references:unknown[]):Promise<Array<{reference:unknown;text:string;sha256:string}>>;
  bind(thread:string,signal:AbortSignal):Promise<unknown>;
  context(input:{thread:string;entryId:string;sessionId:string;requestId:string;independent:boolean;signal:AbortSignal}):Promise<LabContext>;
  publish(input:{thread:string;requestId:string;eventId:string;signal:AbortSignal}):Promise<unknown>;
  dispatch(input:AcceptedSessionInput):unknown;
  available?(sessionId:number):boolean;
  wake():void;
};
const digest=(value:unknown)=>createHash('sha256').update(stablePayload(value)).digest('hex');
const sessionNumber=(value:string)=>{if(!/^concierge:[1-9][0-9]*$/.test(value))throw new LabConversationError('Choose an exact session on this Concierge instance.');return Number(value.slice(10));};
const object=(value:unknown):Record<string,any>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new LabConversationError('A Lab conversation action is required.');return value as Record<string,any>;};
function only(input:Record<string,any>,fields:string[]){if(Object.keys(input).some(key=>!fields.includes(key)))throw new LabConversationError('Unknown Lab conversation field.');}
function identifier(value:unknown,label:string){if(typeof value!=='string'||!value.trim()||value.length>200)throw new LabConversationError(`${label} is required.`);return value;}
function receipt(input:AcceptedSessionInput):ActionReceipt{return JSON.parse(input.receipt_json??'{"state":"pending","invocations":[]}');}
const readAction=(scope:string,actionId:string)=>db.query('SELECT * FROM session_inputs WHERE scope=? AND action_id=?').get(scope,actionId) as AcceptedSessionInput|null;

/** A service notice cannot opt itself into model execution by carrying a label. */
export function boundLabInvocation(input:AcceptedSessionInput):boolean {
  if(input.origin!=='service'||input.kind!=='input'||input.scope!=='lab:invocation'||!input.request_id||!input.source_input_id)return false;
  const binding=readAction('lab:binding',input.request_id),action=getAcceptedSessionInput(input.source_input_id),payload=JSON.parse(input.payload_json);
  return !!binding&&binding.source_input_id===action?.id&&binding.session_id===input.session_id&&action?.kind==='lab-activation'
    &&payload.labInvocation?.requestId===input.request_id&&payload.labInvocation?.thread===JSON.parse(action.payload_json).thread;
}
export function labInvocationBindingMatches(input:AcceptedSessionInput):boolean {
  if(!boundLabInvocation(input))return false;
  const action=getAcceptedSessionInput(input.source_input_id!)!,activation=JSON.parse(action.payload_json),conversation=getAcceptedSessionInput(activation.conversationInputId);
  const member=conversation?JSON.parse(conversation.payload_json).binding.participants.find((value:LabParticipant)=>value.sessionId===`concierge:${input.session_id}`):null;
  const session=getSessionById(input.session_id),metadata=session?sessionMetadata(session):null;
  return !!member&&!!session&&session.status!=='archived'&&!metadata?.suspended&&session.provider_id===member.provider&&(session.binding_generation??1)===member.generation
    &&(metadata?.model??null)===member.model&&(metadata?.reasoningEffort??null)===member.reasoningEffort&&(metadata?.project??null)===member.project&&(metadata?.projectPath??null)===member.projectPath;
}

/** Typed Lab invocations share the existing accepted-input ledger and execution queue. */
export class LabConversations {
  private after='';
  private pass:Promise<boolean>|null=null;
  private abort=new AbortController();
  start(){if(this.abort.signal.aborted)this.abort=new AbortController();}
  stop(){this.abort.abort();}
  private observe<T>(work:Promise<T>):Promise<T>{
    const signal=this.abort.signal;
    if(signal.aborted)return Promise.reject(new LabConversationError('Lab observation stopped; the retained invocation remains pending.',503,'LAB_OBSERVATION_STOPPED'));
    return new Promise<T>((resolve,reject)=>{
      const abort=()=>reject(new LabConversationError('Lab observation stopped; the retained invocation remains pending.',503,'LAB_OBSERVATION_STOPPED'));
      signal.addEventListener('abort',abort,{once:true});
      work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    });
  }
  constructor(private readonly ports:LabConversationPorts){}
  private conversation(thread:string){
    const input=readAction('lab:conversation',thread);
    if(!input)throw new LabConversationError('This Lab thread has no comparison conversation.',404,'LAB_CONVERSATION_NOT_FOUND');
    return {input,binding:JSON.parse(input.payload_json).binding as Conversation};
  }
  private saveReceipt(input:AcceptedSessionInput,value:ActionReceipt){
    db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify(value),input.id);
  }
  async create(body:unknown,actor?:LabActor){
    const input=object(body);only(input,['clientActionId','thread','coordinatorSessionId','questionEntryId','participants','agentSource']);
    const action=identifier(input.clientActionId,'Stable action identity'),thread=identifier(input.thread,'Lab thread'),entryId=identifier(input.questionEntryId,'Opening question entry');
    const prior=readAction('lab:conversation',thread);
    if(prior){this.checkRetry(prior,input,actor);return this.view(thread);}
    if(!Array.isArray(input.participants)||!input.participants.length||input.participants.length>16)throw new LabConversationError('Choose between one and sixteen participants.');
    const choices=input.participants.map((value:unknown)=>{
      const choice=object(value);only(choice,['key','label','sessionId','provider','model','reasoningEffort','project','sources','escalationReason','instructions']);
      if(choice.instructions!==undefined&&(typeof choice.instructions!=='string'||choice.instructions.length>20_000))throw new LabConversationError('Participant instructions must be text of at most 20,000 characters.');
      identifier(choice.key,'Participant key');identifier(choice.label,'Participant label');
      if(choice.key==='coordinator'||!/^[-a-zA-Z0-9_]+$/.test(choice.key))throw new LabConversationError('Choose a unique participant key; coordinator is reserved.');
      if(!!choice.sessionId===!!choice.provider)throw new LabConversationError('Choose either an existing session or an explicit provider.');
      if(choice.sessionId&&['provider','model','reasoningEffort','project'].some(key=>choice[key]!==undefined))throw new LabConversationError('An existing participant keeps its provider, model, effort and project.');
      if(choice.sources!==undefined&&(!Array.isArray(choice.sources)||choice.sources.length>32))throw new LabConversationError('Sources must be a bounded list of exact references.');
      for(const source of choice.sources??[]){const ref=object(source);only(ref,['sourceId','sourceVersion','branch','eventId']);for(const key of ['sourceId','sourceVersion','branch','eventId'])identifier(ref[key],`Source ${key}`);if(!/^[a-f0-9]{64}$/.test(ref.sourceVersion))throw new LabConversationError('A selected source needs its exact retained version digest.');}
      return choice as LabParticipantChoice;
    });
    if(new Set(choices.map((choice:LabParticipantChoice)=>choice.key)).size!==choices.length)throw new LabConversationError('Participant keys must be unique.');
    const bootstrap=await this.ports.bootstrap(thread),opening=bootstrap.entries.find(entry=>entry.id===entryId);
    if(bootstrap.version!==1||bootstrap.entries.length!==1||!opening)throw new LabConversationError('Choose the exact opening question of this Lab thread.',409,'LAB_QUESTION_MISMATCH');
    const author=bootstrap.state.owner;
    const authorSession=/^concierge:[1-9][0-9]*$/.test(author)?author:null;
    if(authorSession&&input.coordinatorSessionId&&input.coordinatorSessionId!==authorSession)throw new LabConversationError('The existing Lab thread author coordinates this conversation.',409,'LAB_COORDINATOR_MISMATCH');
    if(author!=='tejas'&&!authorSession)throw new LabConversationError('This Lab thread belongs to another Concierge instance; start the comparison through that instance.',409,'LAB_COORDINATOR_MACHINE_MISMATCH');
    const prepared=await Promise.all(choices.map((choice:LabParticipantChoice)=>this.ports.prepare(choice,actor)));
    const selectedCoordinator=authorSession??input.coordinatorSessionId;
    const coordinator=await this.ports.prepare({key:'coordinator',label:'Thread coordinator',...(selectedCoordinator?{sessionId:selectedCoordinator}:{provider:'auto',project:'agent-ecology'})},actor);
    // Resolve projects before the transaction; no HTTP or provider work belongs inside it.
    db.transaction(()=>{
      const raced=readAction('lab:conversation',thread);if(raced){this.checkRetry(raced,input,actor);return;}
      const bind=(member:LabPreparedParticipant):LabParticipant=>{
        const row=member.sessionId?getSessionById(member.sessionId):createNativeSession(member.provider!,{summary:undefined,...member.metadata!});
        if(!row)throw new LabConversationError('The selected participant no longer exists.',404);
        const metadata=sessionMetadata(row);
        return {key:member.choice.key,label:member.choice.label,agentName:agentIdentity(row,metadata).agentName,sessionId:`concierge:${row.id}`,provider:row.provider_id,model:metadata.model??null,reasoningEffort:metadata.reasoningEffort??null,
          project:metadata.project??null,projectPath:metadata.projectPath??null,generation:row.binding_generation??1,existing:!!member.sessionId,sources:member.choice.sources??[],instructions:member.choice.instructions??null,tools:row.provider_id==='chatgpt'?'none':'native'};
      };
      const participants=prepared.map(bind),coordinatorBinding=bind(coordinator);
      if(new Set(participants.map(member=>member.sessionId)).size!==participants.length||participants.some(member=>member.sessionId===coordinatorBinding.sessionId))throw new LabConversationError('Each voice and the coordinator need distinct sessions.');
      const binding:Conversation={thread,questionEntryId:entryId,coordinatorSessionId:coordinatorBinding.sessionId,participants:[coordinatorBinding,...participants],opening};
      const saved=retainSessionInput({sessionId:sessionNumber(binding.coordinatorSessionId),scope:'lab:conversation',actionId:thread,kind:'lab-conversation',origin:actor?'agent':'human',
        payload:{request:input,binding,...(actor?{actor}:{})},...(actor?{sourceInputId:actor.inputId,sourceRunId:actor.runId}:{})}).input;
      this.acceptActivation(saved,binding,action,entryId,participants.map(member=>member.key),true,actor,input);
      this.saveReceipt(saved,{state:'pending',invocations:[]});
      for(const member of binding.participants)recordSessionEvent({eventId:`lab-model-choice:${saved.id}:${member.key}`,sessionId:sessionNumber(member.sessionId),inputId:saved.id,kind:'lab_model_choice',
        payload:{provider:member.provider,model:member.model,reasoningEffort:member.reasoningEffort,existing:member.existing,source:actor?'agent':'human',...(choices.find((choice:LabParticipantChoice)=>choice.key===member.key)?.escalationReason?{escalationReason:choices.find((choice:LabParticipantChoice)=>choice.key===member.key)!.escalationReason}:{})}});
      for(const member of binding.participants.filter(member=>!member.existing&&topModel(member.model)))recordSessionEvent({eventId:`model-escalation:${saved.id}:${member.key}`,sessionId:sessionNumber(member.sessionId),inputId:saved.id,kind:'model_escalation',
        payload:{model:member.model,reason:actor?(choices.find((choice:LabParticipantChoice)=>choice.key===member.key)?.escalationReason??'retained explicit human model choice'):'explicit human model choice',sourceInputId:saved.id}});
    })();
    this.ports.wake();return this.view(thread);
  }
  private checkRetry(saved:AcceptedSessionInput,input:unknown,actor?:LabActor){
    const payload=JSON.parse(saved.payload_json);
    if(stablePayload(payload.request)!==stablePayload(input)||stablePayload(payload.actor??null)!==stablePayload(actor??null))throw new LabConversationError('Idempotency conflict.',409,'IDEMPOTENCY_CONFLICT');
  }
  respond(thread:string,body:unknown,actor?:LabActor){
    const input=object(body);only(input,['clientActionId','entryId','targets','agentSource']);
    const action=identifier(input.clientActionId,'Stable action identity'),entryId=identifier(input.entryId,'Triggering entry');
    const {input:conversation,binding}=this.conversation(thread);
    if(!Array.isArray(input.targets)||input.targets.length>binding.participants.length||input.targets.some((sessionId:unknown)=>typeof sessionId!=='string'||!binding.participants.some(member=>member.sessionId===sessionId)))throw new LabConversationError('Choose only exact participant sessions bound to this thread.');
    if(new Set(input.targets).size!==input.targets.length)throw new LabConversationError('Response targets must be unique.');
    db.transaction(()=>this.acceptActivation(conversation,binding,action,entryId,input.targets.map((sessionId:string)=>binding.participants.find(member=>member.sessionId===sessionId)!.key),false,actor,input))();
    this.ports.wake();return this.view(thread);
  }
  private acceptActivation(conversation:AcceptedSessionInput,binding:Conversation,action:string,entryId:string,targets:string[],independent:boolean,actor:LabActor|undefined,request:unknown){
    const scope=`lab:activation:${binding.thread}`,prior=readAction(scope,action);
    if(prior){this.checkRetry(prior,request,actor);return;}
    const saved=retainSessionInput({sessionId:sessionNumber(binding.coordinatorSessionId),scope,actionId:action,kind:'lab-activation',origin:actor?'agent':'human',
      payload:{request,thread:binding.thread,entryId,targets,independent,conversationInputId:conversation.id,...(actor?{actor}:{})},
      sourceInputId:actor?.inputId,sourceRunId:actor?.runId}).input;
    this.saveReceipt(saved,{state:targets.length?'pending':'completed',invocations:targets.map(key=>{
      const requestId=`lab-${digest([saved.id,key])}`;
      retainSessionInput({sessionId:sessionNumber(binding.participants.find(member=>member.key===key)!.sessionId),scope:'lab:binding',actionId:requestId,kind:'lab-binding',origin:'service',
        payload:{thread:binding.thread,entryId,key,requestId},sourceInputId:saved.id,requestId});
      return {key,requestId,inputId:`request:${requestId}`,state:'context_pending'};
    })});
    executionChanged();
  }
  private activationFor(thread:string,requestId:string){
    const descriptor=readAction('lab:binding',requestId),action=descriptor?.source_input_id?getAcceptedSessionInput(descriptor.source_input_id):null;
    if(!action)throw new LabConversationError('This invocation does not belong to this Lab thread.',404,'LAB_INVOCATION_NOT_FOUND');
    if(JSON.parse(action.payload_json).thread!==thread)throw new LabConversationError('This invocation belongs to another Lab thread.',404,'LAB_INVOCATION_NOT_FOUND');
    return {action,invocation:readAction('lab:invocation',requestId)};
  }
  requestFacts(thread:string,requestId:string){
    const {action}=this.activationFor(thread,requestId),payload=JSON.parse(action.payload_json),invocation=receipt(action).invocations.find(value=>value.requestId===requestId)!;
    const {binding}=this.conversation(thread),participant=binding.participants.find(member=>member.key===invocation.key)!;
    return {version:1,thread,entryId:payload.entryId,requestId,sessionId:participant.sessionId,coordinatorSessionId:binding.coordinatorSessionId,independent:payload.independent,
      participant,state:invocation.state,sourceInputId:action.source_input_id,sourceRunId:action.source_run_id,origin:action.origin,
      responseTargets:payload.targets.map((key:string)=>binding.participants.find(member=>member.key===key)!.sessionId)};
  }
  answerFacts(thread:string,requestId:string,eventId:string){
    return this.outputFacts(thread,requestId,eventId,true);
  }
  private outputFacts(thread:string,requestId:string,eventId:string,requireEvent:boolean){
    const {action,invocation:accepted}=this.activationFor(thread,requestId),facts=this.requestFacts(thread,requestId);
    if(!accepted||accepted.turn_id===null)throw new LabConversationError('The original provider answer is not retained yet.',409,'LAB_OUTPUT_PENDING');
    const turn=db.query('SELECT id,status,agent_text,native_run_id,provider_input_acknowledged_at,accepted_input_id,ended_at FROM turns WHERE id=? AND session_id=?').get(accepted.turn_id,accepted.session_id) as any;
    const expected=`lab-output:${requestId}:${turn?.native_run_id}`;
    const verified=db.query("SELECT payload_json FROM session_owner_events INDEXED BY session_owner_events_turn_kind WHERE turn_id=? AND kind='lab_binding_verified' AND input_id=? ORDER BY sequence DESC LIMIT 1").get(accepted.turn_id,accepted.id) as {payload_json:string}|null;
    const verifiedBinding=verified?JSON.parse(verified.payload_json):null;
    const member=facts.participant;
    const admission=JSON.parse(accepted.receipt_json??'{}').admission;
    const correctBinding=verifiedBinding&&['provider','model','reasoningEffort','project','projectPath','generation'].every(key=>verifiedBinding[key]===(member as any)[key])
      &&admission?.provider===member.provider&&admission?.model===member.model&&admission?.bindingGeneration===member.generation&&admission?.inputId===accepted.id&&admission?.runId===turn?.native_run_id;
    const retainedEvent=db.query("SELECT payload_json FROM session_owner_events WHERE event_id=? AND input_id=? AND turn_id=? AND kind='lab_original_output'").get(eventId,accepted.id,accepted.turn_id) as {payload_json:string}|null;
    if(!turn||turn.status!=='done'||!turn.ended_at||!turn.provider_input_acknowledged_at||turn.accepted_input_id!==accepted.id||!turn.agent_text||eventId!==expected||!correctBinding
      ||requireEvent&&(!retainedEvent||JSON.parse(retainedEvent.payload_json).sha256!==createHash('sha256').update(turn.agent_text).digest('hex')))
      throw new LabConversationError('The exact retained original provider answer does not match.',409,'LAB_OUTPUT_UNCONFIRMED');
    return {version:1,thread,entryId:facts.entryId,requestId,eventId,coordinatorSessionId:facts.coordinatorSessionId,participant:{sessionId:facts.sessionId,label:facts.participant.label},
      author:{session:facts.sessionId,name:facts.participant.agentName??facts.participant.label,sourceInput:accepted.id,sourceRun:turn.native_run_id},text:turn.agent_text,at:turn.ended_at,independent:facts.independent};
  }
  view(thread:string,before?:number){
    const {binding}=this.conversation(thread);
    if(before!==undefined&&(!Number.isSafeInteger(before)||before<1))throw new LabConversationError('The Lab activation cursor is invalid.');
    const actions=db.query("SELECT rowid AS position,* FROM session_inputs INDEXED BY session_inputs_lab_history WHERE kind='lab-activation' AND scope=? AND rowid<? ORDER BY rowid DESC LIMIT 21").all(`lab:activation:${thread}`,before??Number.MAX_SAFE_INTEGER) as (AcceptedSessionInput&{position:number})[];
    const {opening,...publicBinding}=binding;
    const journalBinding=JSON.parse(this.conversation(thread).input.receipt_json??'{}');
    return {version:1,...publicBinding,journalBinding:{state:journalBinding.state,error:journalBinding.error??null},activations:actions.slice(0,20).map(action=>({actionId:action.action_id,entryId:JSON.parse(action.payload_json).entryId,independent:JSON.parse(action.payload_json).independent,
      state:receipt(action).state,invocations:receipt(action).invocations.map(({context,...invocation})=>{
        const accepted=getAcceptedSessionInput(invocation.inputId),execution=accepted?.turn_id?db.query('SELECT status,native_run_id AS runId,dispatch_failure_class AS failureClass,dispatch_hold AS hold,dispatch_next_attempt_ms AS nextAttemptMs FROM turns WHERE id=?').get(accepted.turn_id):null;
        const admission=accepted?.receipt_json?JSON.parse(accepted.receipt_json):null;
        return {...invocation,sessionId:binding.participants.find(member=>member.key===invocation.key)!.sessionId,...(accepted?{operationId:invocation.inputId,execution,admission:{state:admission?.state??null,error:admission?.error??null}}:{} )};
      })})),
      nextCursor:actions.length>20?String(actions[19]!.position):null};
  }
  /** Called by existing reconciliation; bounded and reentrant, with no provider replay. */
  reconcile():Promise<boolean>{
    if(this.pass)return this.pass;
    this.pass=this.advance().finally(()=>{this.pass=null;});return this.pass;
  }
  private async advance(){
    const pending=()=>db.query("SELECT * FROM session_inputs INDEXED BY session_inputs_lab_pending WHERE kind='lab-activation' AND json_extract(receipt_json,'$.state')='pending' AND id>? ORDER BY id LIMIT 64").all(this.after) as AcceptedSessionInput[];
    let actions=pending();if(!actions.length){this.after='';actions=pending();}
    await Promise.all(actions.map(async action=>{
      if(this.abort.signal.aborted)return;
      const payload=JSON.parse(action.payload_json),{binding,input:conversation}=this.conversation(payload.thread),state=receipt(action);
      const bindingReceipt=JSON.parse(conversation.receipt_json??'{}');
      if(bindingReceipt.state!=='completed'){
        try{const bound=await this.ports.bind(binding.thread,this.abort.signal);if(this.abort.signal.aborted)return;
          if(!bound||typeof bound!=='object'||(bound as any).version!==1||(bound as any).thread!==binding.thread||(bound as any).bound!==true)throw new LabConversationError('The Lab did not confirm this conversation’s exact participant membership.',502,'LAB_BINDING_UNCONFIRMED');
          db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'completed'}),conversation.id);
        }catch(error){
          const permanent=error instanceof LabConversationError&&error.status>=400&&error.status<500;
          const reason=error instanceof LabConversationError?`${error.code}: ${error.message}`:'The Lab participant membership was not confirmed.';
          db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:permanent?'refused':'pending',error:reason}),conversation.id);
          if(permanent){for(const invocation of state.invocations){invocation.state='refused';invocation.error=reason;}state.state='completed';this.saveReceipt(action,state);}
          return;
        }
      }
      await Promise.all(state.invocations.map(async invocation=>{
        if(this.abort.signal.aborted||['published','failed','refused'].includes(invocation.state))return;
        const member=binding.participants.find(participant=>participant.key===invocation.key)!;
        try{
          if(invocation.state==='context_pending'){
            const context=await this.ports.context({thread:binding.thread,entryId:payload.entryId,sessionId:member.sessionId,requestId:invocation.requestId,independent:payload.independent,signal:this.abort.signal});
            if(this.abort.signal.aborted)return;
            if(context.version!==1||context.thread!==binding.thread||context.entryId!==payload.entryId||context.sessionId!==member.sessionId||!Array.isArray(context.entries)||!context.entries.length||context.entries.at(-1)?.id!==payload.entryId)
              throw new LabConversationError('The Lab context did not prove the exact triggering entry.',409,'LAB_CONTEXT_MISMATCH');
            const selectedSessions=payload.targets.map((key:string)=>binding.participants.find(member=>member.key===key)!.sessionId);
            if(!payload.independent&&(!Array.isArray(context.responseTargets)||stablePayload([...context.responseTargets].sort())!==stablePayload(selectedSessions.sort())))throw new LabConversationError('The selected participants differ from the triggering Lab entry.',409,'LAB_TARGETS_MISMATCH');
            if(payload.independent&&context.entries.length!==1)throw new LabConversationError('Independent first answers may see only the common opening entry.',409,'LAB_INDEPENDENCE_REFUSED');
            if(payload.independent&&stablePayload(context.entries[0])!==stablePayload(binding.opening))throw new LabConversationError('The common opening changed from its retained comparison snapshot.',409,'LAB_QUESTION_CHANGED');
            const loaded=await this.observe(this.ports.sources(member.sources));
            if(this.abort.signal.aborted)return;
            if(loaded.length!==member.sources.length||loaded.some((source,index)=>stablePayload(source.reference)!==stablePayload(member.sources[index])||typeof source.text!=='string'||!source.text.trim()||createHash('sha256').update(source.text).digest('hex')!==source.sha256))throw new LabConversationError('The exact selected source material could not be verified.',409,'LAB_SOURCES_UNAVAILABLE');
            context.sources=loaded;
            invocation.context=context;
            const prompt=[payload.independent?'Answer the common question independently. Other participants’ first answers are deliberately absent. Do not inspect or publish into the Lab yourself.':member.key==='coordinator'
              ?`You coordinate this Lab thread independently of the Inbox. Respond using the exact visible discussion below. To route a follow-up question to selected bound voices, post your attributed question with router-actions.sh sessions board post --thread ${binding.thread} --response-target <bound session ID> (repeat for each selected voice) --source-input <this input> --source-run <this run> --action-id <stable id> -- <question>. Only those selected voices run. Bound participants: ${JSON.stringify(binding.participants.map(({sessionId,label})=>({sessionId,label})))}`
              :'Respond to the selected Lab entry using only the visible discussion below through that exact entry. Do not publish into the Lab yourself.',
              'The runtime retains your original final answer and publishes it under your own participant identity. Answer directly; no sessions reply is required for this typed invocation.',
              `Your binding and source differences: ${JSON.stringify(member)}`,
              ...(member.instructions!==null?[`Selected participant instructions, verbatim:\n${member.instructions}`]:[]),
              member.tools==='none'?'This ChatGPT session has no outbound tools. If the selected instructions require tools or private resources you cannot access, say exactly what cannot be performed. Do not simulate retrieval, NotebookLM, or source-constrained results.':'Use your existing native tools when the selected instructions call for them. Disclose unavailable resources and the actual sources used; do not simulate another provider.',
              `Visible Lab discussion:\n${JSON.stringify(context)}`].join('\n\n');
            db.transaction(()=>{
              retainSessionInput({id:invocation.inputId,sessionId:sessionNumber(member.sessionId),scope:'lab:invocation',actionId:invocation.requestId,kind:'input',origin:'service',
                payload:{text:prompt,delivery:'queue',labInvocation:{version:1,thread:binding.thread,entryId:payload.entryId,requestId:invocation.requestId,key:member.key,independent:payload.independent}},sourceInputId:action.id,requestId:invocation.requestId});
              invocation.state='accepted';delete invocation.error;this.saveReceipt(action,state);
            })();
          }
          const accepted=getAcceptedSessionInput(invocation.inputId)!;
          if(this.abort.signal.aborted)return;
          const before=accepted.turn_id===null?null:db.query('SELECT status,provider_admission_intended_at FROM turns WHERE id=?').get(accepted.turn_id) as {status:string;provider_admission_intended_at:string|null}|null;
          if((!before||before.status==='queued'&&!before.provider_admission_intended_at)&&!labInvocationBindingMatches(accepted))throw new LabConversationError('The participant’s retained provider, model or effort changed; no replacement was submitted.',409,'LAB_BINDING_CHANGED');
          if(accepted.turn_id===null){
            if(this.ports.available&&!this.ports.available(accepted.session_id)){invocation.error='LAB_PROVIDER_UNAVAILABLE: the selected provider is unavailable; this exact invocation remains held without a replacement.';this.saveReceipt(action,state);return;}
            delete invocation.error;this.ports.dispatch(accepted);
          }
          const retained=getAcceptedSessionInput(invocation.inputId)!;
          const turn=retained.turn_id===null?null:db.query('SELECT status,native_run_id FROM turns WHERE id=?').get(retained.turn_id) as {status:string;native_run_id:string|null}|null;
          if(turn?.status==='done'){
            const eventId=`lab-output:${invocation.requestId}:${turn.native_run_id}`;
            let facts:ReturnType<LabConversations['answerFacts']>;
            try{facts=this.outputFacts(binding.thread,invocation.requestId,eventId,false);}
            catch{invocation.state='failed';invocation.error='LAB_OUTPUT_UNCONFIRMED: the terminal turn did not prove an acknowledged original provider answer.';this.saveReceipt(action,state);return;}
            recordSessionEvent({eventId,sessionId:accepted.session_id,inputId:accepted.id,turnId:accepted.turn_id,kind:'lab_original_output',payload:{requestId:invocation.requestId,sha256:createHash('sha256').update(facts.text).digest('hex')}});
            const publication=await this.ports.publish({thread:binding.thread,requestId:invocation.requestId,eventId,signal:this.abort.signal});
            if(!publication||typeof publication!=='object'||typeof (publication as any).id!=='string'||typeof (publication as any).address!=='string'||typeof (publication as any).duplicate!=='boolean')throw new LabConversationError('The Lab did not confirm the exact original-answer publication.',502,'LAB_PUBLICATION_UNCONFIRMED');
            invocation.state='published';invocation.eventId=eventId;invocation.publication=publication;delete invocation.error;
          } else if(turn&&['error','cancelled'].includes(turn.status)){
            invocation.state='failed';invocation.error='The original provider execution ended without a publishable answer.';
          }else if(!turn&&JSON.parse(retained.receipt_json??'{}').state==='failed'){
            invocation.state='failed';invocation.error='The ordinary session queue refused this exact invocation.';
          }
        }catch(error){
          invocation.error=error instanceof LabConversationError?`${error.code}: ${error.message}`:'The Lab context or publication service did not confirm this operation.';
          if(error instanceof LabConversationError&&error.status>=400&&error.status<500)invocation.state='refused';
          if(error instanceof LabConversationError&&error.code==='LAB_BINDING_CHANGED')invocation.state='refused';
        }
        this.saveReceipt(action,state);
      }));
      if(state.invocations.every(invocation=>['published','failed','refused'].includes(invocation.state))){state.state='completed';this.saveReceipt(action,state);}
    }));
    this.after=actions.at(-1)?.id??'';
    return !!db.query("SELECT 1 FROM session_inputs INDEXED BY session_inputs_lab_pending WHERE kind='lab-activation' AND json_extract(receipt_json,'$.state')='pending' LIMIT 1").get();
  }
}
