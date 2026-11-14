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
type Fields=Map<object,{keys:Set<string>;opaque:boolean}>;
function mergeFields(into:Fields,from:Fields):void{
  for(const [value,fields] of from){
    const current=into.get(value);
    if(!current)into.set(value,{keys:new Set(fields.keys),opaque:fields.opaque});
    else{for(const key of fields.keys)current.keys.add(key);current.opaque ||= fields.opaque;}
  }
}
// Native validity and meaningful-field coverage are separate. JSON Schema leaves
// absent additionalProperties open; only successful branches contribute fields
// to the complete typed shape. Closing each branch rejects legitimate siblings.
function evaluate(v:any,s:any,refs:Record<string,any>,shadow:any,fields:Fields):boolean{
  if(typeof s==='boolean'){
    if(s&&v!==null&&typeof v==='object')fields.set(v,{keys:new Set(),opaque:true});
    return s;
  }
  if(s.$ref&&!evaluate(v,refs[s.$ref.replace('#/definitions/','')],refs,shadow,fields))return false;
  for(const key of ['oneOf','anyOf'])if(s[key]){
    const successful:Fields[]=[];
    for(const branch of s[key]){const branchFields:Fields=new Map();
      if(evaluate(v,branch,refs,shadow,branchFields))successful.push(branchFields);}
    if(key==='oneOf'?successful.length!==1:successful.length===0)return false;
    for(const branchFields of successful)mergeFields(fields,branchFields);
  }
  if(s.enum&&!s.enum.some((x:any)=>x===v))return false;
  const kinds=Array.isArray(s.type)?s.type:s.type?[s.type]:[];
  if(kinds.length&&!kinds.some((kind:string)=>kind==='null'?v===null:kind==='array'?Array.isArray(v):
    kind==='object'?v!==null&&typeof v==='object'&&!Array.isArray(v):kind==='integer'?Number.isSafeInteger(v)
      &&(shadow===undefined||typeof shadow==='string'&&/^-?(?:0|[1-9]\d*)$/.test(shadow)):
    kind==='number'?typeof v==='number'&&Number.isFinite(v):typeof v===kind))return false;
  if(v===null)return true;
  if(s.minimum!==undefined&&typeof v==='number'&&v<s.minimum)return false;
  if(s.minLength!==undefined&&typeof v==='string'&&[...v].length<s.minLength)return false;
  if(Array.isArray(v)&&s.items!==undefined&&!v.every((item,i)=>evaluate(item,s.items,refs,shadow?.[i],fields)))return false;
  if(typeof v==='object'&&!Array.isArray(v)){
    if((s.required??[]).some((key:string)=>!Object.hasOwn(v,key)))return false;
    const ownFields:Fields=new Map([[v,{keys:new Set(Object.keys(s.properties??{})),opaque:false}]]);
    for(const [key,value] of Object.entries(v)){
      if(Object.hasOwn(s.properties??{},key)){if(!evaluate(value,s.properties[key],refs,shadow?.[key],fields))return false;}
      else if(s.additionalProperties!==undefined){
        if(!evaluate(value,s.additionalProperties,refs,shadow?.[key],fields))return false;
        ownFields.get(v)!.keys.add(key);
      }
    }
    mergeFields(fields,ownFields);
  }
  if(v!==null&&typeof v==='object'&&Object.keys(s).every(key=>['title','description','default'].includes(key)))
    mergeFields(fields,new Map([[v,{keys:new Set(),opaque:true}]]));
  return true;
}
export function matchesNativeSchemaShape(v:any,s:any,refs:Record<string,any>={},shadow:any=nativeSourceShadow(v)):boolean{
  const fields:Fields=new Map();
  if(!evaluate(v,s,refs,shadow,fields))return false;
  const covered=(value:any):boolean=>{
    if(value===null||typeof value!=='object')return true;
    const shape=fields.get(value);
    if(shape?.opaque)return true;
    if(Array.isArray(value))return value.every(covered);
    return !!shape&&Object.entries(value).every(([key,child])=>shape.keys.has(key)&&covered(child));
  };
  return covered(v);
}
export const nativeResponseSchemaIdentity={upstreamCommit:source.upstreamCommit,sourceSha256:source.sourceSha256,
  interpreter:'composed_native_validity_and_field_coverage_v2'};
export function matchesPinnedNativeResponse(p:any,kind:string):boolean{
  const projected={...p,type:kind};
  const m=p.internal_chat_message_metadata_passthrough;
  // Schemars intentionally omits warehouse/classification fields. Their native
  // raw shapes are checked separately and preserved in envelope/source proof.
  if(m!=null)projected.internal_chat_message_metadata_passthrough=m.turn_id==null?{}:{turn_id:m.turn_id};
  return matchesNativeSchemaShape(projected,definitions.ResponseItem,definitions,nativeSourceShadow(p));
}
