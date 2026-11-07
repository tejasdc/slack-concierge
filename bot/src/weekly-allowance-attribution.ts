import type {Database} from 'bun:sqlite';

type Raw={input:number;cacheWrite:number;cacheWrite1h:number;cacheRead:number;output:number};
type Bucket={provider:string;account:string;window:string;atMs:number;sessionId:string|null;topicId:string|null;
  routineRootId:number|null;weighted:number;raw:Raw;calls:number};
type Reading={provider:string;account:string;window_name:string;observed_at_ms:number;used_percent:number;resets_at_ms:number|null};
type Meter={provider:string;account:string;window:string;usedPercent:number;resetsAt:string|null;observedAt:string;
  from:number|null;through:number|null;delta:number|null;denominator:number};
const QUARTER_HOUR=900_000;
const MAX_READING_AGE_MS=60*60_000;
const blank=():Raw=>({input:0,cacheWrite:0,cacheWrite1h:0,cacheRead:0,output:0});
const addRaw=(into:Raw,from:Raw)=>{for(const key of Object.keys(into) as (keyof Raw)[])into[key]+=from[key]??0;};
const key=(provider:string,account:string,window:string)=>JSON.stringify([provider,account,window]);
const iso=(ms:number)=>new Date(ms).toISOString();
const day=(ms:number,zone:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(ms);

/** Read only the provider's weekly samples. A missing or old sample never becomes zero use. */
export function weeklyReadings(db:Database,sinceMs:number):Reading[]{
  if(!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_usage_readings'").get())return [];
  return db.query(`SELECT provider,account,window_name,observed_at_ms,used_percent,resets_at_ms
    FROM provider_usage_readings WHERE observed_at_ms>=? AND (window_name='Weekly' OR window_name='Weekly · Fable only')
    ORDER BY provider,account,window_name,observed_at_ms`).all(sinceMs) as Reading[];
}

function meters(readings:Reading[],sinceMs:number,nowMs:number,buckets:Bucket[]):Map<string,Meter>{
  const groups=new Map<string,Reading[]>();
  for(const reading of readings){const id=key(reading.provider,reading.account,reading.window_name);
    const group=groups.get(id)??[];group.push(reading);groups.set(id,group);}
  const result=new Map<string,Meter>();
  for(const [id,group] of groups){
    const latest=group.at(-1)!;
    const reset=latest.resets_at_ms;
    const same=group.filter(row=>row.observed_at_ms>=sinceMs&&row.observed_at_ms<=latest.observed_at_ms
      &&reset!==null&&row.resets_at_ms!==null&&Math.abs(row.resets_at_ms-reset)<10*60_000
      &&row.used_percent<=latest.used_percent+0.5);
    const earliest=same[0];
    // Work after the included allowance reaches 100% may spend credits instead.
    const terminal=latest.used_percent>=99.5?same.find(row=>row.used_percent>=99.5)??latest:latest;
    const from=earliest&&terminal.observed_at_ms-earliest.observed_at_ms>=QUARTER_HOUR
      ?Math.ceil(earliest.observed_at_ms/QUARTER_HOUR)*QUARTER_HOUR:null;
    const through=from!==null?Math.floor(terminal.observed_at_ms/QUARTER_HOUR)*QUARTER_HOUR:null;
    const delta=from!==null&&through!==null&&through>from&&nowMs-latest.observed_at_ms<=MAX_READING_AGE_MS
      ?Math.max(0,terminal.used_percent-earliest!.used_percent):null;
    const denominator=delta!==null?buckets.filter(bucket=>key(bucket.provider,bucket.account,bucket.window)===id
      &&bucket.atMs>=from!&&bucket.atMs<through!).reduce((sum,bucket)=>sum+bucket.weighted,0):0;
    result.set(id,{provider:latest.provider,account:latest.account,window:latest.window_name,
      usedPercent:latest.used_percent,resetsAt:reset===null?null:iso(reset),observedAt:iso(latest.observed_at_ms),
      from,through,delta,denominator});
  }
  return result;
}

type Component={provider:string;account:string;window:string;usedPercent:number|null;basis:'estimated'|'unavailable';
  coverage:{from:string|null;through:string|null;observedDeltaPercent:number|null;transcriptWeighted:number;
    totalTranscriptWeighted:number;otherProviderUseUnknown:true;bucketMinutes:15}};
type Projection={usedPercent:number|null;basis:'estimated'|'unavailable';components:Component[];rawTokens:Raw;callCount:number};
type Accumulator={raw:Raw;calls:number;weighted:Map<string,number>};
const accumulator=():Accumulator=>({raw:blank(),calls:0,weighted:new Map()});
function projection(value:Accumulator,allMeters:Map<string,Meter>):Projection{
  const components=[...value.weighted].map(([id,weighted]):Component=>{
    const meter=allMeters.get(id),estimate=weighted>0&&meter?.delta!==null&&meter?.delta!==undefined&&meter.denominator>0
      ?meter.delta*weighted/meter.denominator:null;
    const [provider,account,window]=JSON.parse(id) as string[];
    return {provider,account,window,usedPercent:estimate,basis:estimate===null?'unavailable':'estimated',
      coverage:{from:meter?.from===null||meter?.from===undefined?null:iso(meter.from),
        through:meter?.through===null||meter?.through===undefined?null:iso(meter.through),
        observedDeltaPercent:meter?.delta??null,transcriptWeighted:weighted,totalTranscriptWeighted:meter?.denominator??0,
        otherProviderUseUnknown:true,bucketMinutes:15}};
  }).sort((a,b)=>a.provider.localeCompare(b.provider)||a.account.localeCompare(b.account)||a.window.localeCompare(b.window));
  const only=components.length===1?components[0]:null;
  return {usedPercent:only?.usedPercent??null,basis:only?.basis??'unavailable',components,rawTokens:value.raw,callCount:value.calls};
}

/** Called after all runner reports are merged, so a provider-meter delta is allocated once. */
export function attributeWeeklyAllowance(report:any,readings:Reading[],nowMs=Date.now()):any{
  const buckets=(report.attributionBuckets??[]) as Bucket[];
  const allMeters=meters(readings,Date.parse(report.since),nowMs,buckets);
  const sessions=new Map<string,Accumulator>(),threads=new Map<string,Accumulator>(),routines=new Map<string,Accumulator>(),days=new Map<string,Accumulator>();
  const accountSessions=new Map<string,Accumulator>(),routineDays=new Map<string,Accumulator>();
  const accountRows=new Map<string,Accumulator>();
  const put=(map:Map<string,Accumulator>,id:string,bucket:Bucket)=>{
    const value=map.get(id)??accumulator();addRaw(value.raw,bucket.raw);value.calls+=bucket.calls;
    const meterId=key(bucket.provider,bucket.account,bucket.window),meter=allMeters.get(meterId);
    if(meter?.delta!==null&&meter?.delta!==undefined&&bucket.atMs>=meter.from!&&bucket.atMs<meter.through!)
      value.weighted.set(meterId,(value.weighted.get(meterId)??0)+bucket.weighted);
    else if(!value.weighted.has(meterId))value.weighted.set(meterId,0);
    map.set(id,value);
  };
  for(const bucket of buckets){
    put(accountRows,JSON.stringify([bucket.provider,bucket.account]),bucket);
    put(sessions,bucket.sessionId??'unassigned',bucket);
    put(accountSessions,JSON.stringify([bucket.provider,bucket.account,bucket.sessionId??'unassigned']),bucket);
    put(threads,bucket.topicId??'unassigned',bucket);
    if(bucket.routineRootId!==null){
      put(routines,String(bucket.routineRootId),bucket);
      put(routineDays,JSON.stringify([bucket.routineRootId,day(bucket.atMs,report.timeZone)]),bucket);
    }
    put(days,day(bucket.atMs,report.timeZone),bucket);
  }
  const project=(map:Map<string,Accumulator>)=>Object.fromEntries([...map].map(([id,value])=>[id,projection(value,allMeters)]));
  const sessionAllowanceById=project(sessions),threadAllowanceById=project(threads),routineAllowanceById=project(routines),dayAllowanceByDate=project(days);
  const accounts=report.accounts.map((account:any)=>{
    const meter=allMeters.get(key(account.provider,account.account,'Weekly'));
    const measured=meter&&nowMs-Date.parse(meter.observedAt)<=MAX_READING_AGE_MS;
    const accountProjection=projection(accountRows.get(JSON.stringify([account.provider,account.account]))??accumulator(),allMeters);
    return {...account,weeklyAllowance:{usedPercent:measured?meter.usedPercent:null,basis:measured?'measured':'unavailable',
      resetsAt:measured?meter.resetsAt:null,observedAt:meter?.observedAt??null,
      estimatedUse:accountProjection},
      bySession:account.bySession.map((session:any)=>({...session,
        weeklyAllowance:projection(accountSessions.get(JSON.stringify([account.provider,account.account,session.address??'unassigned']))??accumulator(),allMeters)}))};
  });
  const {attributionBuckets:_,...rest}=report;
  return {...rest,accounts,sessionAllowanceById,threadAllowanceById,routineAllowanceById,dayAllowanceByDate,
    byThread:Object.entries(threadAllowanceById).filter(([id])=>id!=='unassigned').map(([topicId,weeklyAllowance])=>({topicId,weeklyAllowance})),
    byRoutine:Object.entries(routineAllowanceById).map(([rootId,weeklyAllowance])=>({rootId:Number(rootId),weeklyAllowance,
      byDay:[...routineDays].filter(([id])=>JSON.parse(id)[0]===Number(rootId)).map(([id,value])=>({date:JSON.parse(id)[1],weeklyAllowance:projection(value,allMeters)}))})),
    byDay:Object.entries(dayAllowanceByDate).map(([date,weeklyAllowance])=>({date,weeklyAllowance})).sort((a,b)=>a.date.localeCompare(b.date)),
    unassignedThread:threadAllowanceById.unassigned??projection(accumulator(),allMeters),
    allowanceMethod:'Provider weekly percentage change over the observed span is allocated by published API-price weighted transcript use in that same span. This is an estimate; other provider use is unknown, and percentages from different account meters are not added.'};
}

/** Display names come from the ledger after runner merge; IDs remain the join keys. */
export function nameAllowanceRows(report:any,db:Database):any{
  const tables=new Set((db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row=>row.name));
  const threadTitles=new Map<string,string>();
  if(tables.has('inbox_topics')){
    for(const row of report.byThread as {topicId:string}[]){
      const found=db.query('SELECT title FROM inbox_topics WHERE topic_id=?').get(row.topicId) as {title:string}|null;
      if(found?.title)threadTitles.set(row.topicId,found.title);
    }
  }
  const routineTitles=new Map<number,{title:string|null;sessionId:string}>();
  if(tables.has('turns')&&tables.has('sessions')){
    for(const row of report.byRoutine as {rootId:number}[]){
      const found=db.query(`SELECT turn.session_id,json_extract(session.native_metadata_json,'$.title') AS title
        FROM turns turn JOIN sessions session ON session.id=turn.session_id WHERE turn.id=?`).get(row.rootId) as {session_id:number;title:string|null}|null;
      if(found)routineTitles.set(row.rootId,{title:found.title,sessionId:`concierge:${found.session_id}`});
    }
  }
  return {...report,byThread:report.byThread.map((row:any)=>({...row,title:threadTitles.get(row.topicId)??null})),
    byRoutine:report.byRoutine.map((row:any)=>({...row,title:routineTitles.get(row.rootId)?.title??null,
      sessionId:routineTitles.get(row.rootId)?.sessionId??null}))};
}
