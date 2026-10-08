import type {CapabilitySource} from './session-capability-client';

type Pin={sourceId:string;sourceVersion:string;branch:unknown;eventId:string};
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

/** Thinkering's archive index stores its native provider spelling; its capability wire
 * presents the same source as `claude-code`. Keep that one boundary translation here. */
export function indexedArchiveSource(value:unknown):CapabilitySource|null {
 if(!record(value))return null;
 const provider=value.provider==='claude'?'claude-code':value.provider;
 return ['codex','claude-code','chatgpt'].includes(String(provider))
  ?{...value,provider} as unknown as CapabilitySource:null;
}

/** Search metadata identifies the source; a separate prepared read proves its exact version
 * and matched event still exist. Neither half alone authorizes an imported session. */
export function retainedArchiveSearchSource(source:unknown,pin:Pin,proof:unknown):CapabilitySource|null {
 if(!record(source)||typeof source.id!=='string'||!source.id||typeof source.version!=='string'
   ||!/^[a-f0-9]{64}$/.test(source.version)||typeof source.branch!=='string'||!source.branch
   ||source.id!==pin.sourceId||source.version!==pin.sourceVersion||source.branch!==pin.branch
   ||!['codex','claude-code','chatgpt'].includes(String(source.provider))||typeof source.title!=='string'
   ||!Array.isArray(source.messages)||!Array.isArray(source.omissions))return null;
 if(!record(proof))return null;
 const prepared=Array.isArray(proof.messages)&&proof.retainedEventId===pin.eventId;
 const context=record(proof.source)&&proof.source.id===pin.sourceId&&proof.source.version===pin.sourceVersion
   &&proof.source.branch===pin.branch&&Array.isArray(proof.evidence)
   &&proof.evidence.some((item:unknown)=>record(item)&&item.eventId===pin.eventId);
 return prepared||context?source as unknown as CapabilitySource:null;
}
