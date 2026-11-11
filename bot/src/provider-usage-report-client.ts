import {inflateSync} from 'node:zlib';
import {runnerMachineCall} from './runner-machine-calls';

const rawKeys=['input','cacheWrite','cacheWrite1h','cacheRead','output'] as const;
const sum=(values:any[])=>values.reduce((total,value)=>total+(Number(value)||0),0);
const raw=(values:any[])=>Object.fromEntries(rawKeys.map(key=>[key,sum(values.map(value=>value?.[key]))]));
const cache=(values:any[])=>({callCount:sum(values.map(value=>value?.callCount)),
  flaggedCallCount:sum(values.map(value=>value?.flaggedCallCount)),unknownCauseCount:sum(values.map(value=>value?.unknownCauseCount))});
function mix(values:any[]){
  const totalCalls=sum(values.map(value=>value?.totalCalls)),helperCalls=sum(values.map(value=>value?.helperCalls));
  const models=new Map<string,{calls:number;helperCalls:number}>();
  for(const value of values)for(const row of value?.byModel??[]){
    const prior=models.get(row.model)??{calls:0,helperCalls:0};prior.calls+=row.calls;prior.helperCalls+=row.helperCalls;models.set(row.model,prior);
  }
  return {totalCalls,helperCalls,mainCalls:totalCalls-helperCalls,helperShare:totalCalls?helperCalls/totalCalls:0,
    byModel:[...models].map(([model,value])=>({model,...value,mainCalls:value.calls-value.helperCalls,share:totalCalls?value.calls/totalCalls:0}))
      .sort((a,b)=>b.calls-a.calls)};
}
function countMap(values:any[]){
  const out:Record<string,number>={};for(const value of values)for(const [key,count] of Object.entries(value??{}))out[key]=(out[key]??0)+(Number(count)||0);
  return out;
}
function summary(values:any[]){
  const byCause:Record<string,{calls:number;rewrittenInputTokens:number}>={};
  for(const value of values)for(const [cause,row] of Object.entries(value?.byCause??{})){
    const prior=byCause[cause]??{calls:0,rewrittenInputTokens:0};
    prior.calls+=(row as any).calls;prior.rewrittenInputTokens+=(row as any).rewrittenInputTokens;byCause[cause]=prior;
  }
  return {callCount:sum(values.map(value=>value?.callCount)),expected:sum(values.map(value=>value?.expected)),
    unexpected:sum(values.map(value=>value?.unexpected)),unknown:sum(values.map(value=>value?.unknown)),byCause,
    unknownPatterns:Object.fromEntries(['byProvider','byGap','instructionFingerprints','accountAttribution'].map(key=>
      [key,countMap(values.map(value=>value?.unknownPatterns?.[key]))]))};
}
function mergePeriod(parts:any[]){
  if(parts.length===1)return parts[0];
  const first=parts[0],diagnostics=parts.map(part=>part.cacheDiagnostics);
  const rates:Record<string,{calls:number;misses:number}>={};
  for(const item of diagnostics)for(const [provider,rate] of Object.entries(item.providerRates??{})){
    const current=rates[provider]??{calls:0,misses:0};current.calls+=(rate as any).calls;current.misses+=(rate as any).misses;rates[provider]=current;
  }
  const ordinaryCalls=sum(diagnostics.map(value=>value.ordinaryCallCount));
  const ordinaryMissRate=sum(Object.values(rates).map(value=>value.misses))/Math.max(1,ordinaryCalls);
  const bug=(misses:number,count:number,provider:string)=>{
    const rate=rates[provider],baseline=rate?rate.misses/Math.max(1,rate.calls):ordinaryMissRate;
    return misses>0&&count>0&&misses/count>Math.max(.05,2*baseline);
  };
  const groups=new Map<string,any[]>();
  for(const part of parts)for(const account of part.accounts){const key=`${account.provider}\0${account.account}`;
    const list=groups.get(key)??[];list.push(account);groups.set(key,list);}
  const accounts=[...groups.values()].map(list=>{
    const one=list[0],combinedCache=cache(list.map(value=>value.cache));
    const sessions=list.flatMap(value=>value.bySession);
    const kinds=new Map<string,any[]>();for(const item of list)for(const kind of item.byKind){const rows=kinds.get(kind.kind)??[];rows.push(kind);kinds.set(kind.kind,rows);}
    const totalWeighted=sum(list.map(value=>value.totalWeighted));
    return {...one,totalWeighted,raw:raw(list.map(value=>value.raw)),cache:{...combinedCache,
      bug:bug(combinedCache.flaggedCallCount,combinedCache.callCount,one.provider)},
      callMix:mix(list.map(value=>value.callMix)),cachedInputTokens:sum(list.map(value=>value.cachedInputTokens)),
      rewrittenInputTokens:sum(list.map(value=>value.rewrittenInputTokens)),
      bySession:sessions.map(value=>({...value,share:totalWeighted?value.weighted/totalWeighted:0,
        cache:{...value.cache,bug:bug(value.cache.flaggedCallCount,value.cache.callCount,one.provider)}}))
        .sort((a,b)=>b.weighted-a.weighted),
      byKind:[...kinds].map(([kind,rows])=>({kind,weighted:sum(rows.map(value=>value.weighted)),raw:raw(rows.map(value=>value.raw)),
        share:totalWeighted?sum(rows.map(value=>value.weighted))/totalWeighted:0})).sort((a,b)=>b.weighted-a.weighted)};
  });
  const firings=new Map<number,any[]>();for(const part of parts)for(const firing of part.scheduledFirings){
    const rows=firings.get(firing.turnId)??[];rows.push(firing);firings.set(firing.turnId,rows);}
  const scheduledFirings=[...firings.values()].map(rows=>{const observed=rows.filter(row=>row.usageObserved);
    return {...rows[0],usageObserved:observed.length>0,apiPriceEquivalentUsd:observed.length?sum(observed.map(row=>row.apiPriceEquivalentUsd)):null,
      rawTokens:observed.length?raw(observed.map(row=>row.rawTokens)):null};});
  const calls=diagnostics.flatMap(value=>value.calls).sort((a,b)=>b.rewrittenInputTokens-a.rewrittenInputTokens).slice(0,100);
  const turns=diagnostics.flatMap(value=>value.turns).sort((a,b)=>b.rewrittenInputTokens-a.rewrittenInputTokens).slice(0,100)
    .map(value=>({...value,bug:bug(value.flaggedCallCount,value.callCount,value.provider)}));
  return {...first,through:new Date().toISOString(),callMix:mix(parts.map(part=>part.callMix)),
    fallbackModels:[...new Set(parts.flatMap(part=>part.fallbackModels))].sort(),accounts,scheduledFirings,
    attributionBuckets:parts.flatMap(part=>part.attributionBuckets??[]),
    cacheDiagnostics:{...first.cacheDiagnostics,ordinaryMissRate,ordinaryCallCount:ordinaryCalls,providerRates:rates,
      callCount:sum(diagnostics.map(value=>value.callCount)),turnCount:sum(diagnostics.map(value=>value.turnCount)),
      last48Hours:summary(diagnostics.map(value=>value.last48Hours)),last15Minutes:summary(diagnostics.map(value=>value.last15Minutes)),calls,turns}};
}

export async function collectRunnerUsageReports(runners:Map<string,Set<'claude-code'|'codex'>>,snapshot:string,
  call=runnerMachineCall):Promise<{today:any;week:any}>{
  const reports=[];
  for(const [runner,providers] of runners){
    const response=await call(runner,'provider-usage-breakdown.report',{providers:[...providers],snapshot},120_000);
    if(typeof response?.report!=='string'||response.report.length>1024*1024)throw new Error('INVALID_PROVIDER_USAGE_BREAKDOWN_REPORT');
    const value=JSON.parse(inflateSync(Buffer.from(response.report,'base64url'),{maxOutputLength:8*1024*1024}).toString('utf8'));
    if(!value?.today?.accounts||!value?.week?.accounts)throw new Error('INVALID_PROVIDER_USAGE_BREAKDOWN_REPORT');
    reports.push(value);
  }
  const week=mergePeriod(reports.map(value=>value.week)),today=mergePeriod(reports.map(value=>value.today));
  today.cacheDiagnostics.last48Hours=week.cacheDiagnostics.last48Hours;
  return {today,week};
}
