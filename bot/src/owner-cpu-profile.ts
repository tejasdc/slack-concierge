import {heapStats,profile} from 'bun:jsc';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {log} from './log';
import {storageObservationFailures} from './storage-observation';

/**
 * A CPU profile of the running owner, on demand: `kill -URG <pid>` samples the JavaScript
 * thread for twenty seconds and writes what it was doing to
 * `$CONCIERGE_STATE_DIR/diagnostics/cpu-profile-<time>.txt`. The owner answers every read from
 * one event loop, and `owner_event_loop_lag` only says that something held it; nothing could
 * attach a profiler to the live process, so on 2026-10-07 the cause of thirty-second Inbox reads
 * had to be guessed from which database pages were being read. SIGURG is ignored by default, so
 * a stray one does nothing else.
 */
const PROFILE_SECONDS=20;
let running=false;

type Frame={name:string;sourceURL?:string;line:number};
const frameLabel=(frame:Frame)=>`${frame.name||'(anonymous)'} ${(frame.sourceURL??'').split('/').slice(-2).join('/')}:${frame.line>1e9?'?':frame.line}`;

export function summarizeProfile(traces:{frames:Frame[]}[],seconds:number):string {
  const self=new Map<string,number>(),inclusive=new Map<string,number>(),stacks=new Map<string,number>();
  const bump=(map:Map<string,number>,key:string)=>map.set(key,(map.get(key)??0)+1);
  for(const trace of traces) {
    const frames=trace.frames.filter(frame=>frame.name!=='profile');
    if(!frames.length)continue;
    bump(self,frameLabel(frames[0]!));
    for(const label of new Set(frames.map(frameLabel)))bump(inclusive,label);
    bump(stacks,frames.slice(0,10).map(frameLabel).join('\n    <- '));
  }
  const total=traces.length;
  const top=(map:Map<string,number>,count:number)=>[...map].sort((a,b)=>b[1]-a[1]).slice(0,count)
    .map(([key,n])=>`${String(n).padStart(6)} ${(100*n/Math.max(1,total)).toFixed(1).padStart(5)}%  ${key}`).join('\n');
  return [`Owner CPU profile: ${total} samples of JavaScript over ${seconds} s (1 ms interval; idle time has no samples).`,
    '','Self (where the thread was):',top(self,40),'','Inclusive (anywhere on the stack):',top(inclusive,60),
    '','Hottest stacks (innermost first):',top(stacks,25)].join('\n')+'\n';
}

/**
 * The owner's memory, once a minute. On 2026-10-07 it reached 20–43 GB within an hour six times
 * (systemd's memory peaks), pushed the machine into swap, froze every read and made the 8:03 PM
 * update's first start fail while the dying process still held the ledger; nothing said what the
 * memory was. Routine readings must remain cheap even under pressure: no heap walk or automatic
 * profiler belongs on the already exhausted owner's loop. The external sampler keeps observing
 * when this loop cannot answer. Allocation attribution requires a separately validated diagnostic.
 */
const MEMORY_EVERY_MS=60_000;
export function startOwnerMemoryReadings() {
  const timer=setInterval(()=>{
    try {
      const usage=process.memoryUsage();
      log('info','owner_memory',{rss_mb:Math.round(usage.rss/2**20),heap_used_mb:Math.round(usage.heapUsed/2**20),
        heap_total_mb:Math.round(usage.heapTotal/2**20),external_mb:Math.round(usage.external/2**20),array_buffers_mb:Math.round(usage.arrayBuffers/2**20),
        storage_observation_failures:storageObservationFailures()});
    } catch(error){log('warn','owner_memory_failed',{error:String(error)});}
  },MEMORY_EVERY_MS);
  timer.unref?.();
}

/**
 * Off: on 2026-10-07 starting this profiler froze the owner for 20–40 s every time, and twice it
 * was followed within minutes by the owner growing to 40 GB. The signal is acknowledged and
 * refused until that is understood; CONCIERGE_OWNER_CPU_PROFILE=1 turns it back on deliberately.
 */
const PROFILE_ENABLED=process.env.CONCIERGE_OWNER_CPU_PROFILE==='1';

/**
 * What the owner holds, on demand: `kill -WINCH <pid>` writes the live JavaScript object counts by
 * type to `$CONCIERGE_STATE_DIR/diagnostics/heap-census-<time>.json`. The owner's memory climbs
 * from about 0.5 to 1.5-4.5 GB over minutes several times a day and falls back within a minute
 * (2026-11-03); nothing said what it held. Never automatic: an outside sampler sends the signal at a
 * chosen size. Validated on a stand-in with the production Bun: 0.3 s at 1.2 GB and 0.7 s at
 * 2.6 GB of one paused loop, no added memory, live objects only. At most once in five minutes.
 * SIGWINCH is ignored by default, so a stray one does nothing else.
 */
const CENSUS_EVERY_MS=5*60_000;
let censusAt=0;
function writeHeapCensus() {
  if(Date.now()-censusAt<CENSUS_EVERY_MS){log('warn','owner_heap_census_refused',{reason:'rate'});return;}
  censusAt=Date.now();
  try {
    const before=process.memoryUsage(),started=performance.now();
    const stats=heapStats();
    const ms=Math.round(performance.now()-started),after=process.memoryUsage();
    const mb=(n:number)=>Math.round(n/2**20);
    const top=(counts:Record<string,number>)=>Object.fromEntries(Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,60));
    const directory=join(process.env.CONCIERGE_STATE_DIR??'/tmp','diagnostics');
    mkdirSync(directory,{recursive:true});
    const path=join(directory,`heap-census-${new Date(censusAt).toISOString().replace(/[:.]/g,'-')}.json`);
    writeFileSync(path,JSON.stringify({at:new Date(censusAt).toISOString(),census_ms:ms,
      before:{rss_mb:mb(before.rss),heap_used_mb:mb(before.heapUsed),external_mb:mb(before.external),array_buffers_mb:mb(before.arrayBuffers)},
      after:{rss_mb:mb(after.rss),heap_used_mb:mb(after.heapUsed),external_mb:mb(after.external),array_buffers_mb:mb(after.arrayBuffers)},
      heap_size_mb:mb(stats.heapSize),heap_capacity_mb:mb(stats.heapCapacity),extra_mb:mb(stats.extraMemorySize),
      objects:stats.objectCount,protected_objects:stats.protectedObjectCount,
      types:top(stats.objectTypeCounts),protected_types:top(stats.protectedObjectTypeCounts),mimalloc:(stats as any).mimalloc},null,1));
    log('info','owner_heap_census_written',{path,census_ms:ms,objects:stats.objectCount,rss_mb:mb(before.rss),heap_used_after_mb:mb(after.heapUsed)});
  } catch(error){log('warn','owner_heap_census_failed',{error:String(error)});}
}

export function installOwnerCpuProfileSignal() {
  startOwnerMemoryReadings();
  process.on('SIGWINCH',writeHeapCensus);
  process.on('SIGURG',()=>{
    if(!PROFILE_ENABLED){log('warn','owner_cpu_profile_refused',{reason:'disabled after it preceded 40 GB runaways on 2026-10-07'});return;}
    if(running)return;
    running=true;
    const started=new Date();
    Promise.resolve(profile(async()=>{await Bun.sleep(PROFILE_SECONDS*1000);},1000) as any).then((result:any)=>{
      const directory=join(process.env.CONCIERGE_STATE_DIR??'/tmp','diagnostics');
      mkdirSync(directory,{recursive:true});
      const path=join(directory,`cpu-profile-${started.toISOString().replace(/[:.]/g,'-')}.txt`);
      writeFileSync(path,summarizeProfile(result?.stackTraces?.traces??[],PROFILE_SECONDS)+'\n'+String(result?.functions??''));
      log('info','owner_cpu_profile_written',{path,samples:result?.stackTraces?.traces?.length??0});
    }).catch((error:unknown)=>log('warn','owner_cpu_profile_failed',{error:String(error)}))
      .finally(()=>{running=false;});
  });
}
