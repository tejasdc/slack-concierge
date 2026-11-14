import {createHash,randomUUID} from 'node:crypto';

// Explicit protocol reads only. Unknown methods (including notifications) are writes.
// A new native method cannot silently bypass an existing exact-thread reservation.
const reads=new Set(['initialize','initialized','thread/read','thread/list','thread/loaded/list',
  'thread/turns/list','thread/items/list','thread/turns/items/list','thread/turn/items/list','model/list',
  'account/read','account/rateLimits/read','config/read','configRequirements/read',
  'skills/list','app/list','experimentalFeature/list','mcpServerStatus/list']);
// Scope is part of the native method contract, not a caller's arbitrary field.
// Future methods stay global until their actual mutation target is established.
const exactThreadWrites=new Set(['thread/resume','thread/archive','thread/unarchive','thread/compact',
  'thread/compact/start','thread/rollback','thread/name/set','thread/fork','turn/start','turn/steer','turn/interrupt']);
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)
  ?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
export const mutationDigest=value=>createHash('sha256').update(canonical(JSON.parse(JSON.stringify(value)))).digest('hex');
export function codexMutationDescriptor(frame){
  if(!frame||typeof frame!=='object')throw new Error('Invalid Codex frame.');
  if(typeof frame.method!=='string'){
    if(Object.hasOwn(frame,'id')&&('result'in frame||'error'in frame))return {method:'managed/server-response',
      threadId:null,paramsDigest:mutationDigest(frame),promptDigest:null,model:null,effort:null,clientUserMessageId:null};
    throw new Error('Invalid Codex protocol frame.');
  }
  if(reads.has(frame.method))return null;
  const params=frame.params??{};
  const threadId=exactThreadWrites.has(frame.method)&&typeof params.threadId==='string'?params.threadId:null;
  const text=Array.isArray(params.input)?params.input.map(item=>item?.type==='text'?item.text:'').join(''):null;
  return {method:frame.method,threadId,paramsDigest:mutationDigest(params),
    nativeTurnId:frame.method==='turn/steer'?params.expectedTurnId??null:
      frame.method==='turn/interrupt'?params.turnId??null:null,
    promptDigest:text===null?null:createHash('sha256').update(text,'utf8').digest('hex'),
    model:typeof params.model==='string'?params.model:null,
    effort:typeof params.effort==='string'?params.effort:null,
    clientUserMessageId:typeof params.clientUserMessageId==='string'?params.clientUserMessageId:null};
}

/** One connection's ordered forwarding boundary. Authority and deduplication live in
 * the common owner, not this queue. A consumed permit remains issued after disconnect. */
export class CodexMutationChannel {
  constructor({gate,send,reject,connectionId=randomUUID(),describe=codexMutationDescriptor,
    parameters=frame=>typeof frame.method==='string'?frame.params??{}:frame}){
    this.gate=gate;this.send=send;this.reject=reject;this.connectionId=connectionId;
    this.describe=describe;this.parameters=parameters;
    this.sequence=0;this.pending=new Map();this.requestIds=new Set();this.tail=Promise.resolve();this.closed=false;
  }
  forward(frame){
    const work=this.tail.then(()=>this.forwardOrdered(frame));
    this.tail=work.catch(()=>{});
    return work;
  }
  async forwardOrdered(frame){
    if(this.closed)throw new Error('Codex mutation channel closed before forwarding.');
    const authority=frame?.params?.__conciergeRecovery;
    if(authority){const {__conciergeRecovery,...params}=frame.params;frame={...frame,params};}
    if(typeof frame?.method==='string'&&Object.hasOwn(frame,'id')){
      const key=JSON.stringify(frame.id);
      if(this.requestIds.has(key))throw new Error('Duplicate outstanding Codex request ID.');
      this.requestIds.add(key);
    }
    const descriptor=this.describe(frame);
    if(!descriptor){this.send(frame);return;}
    const actualParams=this.parameters(frame);
    const permitId=`${this.connectionId}:${++this.sequence}`;
    const identity={...descriptor,connectionId:this.connectionId,permitId,intentId:permitId};
    let issued=false;
    try{
      const prepared=await this.gate({phase:'prepare',...identity,params:actualParams,...(authority?{authority}:{})});
      if(!prepared?.allowed)throw new Error(prepared?.reason??'Codex mutation authority is unavailable.');
      const consumed=await this.gate({phase:'consume',...identity,params:actualParams,...(authority?{authority}:{})});
      if(!consumed?.forward)throw new Error(consumed?.reason??'Codex mutation was already issued or refused.');
      issued=true;
      if(typeof frame.method==='string'&&Object.hasOwn(frame,'id'))this.pending.set(JSON.stringify(frame.id),{...identity,
        ...(prepared.authorizationId||authority?.authorizationId
          ?{authorizationId:prepared.authorizationId??authority.authorizationId}:{})});
      // No await between the durable consumption and the actual send. Another process
      // sees the outstanding intent even if this connection dies at this instruction.
      if(this.closed)throw new Error('Codex mutation channel closed after permit consumption.');
      this.send(frame);
    }catch(error){
      if(!issued&&Object.hasOwn(frame,'id'))this.requestIds.delete(JSON.stringify(frame.id));
      this.reject(frame,error instanceof Error?error.message:'Codex mutation refused.',issued);
    }
  }
  async response(frame){
    if(!frame||!Object.hasOwn(frame,'id')||!('result'in frame||'error'in frame))return;
    const key=JSON.stringify(frame.id),identity=this.pending.get(key);
    this.requestIds.delete(key);
    if(!identity)return;
    // Native errors may follow settings/history effects. They are never evidence
    // that nothing happened, and cannot release a fence or authorize another send.
    await this.gate({phase:'response',...identity,responseDigest:mutationDigest(frame),
      ...('result'in frame?{responseResultDigest:mutationDigest(frame.result)}:{}),
      providerTurnId:typeof frame.result?.turn?.id==='string'?frame.result.turn.id:
        typeof frame.result?.turnId==='string'?frame.result.turnId:null,
      response:{id:frame.id,...(frame.error?{error:{code:frame.error.code}}:{}),
        ...(frame.result?{result:{turn:frame.result.turn?.id?{id:frame.result.turn.id}:undefined,
          thread:frame.result.thread?.id?{id:frame.result.thread.id}:undefined,
          model:frame.result.model,reasoningEffort:frame.result.reasoningEffort,
          status:typeof frame.result.status==='string'?frame.result.status:undefined}}:{})},
      nativeError:!!frame.error});
    this.pending.delete(key);
  }
  close(){this.closed=true;/* durable issued intents deliberately remain outstanding */}
}
