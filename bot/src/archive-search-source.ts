import {verifySource,type CapabilitySource} from './session-capability-client';

type Pin={sourceId:string;sourceVersion:string;branch:unknown;eventId:string};
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

/** Thinkering's archive index stores its native provider spelling; its capability wire
 * presents the same source as `claude-code`. Keep that one boundary translation here. */
export function indexedArchiveSource(value:unknown):CapabilitySource|null {
 if(!record(value))return null;
 const provider=value.provider==='claude'?'claude-code':value.provider;
 const source={...value,provider,consultation:value.consultation??null};
 try{verifySource(source);return source;}catch{return null;}
}

/** Search metadata identifies the source; a separate prepared read proves its exact version
 * and matched event still exist. Neither half alone authorizes an imported session. */
export function retainedArchiveSearchSource(source:unknown,pin:Pin,proof:unknown):CapabilitySource|null {
 if(typeof pin.branch!=='string')return null;
 try{verifySource(source,{...pin,branch:pin.branch});}catch{return null;}
 if(!record(proof))return null;
 const prepared=Array.isArray(proof.messages)&&proof.retainedEventId===pin.eventId;
 const context=record(proof.source)&&proof.source.id===pin.sourceId&&proof.source.version===pin.sourceVersion
   &&proof.source.branch===pin.branch&&Array.isArray(proof.evidence)
   &&proof.evidence.some((item:unknown)=>record(item)&&item.eventId===pin.eventId);
 return prepared||context?source:null;
}
