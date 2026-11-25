import type {Database} from 'bun:sqlite';

type Raw={input:number;cacheWrite:number;cacheWrite1h:number;cacheRead:number;output:number};
type Bucket={provider:string;account:string;window:string;atMs:number;sessionId:string|null;topicId:string|null;
  routineRootId:number|null;weighted:number;raw:Raw;calls:number;conversation?:string|null;unlinked?:string|null;
  task?:string|null};
type Reading={provider:string;account:string;window_name:string;observed_at_ms:number;used_percent:number;resets_at_ms:number|null};
/** One allowance period: the readings that share a reset instant. Its rise is shared only among work inside it. */
type Period={from:number;through:number;delta:number;denominator:number};
type Meter={provider:string;account:string;window:string;usedPercent:number;resetsAt:string|null;observedAt:string;periods:Period[];
  /** The period the provider's latest reading belongs to, when it is fresh and measured; the share the bar in Accounts divides. */
  currentIndex:number|null};
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
    let currentIndex:number|null=null;
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
      if(index===all.length-1)currentIndex=periods.length;
      periods.push({from,through,delta:Math.max(0,terminal.used_percent-earliest.used_percent),denominator});
    });
    result.set(id,{provider:latest.provider,account:latest.account,window:latest.window_name,
      usedPercent:latest.used_percent,resetsAt:latest.resets_at_ms===null?null:iso(latest.resets_at_ms),
      observedAt:iso(latest.observed_at_ms),periods,currentIndex});
  }
  return result;
}

type Component={provider:string;account:string;window:string;usedPercent:number|null;currentPeriodPercent:number|null;basis:'estimated'|'unavailable';
  coverage:{from:string|null;through:string|null;observedDeltaPercent:number|null;transcriptWeighted:number;
    totalTranscriptWeighted:number;uncoveredTranscriptWeighted:number;complete:boolean;periods:number;
    otherProviderUseUnknown:true;bucketMinutes:15}};
type Combined={usedPercent:number|null;currentPeriodPercent:number|null;accounts:number;complete:boolean};
type Projection={usedPercent:number|null;basis:'estimated'|'unavailable';components:Component[];rawTokens:Raw;callCount:number;
  combined:Combined&{byProvider:(Combined&{provider:string})[]}};

/**
 * One weekly figure for work, across every subscription he pays for: each account's estimated
 * share added up and divided by the number of accounts with a current weekly reading, so it reads
 * as a share of his whole weekly allowance. Each account counts as one equal unit, as he counts
 * them ("we have 3 Claude accounts and only 2 Codex accounts ... aggregated usage per provider",
 * 2026-11-16); the same rule within one provider gives the per-provider figures. Tejas asked on
 * 2026-11-16 for this one aggregate everywhere, with accounts only when he opens the breakdown.
 */
function combine(components:Component[],capacity:Map<string,number>,provider?:string):Combined{
  const parts=components.filter(part=>part.window==='Weekly'&&part.basis==='estimated'&&(!provider||part.provider===provider));
  const accounts=provider?capacity.get(provider)??0:[...capacity.values()].reduce((sum,count)=>sum+count,0);
  const total=(pick:(part:Component)=>number|null)=>{
    const values=parts.map(pick).filter((value):value is number=>value!==null);
    return accounts>0&&values.length?values.reduce((sum,value)=>sum+value,0)/accounts:null;
  };
  return {usedPercent:total(part=>part.usedPercent),currentPeriodPercent:total(part=>part.currentPeriodPercent),accounts,
    complete:parts.every(part=>part.coverage.complete)};
}
/** Accounts that count toward the combined figure: a weekly meter with a fresh current reading and a known account. */
function weeklyCapacity(allMeters:Map<string,Meter>):Map<string,number>{
  const capacity=new Map<string,number>();
  for(const meter of allMeters.values())
    if(meter.window==='Weekly'&&!meter.account.startsWith('unknown')&&meter.currentIndex!==null&&meter.currentIndex!==undefined)
      capacity.set(meter.provider,(capacity.get(meter.provider)??0)+1);
  return capacity;
}
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
    // The share of the current reset period alone, so it divides the provider's current reading
    // rather than a week that may span the previous reset.
    const current=meter?.currentIndex===null||meter?.currentIndex===undefined?null:meter.periods[meter.currentIndex];
    const currentWeighted=meter?.currentIndex===null||meter?.currentIndex===undefined?0:share.covered.get(meter.currentIndex)??0;
    const currentPeriodPercent=current&&current.denominator>0?current.delta*currentWeighted/current.denominator:null;
    const [provider,account,window]=JSON.parse(id) as string[];
    return {provider,account,window,usedPercent:estimate,currentPeriodPercent,basis:estimate===null?'unavailable':'estimated',
      coverage:{from:from===null?null:iso(from),through:through===null?null:iso(through),
        observedDeltaPercent:estimate===null?null:delta,transcriptWeighted:covered,totalTranscriptWeighted:total,
        uncoveredTranscriptWeighted:share.uncovered,complete:share.uncovered<=0,periods:share.covered.size,
        otherProviderUseUnknown:true,bucketMinutes:15}};
  }).sort((a,b)=>a.provider.localeCompare(b.provider)||a.account.localeCompare(b.account)||a.window.localeCompare(b.window));
  const only=components.length===1?components[0]:null;
  const capacity=weeklyCapacity(allMeters);
  return {usedPercent:only?.usedPercent??null,basis:only?.basis??'unavailable',components,rawTokens:value.raw,callCount:value.calls,
    combined:{...combine(components,capacity),byProvider:[...capacity.keys()].sort()
      .map(provider=>({provider,...combine(components,capacity,provider)}))}};
}

/** How many unlinked sessions each account names; the rest are counted, not listed. */
const UNLINKED_SESSIONS_SHOWN=12;
/** Ranked by the share Accounts draws: the current reset period's, else the seven-day estimate. */
const accountShare=(value:Projection,provider:string,account:string)=>{
  const part=value.components.find(part=>part.provider===provider&&part.account===account&&part.window==='Weekly');
  return part?.currentPeriodPercent??part?.usedPercent??-1;
};

/** Called after all runner reports are merged, so a provider-meter delta is allocated once. */
export function attributeWeeklyAllowance(report:any,readings:Reading[],nowMs=Date.now()):any{
  const buckets=(report.attributionBuckets??[]) as Bucket[];
  const allMeters=meters(readings,Date.parse(report.since),nowMs,buckets);
  const sessions=new Map<string,Accumulator>(),threads=new Map<string,Accumulator>(),routines=new Map<string,Accumulator>(),days=new Map<string,Accumulator>();
  const accountSessions=new Map<string,Accumulator>(),routineDays=new Map<string,Accumulator>();
  const accountRows=new Map<string,Accumulator>();
  // Work no thread explains, per account: by session and by what started it.
  const unlinkedSessions=new Map<string,Accumulator>(),unlinkedTriggers=new Map<string,Accumulator>();
  const sessionTriggers=new Map<string,Map<string,number>>();
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
  // One record per task: what it cost at published prices, its share of the combined allowance,
  // and what explains that cost (models, calls, context read, what started its turns).
  const taskRows=new Map<string,{value:Accumulator;sessionId:string|null;first:number;last:number}>();
  for(const bucket of buckets){
    if(bucket.task){
      const row=taskRows.get(bucket.task)??{value:accumulator(),sessionId:bucket.sessionId,first:bucket.atMs,last:bucket.atMs};
      const holder=new Map([[bucket.task,row.value]]);put(holder,bucket.task,bucket);row.value=holder.get(bucket.task)!;
      row.first=Math.min(row.first,bucket.atMs);row.last=Math.max(row.last,bucket.atMs);
      taskRows.set(bucket.task,row);
    }
    put(accountRows,JSON.stringify([bucket.provider,bucket.account]),bucket);
    put(sessions,bucket.sessionId??'unassigned',bucket);
    put(accountSessions,JSON.stringify([bucket.provider,bucket.account,bucket.sessionId??bucket.conversation??'unassigned']),bucket);
    put(threads,bucket.topicId??'unassigned',bucket);
    if(bucket.routineRootId!==null){
      put(routines,String(bucket.routineRootId),bucket);
      put(routineDays,JSON.stringify([bucket.routineRootId,day(bucket.atMs,report.timeZone)]),bucket);
    }
    put(days,day(bucket.atMs,report.timeZone),bucket);
    if(bucket.topicId===null){
      const sessionKey=JSON.stringify([bucket.provider,bucket.account,bucket.sessionId??bucket.conversation??'unassigned']);
      const trigger=bucket.unlinked??'not recorded';
      put(unlinkedSessions,sessionKey,bucket);
      put(unlinkedTriggers,JSON.stringify([bucket.provider,bucket.account,trigger]),bucket);
      if(bucket.window==='Weekly'){const triggers=sessionTriggers.get(sessionKey)??new Map<string,number>();
        triggers.set(trigger,(triggers.get(trigger)??0)+bucket.weighted);sessionTriggers.set(sessionKey,triggers);}
    }
  }
  const project=(map:Map<string,Accumulator>)=>Object.fromEntries([...map].map(([id,value])=>[id,projection(value,allMeters)]));
  const sessionAllowanceById=project(sessions),threadAllowanceById=project(threads),routineAllowanceById=project(routines),dayAllowanceByDate=project(days);
  const accounts=report.accounts.map((account:any)=>{
    const meter=allMeters.get(key(account.provider,account.account,'Weekly'));
    const measured=meter&&nowMs-Date.parse(meter.observedAt)<=MAX_READING_AGE_MS;
    const accountProjection=projection(accountRows.get(JSON.stringify([account.provider,account.account]))??accumulator(),allMeters);
    const prefix=JSON.stringify([account.provider,account.account]).slice(0,-1)+',';
    const titles=new Map<string,any>((account.bySession??[]).map((session:any)=>
      [session.address??(session.providerConversationId?`outside:${session.providerConversationId}`:'unassigned'),session]));
    const ranked=(map:Map<string,Accumulator>)=>[...map].filter(([id])=>id.startsWith(prefix))
      .map(([id,value])=>({id:(JSON.parse(id) as string[])[2]!,weeklyAllowance:projection(value,allMeters)}))
      .map(row=>({...row,rank:accountShare(row.weeklyAllowance,account.provider,account.account)}))
      .sort((a,b)=>b.rank-a.rank);
    const sessionRows=ranked(unlinkedSessions);
    const notInThread={
      byTrigger:ranked(unlinkedTriggers).map(row=>({trigger:row.id,weeklyAllowance:row.weeklyAllowance})),
      sessionCount:sessionRows.length,
      bySession:sessionRows.slice(0,UNLINKED_SESSIONS_SHOWN).map(row=>{
        const session=titles.get(row.id),triggers=[...(sessionTriggers.get(JSON.stringify([account.provider,account.account,row.id]))??new Map<string,number>())]
          .sort((a,b)=>b[1]-a[1]).map(([trigger])=>trigger);
        return {address:session?.address??(row.id.startsWith('concierge:')?row.id:null),title:session?.title??null,project:session?.project??null,
          triggers,weeklyAllowance:row.weeklyAllowance};
      })};
    return {...account,weeklyAllowance:{usedPercent:measured?meter.usedPercent:null,basis:measured?'measured':'unavailable',
      resetsAt:measured?meter.resetsAt:null,observedAt:meter?.observedAt??null,
      estimatedUse:accountProjection},notInThread,
      bySession:account.bySession.map((session:any)=>({...session,
        weeklyAllowance:projection(accountSessions.get(JSON.stringify([account.provider,account.account,
          session.address??(session.providerConversationId?`outside:${session.providerConversationId}`:'unassigned')]))??accumulator(),allMeters)}))};
  });
  // The measured reading behind the combined figure: every counted account's own weekly reading, averaged.
  const counted=[...allMeters.values()].filter(meter=>meter.window==='Weekly'&&!meter.account.startsWith('unknown')
    &&meter.currentIndex!==null&&meter.currentIndex!==undefined);
  const average=(list:Meter[])=>list.length?list.reduce((sum,meter)=>sum+meter.usedPercent,0)/list.length:null;
  const combinedWeekly={usedPercent:average(counted),accounts:counted.length,
    byProvider:[...new Set(counted.map(meter=>meter.provider))].sort().map(provider=>{
      const own=counted.filter(meter=>meter.provider===provider);
      return {provider,usedPercent:average(own),accounts:own.length};
    })};
  const weeklyWeighted=(value:Accumulator)=>[...value.weighted].filter(([id])=>(JSON.parse(id) as string[])[2]==='Weekly')
    .reduce((sum,[,share])=>sum+[...share.covered.values()].reduce((a,b)=>a+b,0)+share.uncovered,0);
  const taskCosts=[...taskRows].map(([task,row])=>{
    const value=projection(row.value,allMeters);
    return {task,sessionId:row.sessionId,firstAtMs:row.first,lastAtMs:row.last+QUARTER_HOUR,dollars:weeklyWeighted(row.value),
      calls:value.callCount,raw:value.rawTokens,combinedPercent:value.combined.usedPercent,
      models:report.taskMix?.[task]?.models??{},triggers:report.taskMix?.[task]?.triggers??{}};
  });
  // Tasks with finished turns but no observed model call: eligible, unmeasured, never a zero.
  for(const [task,turns] of Object.entries(report.taskTurns??{}) as [string,{startedMs:number;sessionId?:string}][])
    if(!taskRows.has(task))taskCosts.push({task,sessionId:turns.sessionId??null,firstAtMs:turns.startedMs,lastAtMs:turns.startedMs,dollars:null,calls:0,
      raw:blank(),combinedPercent:null,models:{},triggers:{}} as any);
  const {attributionBuckets:_,taskMix:_mix,taskTurns:_turns,...rest}=report;
  return {...rest,taskCosts,accounts,combinedWeekly,sessionAllowanceById,threadAllowanceById,
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
