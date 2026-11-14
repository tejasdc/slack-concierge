import {acceptedBindingSnapshotDigest as digest} from './codex-accepted-binding-continuation';

const shadows=new WeakMap<object,any>();
const object=(v:any)=>v!==null&&typeof v==='object';
/** Keep exact JSON numeric lexemes alongside parsed values. Native history's
 * opaque JSON data can contain decimals/large numbers that JavaScript rounds.
 * Source identity comparisons must never collapse distinct original payloads. */
export function parseNativeSourceRecord(text:string):any{
  const value=JSON.parse(text);
  const shadow=JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    token=>token.startsWith('"')?token:JSON.stringify(token)));
  const bind=(v:any,s:any)=>{if(object(v)){shadows.set(v,s);for(const key of Object.keys(v))bind(v[key],s[key]);}};
  bind(value,shadow);return value;
}
export const nativeSourceShadow=(v:any):any=>object(v)?shadows.get(v):undefined;
function typed(v:any,shadow:any):any{
  if(v===null)return ['null'];
  if(typeof v==='number')return ['number',typeof shadow==='string'?shadow:JSON.stringify(v)];
  if(typeof v!=='object')return [typeof v,v];
  shadow??=nativeSourceShadow(v);
  if(Array.isArray(v))return ['array',v.map((entry,i)=>typed(entry,shadow?.[i]))];
  return ['object',Object.keys(v).sort().map(key=>[key,typed(v[key],shadow?.[key])])];
}
export function nativeSourceValueDigest(value:any,shadow=nativeSourceShadow(value)):string{return digest(typed(value,shadow));}
export function nativeSourceIntegerAt(parent:any,key:string|number):boolean{
  const value=parent?.[key],lexeme=nativeSourceShadow(parent)?.[key];
  return Number.isSafeInteger(value)&&(lexeme===undefined||typeof lexeme==='string'&&/^-?(?:0|[1-9]\d*)$/.test(lexeme));
}
export function nativeSourceWithoutKeys(value:any,keys:readonly string[]):string{
  const shadow=nativeSourceShadow(value),copy={...value},remaining=shadow?{...shadow}:undefined;
  for(const key of keys){delete copy[key];if(remaining)delete remaining[key];}
  return nativeSourceValueDigest(copy,remaining);
}
