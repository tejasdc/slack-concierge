import type {Database} from 'bun:sqlite';

/**
 * Median cost per task, the metric Tejas asked for on 2026-11-25 after Kun Chen's note ("7d sliding
 * window median $ cost per task"): when agents do most of the work, a rising median says each piece
 * of work is getting harder for them, and the breakdown says why.
 *
 * A task is one thing an agent was asked to do: a request to an agent (each request it makes in turn
 * is its own task), else a message of his that started work, else one scheduled run
 * (work-thread-root.ts turnTaskIn). Its cost is every model call of the turns that served it, priced at
 * the providers' published API prices, plus its share of his combined weekly allowance.
 *
 * The usage report only keeps a week of model calls, so a task's numbers are written here once its
 * work is wholly inside that week and frozen when it ages out; this table, not the week, holds the
 * month the chart draws. It lives in the usage reader's own cache database, never the ledger.
 */
const DAY=86_400_000;
export const SERIES_DAYS=30;
const WINDOW_DAYS=7;
const PROJECTS_SHOWN=8;
const COSTLIEST_SHOWN=10;

export type TaskCost={task:string;sessionId:string|null;firstAtMs:number;lastAtMs:number;dollars:number|null;calls:number;
  raw:{input:number;cacheWrite:number;cacheWrite1h:number;cacheRead:number;output:number};combinedPercent:number|null;
  models:Record<string,number>;triggers:Record<string,number>};

export function ensureTaskCosts(cache:Database){
  cache.exec(`CREATE TABLE IF NOT EXISTS task_costs(task_id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT,project TEXT,session_id TEXT,
    started_ms INTEGER NOT NULL,last_ms INTEGER NOT NULL,dollars REAL NOT NULL,calls INTEGER NOT NULL,input_tokens INTEGER NOT NULL,
    cache_read INTEGER NOT NULL,output_tokens INTEGER NOT NULL,combined_percent REAL,models_json TEXT NOT NULL,triggers_json TEXT NOT NULL,
    updated_ms INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS task_costs_started ON task_costs(started_ms);`);
  // A task with finished turns but no observed model call is eligible and unmeasured, never $0.
  const columns=new Set((cache.query('PRAGMA table_info(task_costs)').all() as {name:string}[]).map(row=>row.name));
  if(!columns.has('measured'))cache.exec('ALTER TABLE task_costs ADD COLUMN measured INTEGER NOT NULL DEFAULT 1');
}

const basename=(path:string)=>path.replace(/\/+$/,'').split('/').pop()??path;

/** When the task began, by the ledger: the request's creation, else the input's acceptance. */
function taskStartMs(ledger:Database,task:string):number|null{
  try{
    if(task.startsWith('request:')){
      const row=ledger.query('SELECT created_at_ms FROM session_communication_requests WHERE request_id=?').get(task.slice('request:'.length)) as {created_at_ms:number}|null;
      if(row)return row.created_at_ms;
    }
    const row=ledger.query('SELECT created_at FROM session_inputs WHERE id=?').get(task) as {created_at:string}|null;
    const ms=row?Date.parse(`${row.created_at.replace(' ','T')}Z`):NaN;
    return Number.isFinite(ms)?ms:null;
  }catch{return null;}
}

/** What to call a task and which project it ran in, read from the owner's ledger. */
function describe(ledger:Database,task:string,sessionId:string|null){
  let title:string|null=null,kind='other';
  try{
    if(task.startsWith('request:')){
      kind='request';
      const row=ledger.query('SELECT payload_json FROM session_communication_requests WHERE request_id=?').get(task.slice('request:'.length)) as {payload_json:string}|null;
      const payload=row?JSON.parse(row.payload_json):null;
      title=typeof payload?.summary==='string'?payload.summary:null;
    }else{
      const row=ledger.query('SELECT origin,payload_json FROM session_inputs WHERE id=?').get(task) as {origin:string;payload_json:string}|null;
      if(row?.origin==='human')kind='message';
      const payload=row?JSON.parse(row.payload_json):null;
      const text=typeof payload?.text==='string'?payload.text:typeof payload?.content==='string'?payload.content:null;
      title=text?text.replace(/\s+/g,' ').trim().slice(0,120):null;
    }
  }catch{/* A record without readable words keeps its kind; the session title stands in below. */}
  let project:string|null=null,sessionTitle:string|null=null;
  const local=/^concierge:(\d+)$/.exec(sessionId??'');
  if(local){
    const row=ledger.query('SELECT native_metadata_json FROM sessions WHERE id=?').get(Number(local[1])) as {native_metadata_json:string}|null;
    try{const meta=JSON.parse(row?.native_metadata_json??'{}');
      const path=typeof meta.project==='string'?meta.project:typeof meta.cwd==='string'?meta.cwd:null;
      // A task worktree (<repository>/.wt/<task>) belongs to its repository.
      project=path?basename(path.split('/.wt/')[0]!):null;
      sessionTitle=typeof meta.title==='string'?meta.title:null;}catch{}
  }
  return {kind,title:title??sessionTitle,project,startedMs:taskStartMs(ledger,task)};
}

/**
 * Records each task that began inside the measured week. A task is written when first seen and
 * only grows after that: once its early calls leave the week the report sees just its tail, so a
 * later, smaller reading never replaces the larger one (review of 2026-11-25). A task that began
 * before the week was never wholly measured and is not written at all.
 */
export function recordTaskCosts(cache:Database,ledger:Database,tasks:TaskCost[],sinceMs:number,nowMs=Date.now()){
  ensureTaskCosts(cache);
  const known=cache.query('SELECT 1 FROM task_costs WHERE task_id=?');
  const insert=cache.query(`INSERT INTO task_costs(task_id,kind,title,project,session_id,started_ms,last_ms,dollars,calls,input_tokens,cache_read,
      output_tokens,combined_percent,models_json,triggers_json,updated_ms,measured) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const grow=cache.query(`UPDATE task_costs SET last_ms=max(last_ms,?),updated_ms=?,
      calls=CASE WHEN ?>dollars THEN ? ELSE calls END,input_tokens=CASE WHEN ?>dollars THEN ? ELSE input_tokens END,
      cache_read=CASE WHEN ?>dollars THEN ? ELSE cache_read END,output_tokens=CASE WHEN ?>dollars THEN ? ELSE output_tokens END,
      combined_percent=CASE WHEN ?>dollars THEN ? ELSE combined_percent END,models_json=CASE WHEN ?>dollars THEN ? ELSE models_json END,
      triggers_json=CASE WHEN ?>dollars THEN ? ELSE triggers_json END,measured=CASE WHEN ?>0 THEN 1 ELSE measured END,dollars=max(dollars,?) WHERE task_id=?`);
  cache.exec('BEGIN');
  try{
    for(const task of tasks){
      const measured=task.dollars!==null&&task.dollars>0;
      const written=task.raw.input+task.raw.cacheWrite+task.raw.cacheWrite1h,models=JSON.stringify(task.models),triggers=JSON.stringify(task.triggers);
      if(known.get(task.task)){
        if(!measured)continue;
        const d=task.dollars!;
        grow.run(task.lastAtMs,nowMs,d,task.calls,d,written,d,task.raw.cacheRead,d,task.raw.output,d,task.combinedPercent,d,models,d,triggers,d,d,task.task);
        continue;
      }
      const {kind,title,project,startedMs}=describe(ledger,task.task,task.sessionId);
      const began=startedMs??task.firstAtMs;
      if(began<sinceMs||task.firstAtMs<sinceMs+15*60_000)continue;
      insert.run(task.task,kind,title,project,task.sessionId,began,task.lastAtMs,measured?task.dollars:0,task.calls,written,task.raw.cacheRead,
        task.raw.output,task.combinedPercent,models,triggers,nowMs,measured?1:0);
    }
    cache.query('DELETE FROM task_costs WHERE started_ms<?').run(nowMs-60*DAY);
    cache.exec('COMMIT');
  }catch(error){cache.exec('ROLLBACK');throw error;}
}

const median=(values:number[])=>{
  if(!values.length)return null;
  const sorted=[...values].sort((a,b)=>a-b),middle=sorted.length>>1;
  return sorted.length%2?sorted[middle]!:(sorted[middle-1]!+sorted[middle]!)/2;
};
const localDay=(ms:number,zone:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(ms);
type Row={task_id:string;kind:string;title:string|null;project:string|null;session_id:string|null;started_ms:number;last_ms:number;measured:number;dollars:number;
  calls:number;input_tokens:number;cache_read:number;output_tokens:number;combined_percent:number|null;models_json:string;triggers_json:string};

/** Shares of cost, largest first, the rest summed as "other". */
function shares(rows:Row[],field:'models_json'|'triggers_json',keep:number){
  const totals=new Map<string,number>();
  for(const row of rows)for(const [name,value] of Object.entries(JSON.parse(row[field]) as Record<string,number>))totals.set(name,(totals.get(name)??0)+value);
  const all=[...totals].sort((a,b)=>b[1]-a[1]),sum=all.reduce((total,[,value])=>total+value,0);
  if(!sum)return [];
  const shown=all.slice(0,keep).map(([name,value])=>({name,share:value/sum}));
  const rest=all.slice(keep).reduce((total,[,value])=>total+value,0);
  return rest?[...shown,{name:'other',share:rest/sum}]:shown;
}

/**
 * The chart's data: for each of the last 30 days, the median over tasks started in the seven days
 * ending that day, overall and for the busiest projects, with what explains each window's median
 * (calls, context read per call, tokens written, models and what started the work) and the
 * costliest tasks of the latest week. A few tens of kilobytes, whatever the month held.
 */
export function taskCostSeries(cache:Database,timeZone:string,nowMs=Date.now()){
  ensureTaskCosts(cache);
  const rows=cache.query('SELECT * FROM task_costs WHERE started_ms>=? ORDER BY started_ms').all(nowMs-(SERIES_DAYS+WINDOW_DAYS)*DAY) as Row[];
  const today=localDay(nowMs,timeZone);
  const days=Array.from({length:SERIES_DAYS},(_,index)=>localDay(nowMs-(SERIES_DAYS-1-index)*DAY,timeZone)).filter((day,index,all)=>all.indexOf(day)===index);
  const byDay=new Map<string,Row[]>();
  // A task with calls in the last hour may still be running; it joins the median once it settles.
  for(const row of rows){if(row.last_ms>nowMs-60*60_000)continue;const day=localDay(row.started_ms,timeZone);
    const list=byDay.get(day);if(list)list.push(row);else byDay.set(day,[row]);}
  const windowRows=(day:string)=>{
    const end=Date.parse(`${day}T12:00:00Z`),list:Row[]=[];
    for(let back=0;back<WINDOW_DAYS;back++)list.push(...byDay.get(new Date(end-back*DAY).toISOString().slice(0,10))??[]);
    return list;
  };
  const projectCounts=new Map<string,number>();
  for(const row of rows)if(row.project)projectCounts.set(row.project,(projectCounts.get(row.project)??0)+1);
  const projects=[...projectCounts].sort((a,b)=>b[1]-a[1]).slice(0,PROJECTS_SHOWN).map(([name])=>name);
  const firstDay=rows.length?localDay(rows[0]!.started_ms,timeZone):today;
  const points=days.map(day=>{
    const eligible=windowRows(day),list=eligible.filter(row=>row.measured);
    return {date:day,tasks:list.length,eligible:eligible.length,median:median(list.map(row=>row.dollars)),
      medianCombinedPercent:median(list.map(row=>row.combined_percent).filter((value):value is number=>value!==null)),
      byProject:Object.fromEntries(projects.map(project=>[project,median(list.filter(row=>row.project===project).map(row=>row.dollars))])),
      byProjectCounts:Object.fromEntries(projects.map(project=>[project,{measured:list.filter(row=>row.project===project).length,eligible:eligible.filter(row=>row.project===project).length}])),
      medianCalls:median(list.map(row=>row.calls)),
      medianContextPerCall:median(list.filter(row=>row.calls>0).map(row=>row.cache_read/row.calls)),
      medianWritten:median(list.map(row=>row.input_tokens+row.output_tokens)),
      models:shares(list,'models_json',4),triggers:shares(list,'triggers_json',5)};
  });
  const latest=windowRows(today).filter(row=>row.measured);
  return {definition:'A task is one thing an agent was asked to do: a request to an agent, or a message of yours that started work. Its cost is every model call that served it, priced at published API rates: an estimate of value, not a charge.',
    windowDays:WINDOW_DAYS,days:SERIES_DAYS,recordedSince:firstDay,projects,points,
    costliest:[...latest].sort((a,b)=>b.dollars-a.dollars).slice(0,COSTLIEST_SHOWN).map(row=>({task:row.task_id,kind:row.kind,title:row.title,
      project:row.project,sessionId:row.session_id,startedAt:new Date(row.started_ms).toISOString(),dollars:row.dollars,calls:row.calls,
      combinedPercent:row.combined_percent,model:shares([row],'models_json',1)[0]?.name??null}))};
}
