import {randomUUID} from 'node:crypto';
import {db,getSessionById} from './state';
import {recordSessionEvent,retainSessionInput,sessionMetadata} from './session-inputs';
import type {TopicActor} from './session-topics';

export class AreaError extends Error {
  constructor(message:string,readonly status=400,readonly code='AREA_ERROR'){super(message);}
}

const nameKey=(name:string)=>name.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en-US');
const words=(value:unknown,label:string,max:number)=>{
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new AreaError(`${label} needs 1–${max} characters.`);
  return value.trim().replace(/\s+/g,' ');
};
const optional=(value:unknown,max:number)=>typeof value==='string'?value.trim().slice(0,max):'';
const row=(id:string)=>{
  const found=db.query('SELECT area_id AS id,name,summary,revision,created_at AS createdAt,updated_at AS updatedAt FROM inbox_areas WHERE area_id=?')
    .get(id) as {id:string;name:string;summary:string;revision:number;createdAt:string;updatedAt:string}|null;
  if(!found)throw new AreaError('Unknown area of interest.',404,'AREA_UNKNOWN');
  return found;
};
const topic=(id:string)=>{
  if(!db.query('SELECT 1 FROM inbox_topics WHERE topic_id=?').get(id))throw new AreaError('Unknown Inbox thread.',404,'AREA_THREAD_UNKNOWN');
  return id;
};
export function checkedAreaIds(input:unknown):string[]{
  if(!Array.isArray(input)||!input.length)throw new AreaError('Name at least one area for the new thread.');
  if(input.length>8)throw new AreaError('A new thread can name at most eight areas.');
  const ids=[...new Set(input.map(value=>words(value,'area id',100)))];
  for(const id of ids)row(id);
  return ids;
}
export function ensureSystemNoticeArea(sessionId:number){
  const id='area:system-notices';
  if(!db.query('SELECT 1 FROM inbox_areas WHERE area_id=?').get(id)){
    const payload={action:'create',area:{id,name:'System notices',summary:'Service notices filed by Concierge',at:new Date().toISOString()}};
    recordSessionEvent({eventId:'area:system-notices',sessionId,kind:'area',payload});
    applyAreaChange(payload);
  }
  return id;
}

/** The same event payload replays into the canonical projection. Names are display data;
 * all memberships and neighbors use stable IDs. */
export function applyAreaChange(payload:any){
  const action=String(payload.action??'');
  if(action==='create')db.query(`INSERT OR IGNORE INTO inbox_areas(area_id,name,name_key,summary,revision,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?)`).run(payload.area.id,payload.area.name,nameKey(payload.area.name),payload.area.summary,1,payload.area.at,payload.area.at);
  if(action==='rename')db.query('UPDATE inbox_areas SET name=?,name_key=?,revision=revision+1,updated_at=? WHERE area_id=?')
    .run(payload.name,nameKey(payload.name),payload.at,payload.areaId);
  if(action==='summary')db.query('UPDATE inbox_areas SET summary=?,revision=revision+1,updated_at=? WHERE area_id=?')
    .run(payload.summary,payload.at,payload.areaId);
  if(action==='link')db.query(`INSERT INTO inbox_area_threads(area_id,topic_id,origin,reason,created_at) VALUES(?,?,?,?,?)
    ON CONFLICT(area_id,topic_id) DO NOTHING`).run(payload.areaId,payload.topicId,payload.origin,payload.reason,payload.at);
  if(action==='unlink'){
    const count=(db.query('SELECT count(*) AS n FROM inbox_area_threads WHERE topic_id=?').get(payload.topicId) as {n:number}).n;
    if(count<=1&&db.query('SELECT 1 FROM inbox_area_threads WHERE area_id=? AND topic_id=?').get(payload.areaId,payload.topicId))
      throw new AreaError('A thread must keep at least one area.',409,'AREA_LAST_MEMBERSHIP');
    db.query('DELETE FROM inbox_area_threads WHERE area_id=? AND topic_id=?').run(payload.areaId,payload.topicId);
  }
  if(action==='neighbor')db.query(`INSERT INTO inbox_area_neighbors(left_area_id,right_area_id,origin,reason,created_at)
    VALUES(?,?,?,?,?) ON CONFLICT(left_area_id,right_area_id) DO NOTHING`)
    .run(payload.left,payload.right,payload.origin,payload.reason,payload.at);
  if(action==='unneighbor')db.query('DELETE FROM inbox_area_neighbors WHERE left_area_id=? AND right_area_id=?').run(payload.left,payload.right);
}

export function areasCommand(actor:TopicActor,body:any){
  const session=getSessionById(actor.sessionId);
  if(!session||!sessionMetadata(session).inbox)throw new AreaError('Only the Inbox router can organize areas.',403,'AREA_FORBIDDEN');
  const verb=String(body?.verb??'');
  if(verb==='list'){
    const query=optional(body?.query,200),limit=Math.max(1,Math.min(50,Number(body?.limit)||20));
    const prefix=nameKey(query),after=optional(body?.cursor,200);
    const rows=db.query(`SELECT area_id AS id,name,summary,revision,name_key AS nameKey FROM inbox_areas
      WHERE name_key>=? AND name_key<? AND name_key>? ORDER BY name_key LIMIT ?`)
      .all(prefix,prefix+'\uffff',after,limit+1) as any[];
    const page=rows.slice(0,limit);
    return {areas:page.map(({nameKey:_,...area})=>area),nextCursor:rows.length>limit?page.at(-1)!.nameKey:null};
  }
  if(verb==='suggest'){
    const query=words(body?.title,'thread title',200),tokens=new Set(nameKey(query).split(' '));
    const rows=db.query('SELECT area_id AS id,name,summary FROM inbox_areas ORDER BY name_key LIMIT 500').all() as any[];
    const suggestions=rows.map(area=>({...area,overlap:nameKey(area.name).split(' ').filter(token=>tokens.has(token)).length}))
      .filter(area=>area.overlap>0).sort((a,b)=>b.overlap-a.overlap||a.name.localeCompare(b.name)).slice(0,8);
    return {suggestions,coverage:{complete:rows.length<500,scanned:rows.length}};
  }
  const actionId=words(body?.action_id,'action id',200);
  const at=new Date().toISOString(),origin:'agent'='agent';
  const reason=optional(body?.reason,1000);
  let payload:any,result:any;
  if(verb==='create'){
    const name=words(body?.name,'area name',200),summary=optional(body?.summary,2000);
    const existing=db.query('SELECT area_id AS id FROM inbox_areas WHERE name_key=?').get(nameKey(name)) as {id:string}|null;
    if(existing)return {area:row(existing.id),existing:true};
    const area={id:`area:${randomUUID()}`,name,summary,at};
    payload={action:'create',area};result={area:{...area,revision:1}};
  } else if(verb==='rename'||verb==='summary'){
    const areaId=words(body?.area_id,'area id',100);row(areaId);
    payload=verb==='rename'?{action:verb,areaId,name:words(body?.name,'area name',200),at}:{action:verb,areaId,summary:optional(body?.summary,2000),at};
    result={areaId};
  } else if(verb==='link'||verb==='unlink'){
    const areaId=words(body?.area_id,'area id',100),topicId=words(body?.topic_id,'thread id',100);
    row(areaId);topic(topicId);
    payload={action:verb,areaId,topicId,origin,reason,at};result={areaId,topicId};
  } else if(verb==='neighbor'||verb==='unneighbor'){
    const first=words(body?.area_id,'area id',100),second=words(body?.other_area_id,'neighbor id',100);
    row(first);row(second);if(first===second)throw new AreaError('An area cannot neighbor itself.');
    const [left,right]=[first,second].sort();
    payload={action:verb,left,right,origin,reason,at};result={left,right};
  } else throw new AreaError('Unknown area command.');
  return db.transaction(()=>{
    const saved=retainSessionInput({sessionId:actor.sessionId,scope:`communication:${actor.inputId}`,actionId,
      kind:'action',origin:'agent',payload:{kind:`area-${verb}`,...payload},sourceInputId:actor.inputId,sourceRunId:actor.runId});
    if(saved.duplicate)return {...JSON.parse(saved.input.receipt_json??'{}').result,duplicate:true};
    recordSessionEvent({eventId:`area-change:${saved.input.id}`,sessionId:actor.sessionId,inputId:saved.input.id,
      turnId:actor.turnId,kind:'area',payload});
    applyAreaChange(payload);
    db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(JSON.stringify({state:'completed',result}),saved.input.id);
    return result;
  })();
}

function humanAreaMutation(clientActionId:unknown,payload:any,result:any){
  const actionId=words(clientActionId,'clientActionId',200);
  const inbox=db.query("SELECT id FROM sessions WHERE json_extract(native_metadata_json,'$.inbox')=1 ORDER BY id DESC LIMIT 1")
    .get() as {id:number}|null;
  if(!inbox)throw new AreaError('Inbox is unavailable.',503,'INBOX_UNAVAILABLE');
  return db.transaction(()=>{
    const saved=retainSessionInput({sessionId:inbox.id,scope:'surface:thinkering',actionId,
      kind:'area-action',origin:'human',payload});
    if(saved.duplicate)return {...JSON.parse(saved.input.receipt_json??'{}').result,duplicate:true};
    recordSessionEvent({eventId:`area-change:${saved.input.id}`,sessionId:inbox.id,inputId:saved.input.id,
      turnId:null,kind:'area',payload});
    applyAreaChange(payload);
    db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(JSON.stringify({state:'completed',result}),saved.input.id);
    return {...result,duplicate:false};
  })();
}
export function createAreaByHuman(body:any){
  const name=words(body?.name,'area name',200),summary=optional(body?.summary,2000);
  const existing=db.query('SELECT area_id AS id FROM inbox_areas WHERE name_key=?').get(nameKey(name)) as {id:string}|null;
  if(existing)return {area:row(existing.id),existing:true};
  const area={id:`area:${randomUUID()}`,name,summary,at:new Date().toISOString()};
  return humanAreaMutation(body?.clientActionId,{action:'create',area},{area:{...area,revision:1}});
}
export function areaHumanAction(areaId:string,body:any){
  row(areaId);
  const action=body?.action??{},kind=String(action.kind??''),at=new Date().toISOString();
  let payload:any,result:any={areaId};
  if(kind==='rename')payload={action:kind,areaId,name:words(action.name,'area name',200),at};
  else if(kind==='summary')payload={action:kind,areaId,summary:optional(action.summary,2000),at};
  else if(kind==='link'||kind==='unlink'){
    const topicId=topic(words(action.topicId,'thread id',100));
    payload={action:kind,areaId,topicId,origin:'human',reason:optional(action.reason,1000),at};
    result={areaId,topicId};
  } else if(kind==='neighbor'||kind==='unneighbor'){
    const other=words(action.otherAreaId,'neighbor id',100);row(other);
    if(other===areaId)throw new AreaError('An area cannot neighbor itself.');
    const [left,right]=[areaId,other].sort();
    payload={action:kind,left,right,origin:'human',reason:optional(action.reason,1000),at};
    result={left,right};
  } else throw new AreaError('Unknown area action.');
  return humanAreaMutation(body?.clientActionId,payload,result);
}
