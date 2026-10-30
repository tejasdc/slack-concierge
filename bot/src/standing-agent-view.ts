import {relative} from 'node:path';
import type {Database} from 'bun:sqlite';
import type {SessionRow} from './state';
import {STANDING_AGENTS} from './standing-agents';
import {sessionAddress} from './session-address';
import {sessionMetadata} from './session-inputs';

const MAX_SCHEDULES=32;
const MAX_WATCHES_PER_AGENT=20;
const MAX_LINE=200;

type ScheduleRow={repeat_turn_id:number;saved_root_id:number;saved_repeat_ms:number;
  saved_fire_at_ms:number|null;dispatch_next_attempt_ms:number|null};
type RepeatRow=SessionRow&ScheduleRow;
type EndedRow={id:number;ended_at:string;agent_text:string|null;status:string};

function oneLine(value:unknown):string|null {
  if(typeof value!=='string')return null;
  const line=value.replace(/\s+/g,' ').trim();
  return line?line.slice(0,MAX_LINE):null;
}
function instant(value:number|string|null|undefined):string|null {
  if(value===null||value===undefined)return null;
  const parsed=typeof value==='number'?value:Date.parse(value.includes('T')?value:`${value.replace(' ','T')}Z`);
  return Number.isFinite(parsed)?new Date(parsed).toISOString():null;
}
function lastRun(db:Database,sessionId:number,rootId?:number) {
  const row=(rootId===undefined
    ?db.query(`SELECT id,ended_at,status,substr(agent_text,1,400) AS agent_text FROM turns
      WHERE session_id=? AND ended_at IS NOT NULL ORDER BY id DESC LIMIT 1`).get(sessionId)
    :db.query(`SELECT id,ended_at,status,substr(agent_text,1,400) AS agent_text FROM turns
      WHERE saved_root_id=? AND ended_at IS NOT NULL ORDER BY saved_sequence DESC LIMIT 1`).get(rootId)) as EndedRow|null;
  if(!row)return null;
  const event=db.query(`SELECT payload_json FROM session_owner_events WHERE turn_id=? AND kind='turn_outcome'
    ORDER BY sequence DESC LIMIT 1`).get(row.id) as {payload_json:string}|null;
  const declared=event?JSON.parse(event.payload_json) as {outcome?:string;question?:string;summary?:string}:null;
  return {endedAt:instant(row.ended_at),outcome:declared?.outcome??null,
    summary:oneLine(declared?.summary??declared?.question??row.agent_text),status:row.status};
}
function schedule(row:ScheduleRow|null) {
  return row?{turnId:row.repeat_turn_id,rootTurnId:row.saved_root_id,intervalMs:row.saved_repeat_ms,
    nextFiringAt:instant(row.saved_fire_at_ms??row.dispatch_next_attempt_ms)}:null;
}
function sessionView(row:SessionRow|null) {
  if(!row)return null;
  const meta=sessionMetadata(row);
  return {id:`concierge:${row.id}`,address:sessionAddress(row),title:meta.title??null,provider:row.provider_id,model:meta.model??null};
}

/** Finite role list plus a capped indexed walk of currently queued repeating firings. */
export function standingAgentView(db:Database,workspaceRoot:string) {
  const repeatRows=db.query(`SELECT session.*,turn.id AS repeat_turn_id,turn.saved_root_id,turn.saved_repeat_ms,
    turn.saved_fire_at_ms,turn.dispatch_next_attempt_ms FROM turns turn JOIN sessions session ON session.id=turn.session_id
    WHERE turn.status='queued' AND turn.saved_kind='scheduled' AND turn.saved_repeat_ms IS NOT NULL
    ORDER BY turn.id LIMIT ?`).all(MAX_SCHEDULES+1) as RepeatRow[];
  const incomplete=repeatRows.length>MAX_SCHEDULES;
  const repeats=repeatRows.slice(0,MAX_SCHEDULES);
  const agents=STANDING_AGENTS.map(agent=>{
    const row=db.query(`SELECT * FROM sessions WHERE status!='archived'
      AND json_extract(native_metadata_json,'$.standingRole')=? ORDER BY id DESC LIMIT 1`).get(agent.role) as SessionRow|null;
    const bound=row&&relative(workspaceRoot,sessionMetadata(row).cwd??'')===agent.project?row:null;
    const own=bound?db.query(`SELECT id AS repeat_turn_id,saved_root_id,saved_repeat_ms,saved_fire_at_ms,dispatch_next_attempt_ms
      FROM turns WHERE session_id=? AND status='queued' AND saved_kind='scheduled' AND saved_repeat_ms IS NOT NULL
      ORDER BY id LIMIT 1`).get(bound.id) as ScheduleRow|null:null;
    const armed=bound?db.query(`SELECT watch_id,kind,
      substr(COALESCE(json_extract(condition_json,'$.path'),json_extract(condition_json,'$.argv[0]'),'unknown'),1,200) AS what
      FROM watches
      WHERE session_id=? AND state IN ('accepted','observing') ORDER BY watch_id LIMIT ?`)
      .all(bound.id,MAX_WATCHES_PER_AGENT+1) as {watch_id:string;kind:string;what:string}[]:[];
    const watchCount=bound?(db.query(`SELECT count(*) AS count FROM watches WHERE session_id=?
      AND state IN ('accepted','observing')`).get(bound.id) as {count:number}).count:0;
    return {role:agent.role,job:agent.description,folder:agent.project,wake:agent.wake,
      binding:bound?'bound':'unbound',session:sessionView(bound),repeatingSchedule:schedule(own),
      armedWatches:{count:watchCount,
      items:armed.slice(0,MAX_WATCHES_PER_AGENT).map(watch=>({
        id:watch.watch_id,kind:watch.kind,what:oneLine(watch.what)}))},lastRun:bound?lastRun(db,bound.id):null};
  });
  const owned=new Set(agents.filter(agent=>agent.binding==='bound').map(agent=>agent.session!.address));
  const unowned=repeats.flatMap(repeat=>{
    const session=sessionView(repeat)!;
    if(owned.has(session.address))return [];
    const cwd=sessionMetadata(repeat).cwd;
    return [{kind:'unowned' as const,session,folder:cwd?relative(workspaceRoot,cwd):null,
      repeatingSchedule:schedule(repeat)!,lastRun:lastRun(db,repeat.id,repeat.saved_root_id)}];
  });
  return {agents,unownedSchedules:unowned,coverage:{complete:!incomplete,limit:MAX_SCHEDULES,
    ...(incomplete?{note:'More repeating schedules exist than this bounded view can show.'}:{})}};
}
