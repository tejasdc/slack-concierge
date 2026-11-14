import {nativeSourceValueDigest as digest} from './codex-native-source-values';

// Transcription of the pinned 0.162 agents_md/environment render_diff domain.
// This consumes captured state only; it does not discover or authorize state.
export const CONTEXT_TRANSITION_INTERPRETATION='native_0162_adjacent_context_v1' as const;
const obj=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const closed=(v:any,keys:string[])=>obj(v)&&Object.keys(v).every(k=>keys.includes(k));
const optionString=(v:any)=>v==null||typeof v==='string';
const same=(a:any,b:any)=>a===undefined||b===undefined?a===b:digest(a)===digest(b);
export class ContextTransitionRefusal extends Error {
  constructor(readonly code:string){super(code);}
}
const fail=(code:string):never=>{throw new ContextTransitionRefusal(code);};
function agents(v:any){
  if(v===undefined)return {directory:null,text:null};
  if(!closed(v,['directory','text'])||!optionString(v.directory)||!optionString(v.text))fail('ADJACENT_AGENTS_SHAPE_UNSUPPORTED');
  return {directory:v.directory??null,text:v.text??null};
}
const environmentFields=['environments','shell_version','current_date','timezone','network','filesystem','subagents'];
function environments(v:any){
  if(v===undefined)return {environments:{},shell_version:null,current_date:null,timezone:null,network:null,filesystem:null,subagents:null};
  if(!closed(v,environmentFields)||!obj(v.environments)
    ||environmentFields.slice(1).some(k=>!optionString(v[k])))fail('ADJACENT_ENVIRONMENT_SHAPE_UNSUPPORTED');
  const entries=Object.entries(v.environments);
  if(entries.length>1)fail('ADJACENT_ENVIRONMENT_DOMAIN_UNSUPPORTED');
  const normalized:Record<string,any>=Object.create(null);
  for(const [id,e] of entries){
    if(!id||!closed(e,['cwd','status','error','shell','is_primary'])||typeof e.cwd!=='string'
      ||!e.cwd.startsWith('/')||e.status!=='available'||!optionString(e.error)||!optionString(e.shell)
      ||e.is_primary!==undefined&&typeof e.is_primary!=='boolean'||e.is_primary===true)
      fail('ADJACENT_ENVIRONMENT_DOMAIN_UNSUPPORTED');
    normalized[id]={cwd:e.cwd,status:e.status,error:e.error??null,shell:e.shell??null,is_primary:e.is_primary??false};
  }
  return {environments:normalized,...Object.fromEntries(environmentFields.slice(1).map(k=>[k,v[k]??null]))} as any;
}
const xml=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
// Rust str::lines splits LF and CRLF only; it preserves a final lone CR and
// Unicode separators, and emits no trailing empty line.
export function nativeRustLines(s:string):string[]{
  if(s==='')return [];
  const parts=s.split('\n');
  const result=parts.map((part,i)=>i<parts.length-1&&part.endsWith('\r')?part.slice(0,-1):part);
  if(s.endsWith('\n'))result.pop();return result;
}
function renderAgents(before:any,after:any):string|null{
  if(same(before,after))return null;
  let text=after.text;
  if(text!==null&&before.text!==null)text='These AGENTS.md instructions replace all previously provided AGENTS.md instructions.\n\n'+text;
  if(text===null){
    if(before.text===null)return null;
    return '# AGENTS.md instructions\n\n<INSTRUCTIONS>\nThe previously provided AGENTS.md instructions no longer apply.\n</INSTRUCTIONS>';
  }
  return '# AGENTS.md instructions'+(after.directory===null?'':' for '+after.directory)+'\n\n<INSTRUCTIONS>\n'+text+'\n</INSTRUCTIONS>';
}
function renderEnvironment(before:any,after:any):string|null{
  const previous=Object.entries(before.environments),current=Object.entries(after.environments);
  if(current.length===0&&previous.length===0&&same(before,after))return null;
  if(current.length!==1||previous.length&&previous[0][0]!==current[0][0])fail('ADJACENT_ENVIRONMENT_DOMAIN_UNSUPPORTED');
  const e:any=current[0][1],prior:any=previous[0]?.[1];
  const added=after.shell_version!==null&&before.shell_version===null;
  const sameEnvironment=prior&&['cwd','status','error','is_primary'].every(k=>same(e[k],prior[k]))
    &&(e.shell===null||prior.shell===null||e.shell===prior.shell);
  const update=!sameEnvironment||added&&prior?.shell===null;
  const changed=['shell_version','current_date','timezone','network','filesystem'].some(k=>!same(before[k],after[k]));
  if(!update&&!changed)return null; // subagents alone does not emit a fragment
  let text='\n';
  if(update){
    text+='  <cwd>'+xml(e.cwd)+'</cwd>\n';
    for(const k of ['error','shell'])if(e[k]!==null)text+='  <'+k+'>'+xml(e[k])+'</'+k+'>\n';
  }
  for(const k of ['shell_version','current_date','timezone']){
    if(k!=='timezone'&&after[k]===null&&before[k]!==null)text+='  <'+k+' status="unavailable" />\n';
    else if(after[k]!==null)text+='  <'+k+'>'+xml(after[k])+'</'+k+'>\n';
  }
  for(const k of ['network','filesystem'])if(after[k]!==null)text+='  '+after[k]+'\n';
  if(after.subagents!==null)text+='  <subagents>\n'+nativeRustLines(after.subagents).map(line=>'    '+line+'\n').join('')+'  </subagents>\n';
  return '<environment_context>'+text+'</environment_context>';
}
export function renderAdjacentContextTransition(before:any,after:any,patch:any){
  if(!obj(before)||!obj(after)||!obj(patch)||Object.keys(patch).some(k=>!['agents_md','environments'].includes(k)))
    fail('ADJACENT_WORLD_PATCH_SECTION_UNSUPPORTED');
  const a=agents(before.agents_md),b=agents(after.agents_md),e=environments(before.environments),f=environments(after.environments);
  // Fields that deserialize with defaults are accounted for without replacing
  // the original source identities. Unknown section/field data never disappears.
  if(obj(patch.agents_md)&&!closed(patch.agents_md,['directory','text'])
    ||obj(patch.environments)&&!closed(patch.environments,environmentFields))fail('ADJACENT_WORLD_PATCH_FIELD_UNSUPPORTED');
  if(obj(patch.environments)&&Object.hasOwn(patch.environments,'environments')){
    const entries=patch.environments.environments;
    if(!obj(entries)||Object.values(entries).some(e=>!closed(e,['cwd','status','error','shell','is_primary'])))
      fail('ADJACENT_ENVIRONMENT_PATCH_DOMAIN_UNSUPPORTED');
  }
  const fragments:{kind:string;text:string}[]=[];
  const instructions=renderAgents(a,b),environment=renderEnvironment(e,f);
  if(instructions!==null)fragments.push({kind:'agents_md.instructions',text:instructions});
  if(environment!==null)fragments.push({kind:'environments.environment_context',text:environment});
  return {fragments,changedSections:Object.keys(patch).filter(k=>!same(before[k],after[k])),
    changedEnvironmentFields:environmentFields.filter(k=>!same(e[k],f[k])),
    agents:{before:digest(a),after:digest(b),beforeTextDigest:digest(a.text),afterTextDigest:digest(b.text),
      beforeTextBytes:a.text===null?0:Buffer.byteLength(a.text),afterTextBytes:b.text===null?0:Buffer.byteLength(b.text),
      instructionTextChanged:a.text!==b.text,materiality:'unassessed_including_cutoff' as const},
    environment:{before:digest(e),after:digest(f)}};
}
