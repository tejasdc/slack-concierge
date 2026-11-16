/**
 * The usage breakdown as the Accounts "Who used it" page draws it.
 *
 * The full report names every conversation of the period with its call mix, cache diagnostics,
 * thread, routine and day rows. On 2026-11-16 a week held 1,546 conversations and 4.6 MB, and a
 * day 1.3 MB, so the page's read (declared at 1 MiB) was refused for both periods. Use is a long
 * tail: the 200 largest conversations carried three quarters of the week. The page therefore gets
 * those in full and, per account and project, one row summing everything smaller, so its project,
 * model and account totals stay exact while it lists what anyone reads. Agents keep the full report
 * through `router-actions.sh sessions usage --by-session`.
 */
type Raw={input:number;cacheWrite:number;cacheWrite1h:number;cacheRead:number;output:number};
type Measured={model:string;weighted:number;raw:Raw;calls:number;helperWeighted:number;helperRaw:Raw;helperCalls:number};
type Component={provider:string;account:string;window:string;usedPercent:number|null;currentPeriodPercent?:number|null;
  basis:string;coverage?:{complete?:boolean}};
type Projection={usedPercent:number|null;basis:string;components:Component[]};

/** Conversations listed one by one; the rest are summed per account and project. */
export const PAGE_SESSIONS=200;

const blank=():Raw=>({input:0,cacheWrite:0,cacheWrite1h:0,cacheRead:0,output:0});
const addRaw=(into:Raw,from:Raw|undefined)=>{for(const key of Object.keys(into) as (keyof Raw)[])into[key]+=from?.[key]??0;};
const measuredFields=(row:any):Measured=>({model:row.model,weighted:row.weighted??0,raw:row.raw??blank(),calls:row.calls??0,
  helperWeighted:row.helperWeighted??0,helperRaw:row.helperRaw??blank(),helperCalls:row.helperCalls??0});

/** Only what the allowance mark reads: each estimated meter's share and whether its coverage was complete. */
function compactProjection(value:any):Projection|null{
  if(!value)return null;
  return {usedPercent:value.usedPercent??null,basis:value.basis,components:(value.components??[])
    .filter((part:any)=>part.basis==='estimated')
    .map((part:any)=>({provider:part.provider,account:part.account,window:part.window,usedPercent:part.usedPercent??null,
      currentPeriodPercent:part.currentPeriodPercent??null,basis:part.basis,coverage:{complete:part.coverage?.complete}}))};
}

function session(row:any){
  return {sessionId:row.sessionId??null,address:row.address??null,providerConversationId:row.providerConversationId,title:row.title??null,
    project:row.project??null,kind:row.kind,weighted:row.weighted??0,helperWeighted:row.helperWeighted??0,share:row.share,raw:row.raw??blank(),
    byModel:row.byModel?.map(measuredFields),byHelper:row.byHelper?.map((helper:any)=>({...measuredFields(helper),id:helper.id})),
    weeklyAllowance:compactProjection(row.weeklyAllowance)};
}

/** Estimates on the same account meter add; the sum is complete only when every part was. */
function sumProjections(values:(Projection|null)[]):Projection|null{
  const parts=new Map<string,Component>();
  for(const value of values)for(const part of value?.components??[]){
    const key=JSON.stringify([part.provider,part.account,part.window]),prior=parts.get(key);
    parts.set(key,prior?{...prior,usedPercent:(prior.usedPercent??0)+(part.usedPercent??0),
      currentPeriodPercent:prior.currentPeriodPercent===null&&part.currentPeriodPercent===null?null
        :(prior.currentPeriodPercent??0)+(part.currentPeriodPercent??0),
      coverage:{complete:prior.coverage?.complete!==false&&part.coverage?.complete!==false}}:{...part});
  }
  const components=[...parts.values()];
  if(!components.length)return null;
  return {usedPercent:components.length===1?components[0]!.usedPercent:null,basis:'estimated',components};
}

function remainder(project:string|null,rows:any[]){
  const raw=blank(),models=new Map<string,Measured>();
  let weighted=0,helperWeighted=0;
  for(const row of rows){
    weighted+=row.weighted??0;helperWeighted+=row.helperWeighted??0;addRaw(raw,row.raw);
    for(const model of row.byModel??[]){
      const item=models.get(model.model)??{...measuredFields({model:model.model}),raw:blank(),helperRaw:blank()};
      item.weighted+=model.weighted??0;item.calls+=model.calls??0;item.helperWeighted+=model.helperWeighted??0;item.helperCalls+=model.helperCalls??0;
      addRaw(item.raw,model.raw);addRaw(item.helperRaw,model.helperRaw);models.set(model.model,item);
    }
  }
  return {sessionId:null,address:null,providerConversationId:`smaller:${project??''}`,
    title:`${rows.length} smaller ${rows.length===1?'session':'sessions'}`,project,kind:'smaller sessions',weighted,helperWeighted,raw,
    byModel:[...models.values()].sort((a,b)=>b.weighted-a.weighted),byHelper:[],
    weeklyAllowance:sumProjections(rows.map(row=>compactProjection(row.weeklyAllowance)))};
}

export function usageBreakdownPage(report:Record<string,any>,shown=PAGE_SESSIONS){
  const all=(report.accounts??[]).flatMap((account:any,index:number)=>(account.bySession??[]).map((row:any)=>({index,row})));
  const kept=new Set(all.sort((a:any,b:any)=>(b.row.weighted??0)-(a.row.weighted??0)).slice(0,shown).map((item:any)=>item.row));
  const last48=report.cacheDiagnostics?.last48Hours;
  return {period:report.period,since:report.since,through:report.through,timeZone:report.timeZone,computedAt:report.computedAt,stale:report.stale,
    sessionCount:all.length,
    ...(last48?{cacheDiagnostics:{last48Hours:{callCount:last48.callCount,expected:last48.expected,unexpected:last48.unexpected,
      unknown:last48.unknown,byCause:last48.byCause}}}:{}),
    accounts:(report.accounts??[]).map((account:any)=>{
      const rows=account.bySession??[],rest=new Map<string,any[]>();
      for(const row of rows)if(!kept.has(row)){const key=JSON.stringify(row.project??null);rest.set(key,[...rest.get(key)??[],row]);}
      return {provider:account.provider,account:account.account,totalWeighted:account.totalWeighted,raw:account.raw,
        weeklyAllowance:account.weeklyAllowance,
        bySession:[...rows.filter((row:any)=>kept.has(row)).map(session),
          ...[...rest].map(([project,group])=>remainder(JSON.parse(project),group))]};
    })};
}
