import type {Database} from 'bun:sqlite';

type Raw={input:number;cacheWrite:number;cacheWrite1h:number;cacheRead:number;output:number};
type Bucket={provider:string;account:string;window:string;atMs:number;sessionId:string|null;topicId:string|null;
  routineRootId:number|null;weighted:number;raw:Raw;calls:number;conversation?:string|null};
type Reading={provider:string;account:string;window_name:string;observed_at_ms:number;used_percent:number;resets_at_ms:number|null};
/** One allowance period: the readings that share a reset instant. Its rise is shared only among work inside it. */
type Period={from:number;through:number;delta:number;denominator:number};
type Meter={provider:string;account:string;window:string;usedPercent:number;resetsAt:string|null;observedAt:string;periods:Period[]};
const QUARTER_HOUR=900_000;
const MAX_READING_AGE_MS=60*60_000;
const SAME_RESET_MS=10*60_000;
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

/**
 * Splits one meter's readings at each weekly reset. A week normally holds a reset, and work on
 * either side of it was measured by a different rise, so each period is shared out on its own.
 */
function resetPeriods(group:Reading[]):Reading[][]{
  const periods:Reading[][]=[];
  for(const reading of group){
    if(reading.resets_at_ms===null)continue;
    const current=periods.at(-1),reset=current?.at(-1)?.resets_at_ms;
    if(current&&reset!==null&&reset!==undefined&&Math.abs(reading.resets_at_ms-reset)<SAME_RESET_MS)current.push(reading);
    else periods.push([reading]);
  }
  return periods;
}

function meters(readings:Reading[],sinceMs:number,nowMs:number,buckets:Bucket[]):Map<string,Meter>{
  const groups=new Map<string,Reading[]>();
  for(const reading of readings){const id=key(reading.provider,reading.account,reading.window_name);
    const group=groups.get(id)??[];group.push(reading);groups.set(id,group);}
  const result=new Map<string,Meter>();
  for(const [id,group] of groups){
    const latest=group.at(-1)!;
    const fresh=nowMs-latest.observed_at_ms<=MAX_READING_AGE_MS;
    const all=resetPeriods(group);
    const periods:Period[]=[];
    all.forEach((period,index)=>{
      // The current period is only trusted while its readings are fresh; a closed one ended at its reset.
      if(index===all.length-1&&!fresh)return;
      const last=period.at(-1)!;
      const same=period.filter(row=>row.observed_at_ms>=sinceMs&&row.used_percent<=last.used_percent+0.5);
      const earliest=same[0];
      if(!earliest)return;
      // Work after the included allowance reaches 100% may spend credits instead.
      const terminal=last.used_percent>=99.5?same.find(row=>row.used_percent>=99.5)??last:last;
      if(terminal.observed_at_ms-earliest.observed_at_ms<QUARTER_HOUR)return;
      const from=Math.ceil(earliest.observed_at_ms/QUARTER_HOUR)*QUARTER_HOUR;
      const through=Math.floor(terminal.observed_at_ms/QUARTER_HOUR)*QUARTER_HOUR;
      if(through<=from)return;
      const denominator=buckets.filter(bucket=>key(bucket.provider,bucket.account,bucket.window)===id
        &&bucket.atMs>=from&&bucket.atMs<through).reduce((sum,bucket)=>sum+bucket.weighted,0);
      periods.push({from,through,delta:Math.max(0,terminal.used_percent-earliest.used_percent),denominator});
    });
    result.set(id,{provider:latest.provider,account:latest.account,window:latest.window_name,
      usedPercent:latest.used_percent,resetsAt:latest.resets_at_ms===null?null:iso(latest.resets_at_ms),
      observedAt:iso(latest.observed_at_ms),periods});
  }
  return result;
}

type Component={provider:string;account:string;window:string;usedPercent:number|null;basis:'estimated'|'unavailable';
  coverage:{from:string|null;through:string|null;observedDeltaPercent:number|null;transcriptWeighted:number;
    totalTranscriptWeighted:number;uncoveredTranscriptWeighted:number;complete:boolean;periods:number;
    otherProviderUseUnknown:true;bucketMinutes:15}};
type Projection={usedPercent:number|null;basis:'estimated'|'unavailable';components:Component[];rawTokens:Raw;callCount:number};
type Share={covered:Map<number,number>;uncovered:number};
type Accumulator={raw:Raw;calls:number;weighted:Map<string,Share>};
const accumulator=():Accumulator=>({raw:blank(),calls:0,weighted:new Map()});
function projection(value:Accumulator,allMeters:Map<string,Meter>):Projection{
  const components=[...value.weighted].map(([id,share]):Component=>{
    const meter=allMeters.get(id);
    let estimate:number|null=null,covered=0,delta=0,total=0,from:number|null=null,through:number|null=null;
    for(const [index,weighted] of share.covered){
      const period=meter?.periods[index];
      if(!period||period.denominator<=0)continue;
      estimate=(estimate??0)+period.delta*weighted/period.denominator;
      covered+=weighted;delta+=period.delta;total+=period.denominator;
      from=from===null?period.from:Math.min(from,period.from);through=through===null?period.through:Math.max(through,period.through);
    }
    if(covered<=0)estimate=null;
    const [provider,account,window]=JSON.parse(id) as string[];
    return {provider,account,window,usedPercent:estimate,basis:estimate===null?'unavailable':'estimated',
      coverage:{from:from===null?null:iso(from),through:through===null?null:iso(through),
        observedDeltaPercent:estimate===null?null:delta,transcriptWeighted:covered,totalTranscriptWeighted:total,
        uncoveredTranscriptWeighted:share.uncovered,complete:share.uncovered<=0,periods:share.covered.size,
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
    const value=map.get(id)??accumulator();
    // A Fable call is bucketed under both Claude meters it draws on; its tokens are counted once, under "Weekly".
    if(bucket.window==='Weekly'){addRaw(value.raw,bucket.raw);value.calls+=bucket.calls;}
    const meterId=key(bucket.provider,bucket.account,bucket.window),meter=allMeters.get(meterId);
    const share=value.weighted.get(meterId)??{covered:new Map(),uncovered:0};
    const index=meter?.periods.findIndex(period=>bucket.atMs>=period.from&&bucket.atMs<period.through)??-1;
    if(index>=0)share.covered.set(index,(share.covered.get(index)??0)+bucket.weighted);
    else share.uncovered+=bucket.weighted;
    value.weighted.set(meterId,share);
    map.set(id,value);
  };
  for(const bucket of buckets){
    put(accountRows,JSON.stringify([bucket.provider,bucket.account]),bucket);
    put(sessions,bucket.sessionId??'unassigned',bucket);
    put(accountSessions,JSON.stringify([bucket.provider,bucket.account,bucket.sessionId??bucket.conversation??'unassigned']),bucket);
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
        weeklyAllowance:projection(accountSessions.get(JSON.stringify([account.provider,account.account,
          session.address??(session.providerConversationId?`outside:${session.providerConversationId}`:'unassigned')]))??accumulator(),allMeters)}))};
  });
  const {attributionBuckets:_,...rest}=report;
  return {...rest,accounts,sessionAllowanceById,threadAllowanceById,
    byThread:Object.entries(threadAllowanceById).filter(([id])=>id!=='unassigned').map(([topicId,weeklyAllowance])=>({topicId,weeklyAllowance})),
    byRoutine:Object.entries(routineAllowanceById).map(([rootId,weeklyAllowance])=>({rootId:Number(rootId),weeklyAllowance,
      byDay:[...routineDays].filter(([id])=>JSON.parse(id)[0]===Number(rootId)).map(([id,value])=>({date:JSON.parse(id)[1],weeklyAllowance:projection(value,allMeters)}))})),
    byDay:Object.entries(dayAllowanceByDate).map(([date,weeklyAllowance])=>({date,weeklyAllowance})).sort((a,b)=>a.date.localeCompare(b.date)),
    unassignedThread:threadAllowanceById.unassigned??projection(accumulator(),allMeters),
    allowanceMethod:'Each weekly reset period\'s provider percentage rise is allocated by published API-price weighted transcript use in that same period. This is an estimate; other use of the same account is unknown, work outside a measured period is reported as uncovered, and percentages from different account meters are not added. A routine counts only its own scheduled turns; work it hands to other sessions is counted under those sessions and threads.'};
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
