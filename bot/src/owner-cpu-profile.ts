import {heapStats,profile} from 'bun:jsc';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {log} from './log';
import {storageObservationFailures} from './storage-observation';

/**
 * Summaries of the owner's CPU profiles, written to `$CONCIERGE_STATE_DIR/diagnostics/`. The owner
 * answers every read from one event loop, and `owner_event_loop_lag` only says that something held
 * it; on 2026-10-07 the cause of thirty-second Inbox reads had to be guessed from which database
 * pages were being read. The recorder that takes the profiles is below.
 */

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
  return [`Owner CPU profile: ${total} samples of JavaScript over ${seconds} s (10 ms interval; idle time has no samples).`,
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
 * A flight recorder for the owner's own JavaScript, started on demand: `kill -URG <pid>` records
 * up to ten minutes as back-to-back 15 s windows sampled every 10 ms, and keeps only a window in
 * which the loop was held for at least half a second or the process grew by 300 MB, at most two.
 * On 2026-11-04 the owner jumped to 1.9 GB within seconds after a 2 s block of pure JavaScript;
 * a profile started when memory crosses a line begins after the block, so the recorder runs
 * ahead of it and keeps what it caught. The first version (one 20 s window at 1 ms) was turned
 * off after it preceded 20-40 s freezes and 40 GB runaways on 2026-10-07, when the owner was
 * already exhausted. Validated on a stand-in with the production Bun on 2026-11-04: no added loop
 * blocking at 10 ms sampling with a 1 GB heap, 50-220 MB extra memory while sampling. It refuses
 * to start above 3 GB and runs one session at a time; SIGURG is otherwise ignored.
 */
const WINDOW_MS=15_000,SESSION_MS=10*60_000,SAMPLE_US=10_000,KEEP_BLOCK_MS=500,KEEP_GROWTH_MB=300,KEEP_MAX=2,REFUSE_ABOVE_MB=3072;
let recording=false;
async function recordOwnerProfile() {
  const mb=()=>Math.round(process.memoryUsage().rss/2**20);
  if(recording){log('warn','owner_cpu_profile_refused',{reason:'already recording'});return;}
  if(mb()>REFUSE_ABOVE_MB){log('warn','owner_cpu_profile_refused',{reason:'memory above 3 GB',rss_mb:mb()});return;}
  recording=true;
  const sessionStarted=Date.now(),directory=join(process.env.CONCIERGE_STATE_DIR??'/tmp','diagnostics');
  let kept=0,windows=0;
  log('info','owner_cpu_profile_started',{rss_mb:mb()});
  try {
    while(Date.now()-sessionStarted<SESSION_MS&&kept<KEEP_MAX&&mb()<=REFUSE_ABOVE_MB) {
      let worstBlockMs=0,last=performance.now(),peakMb=mb();
      const startMb=peakMb,windowStarted=new Date();
      const watch=setInterval(()=>{const now=performance.now();worstBlockMs=Math.max(worstBlockMs,now-last-100);last=now;peakMb=Math.max(peakMb,mb());},100);
      const result:any=await Promise.resolve(profile(async()=>{await Bun.sleep(WINDOW_MS);},SAMPLE_US) as any).finally(()=>clearInterval(watch));
      windows++;
      const growthMb=peakMb-startMb;
      if(worstBlockMs<KEEP_BLOCK_MS&&growthMb<KEEP_GROWTH_MB)continue;
      kept++;
      mkdirSync(directory,{recursive:true});
      const path=join(directory,`cpu-profile-${windowStarted.toISOString().replace(/[:.]/g,'-')}.txt`);
      writeFileSync(path,`Window ${windowStarted.toISOString()}: worst loop block ${Math.round(worstBlockMs)} ms, memory ${startMb} -> peak ${peakMb} MB.\n`
        +summarizeProfile(result?.stackTraces?.traces??[],WINDOW_MS/1000)+'\n'+String(result?.functions??''));
      log('info','owner_cpu_profile_written',{path,samples:result?.stackTraces?.traces?.length??0,worst_block_ms:Math.round(worstBlockMs),growth_mb:growthMb});
    }
  } catch(error){log('warn','owner_cpu_profile_failed',{error:String(error)});}
  finally {recording=false;log('info','owner_cpu_profile_finished',{windows,kept,rss_mb:mb()});}
}

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
  process.on('SIGURG',()=>{void recordOwnerProfile();});
}
