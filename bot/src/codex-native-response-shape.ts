import source from './codex-native-response-schema.json';
import {nativeSourceShadow} from './codex-native-source-values';

// This is the closed vocabulary of the pinned schema fragment, not a general
// JSON Schema implementation. A future schema keyword refuses at initialization.
const keywords=new Set(['$ref','type','properties','required','items','oneOf','anyOf','enum',
  'additionalProperties','minimum','minLength','format','title','description','default']);
const definitions=source.definitions as Record<string,any>;
function checkSchema(s:any):void{
  if(typeof s==='boolean')return;
  if(!s||typeof s!=='object'||Object.keys(s).some(key=>!keywords.has(key)))throw new Error('Pinned native schema keyword unsupported');
  if(s.$ref&&!Object.hasOwn(definitions,s.$ref.replace('#/definitions/','')))throw new Error('Pinned native schema reference missing');
  if(s.format&&s.format!=='uint64')throw new Error('Pinned native schema format unsupported');
  for(const child of Object.values(s.properties??{}))checkSchema(child);
  for(const key of ['items','additionalProperties'])if(Object.hasOwn(s,key))checkSchema(s[key]);
  for(const key of ['anyOf','oneOf'])for(const child of s[key]??[])checkSchema(child);
}
for(const schema of Object.values(definitions))checkSchema(schema);
function matches(v:any,s:any,shadow:any=nativeSourceShadow(v)):boolean{
  if(typeof s==='boolean')return s;
  if(s.$ref)return matches(v,definitions[s.$ref.replace('#/definitions/','')],shadow);
  if(s.oneOf&&s.oneOf.filter((branch:any)=>matches(v,branch,shadow)).length!==1)return false;
  if(s.anyOf&&!s.anyOf.some((branch:any)=>matches(v,branch,shadow)))return false;
  if(s.enum&&!s.enum.some((x:any)=>x===v))return false;
  const kinds=Array.isArray(s.type)?s.type:s.type?[s.type]:[];
  if(kinds.length&&!kinds.some((kind:string)=>kind==='null'?v===null:kind==='array'?Array.isArray(v):
    kind==='object'?v!==null&&typeof v==='object'&&!Array.isArray(v):kind==='integer'?Number.isSafeInteger(v)
      &&(shadow===undefined||typeof shadow==='string'&&/^-?(?:0|[1-9]\d*)$/.test(shadow)):
    kind==='number'?typeof v==='number'&&Number.isFinite(v):typeof v===kind))return false;
  if(v===null)return true;
  if(s.minimum!==undefined&&typeof v==='number'&&v<s.minimum)return false;
  if(s.minLength!==undefined&&typeof v==='string'&&[...v].length<s.minLength)return false;
  if(Array.isArray(v)&&s.items!==undefined&&!v.every((item,i)=>matches(item,s.items,shadow?.[i])))return false;
  if(typeof v==='object'&&!Array.isArray(v)){
    if((s.required??[]).some((key:string)=>!Object.hasOwn(v,key)))return false;
    for(const [key,value] of Object.entries(v)){
      if(Object.hasOwn(s.properties??{},key)){if(!matches(value,s.properties[key],shadow?.[key]))return false;}
      // Unstructured provider/tool data is opaque only where the upstream
      // schema declares it so. Typed objects reject unknown meaningful fields.
      else if(s.properties){if(s.additionalProperties===undefined||!matches(value,s.additionalProperties,shadow?.[key]))return false;}
      else if(s.additionalProperties!==undefined&&!matches(value,s.additionalProperties,shadow?.[key]))return false;
    }
  }
  return true;
}
export const nativeResponseSchemaIdentity={upstreamCommit:source.upstreamCommit,sourceSha256:source.sourceSha256};
export function matchesPinnedNativeResponse(p:any,kind:string):boolean{
  const projected={...p,type:kind};
  const m=p.internal_chat_message_metadata_passthrough;
  // Schemars intentionally omits warehouse/classification fields. Their native
  // raw shapes are checked separately and preserved in envelope/source proof.
  if(m!=null)projected.internal_chat_message_metadata_passthrough=m.turn_id==null?{}:{turn_id:m.turn_id};
  return matches(projected,definitions.ResponseItem,nativeSourceShadow(p));
}
