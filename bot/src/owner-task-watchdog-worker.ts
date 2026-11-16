/** Watches the owner's heartbeat from outside its event loop; see owner-task-labels.ts. */
import {parentPort,workerData} from 'node:worker_threads';
import {readFileSync} from 'node:fs';
import {log} from './log';
import {macMemoryEvidence,startMacMemorySampler} from './mac-memory-evidence';
// Sampled from this thread, which the owner's freezes do not stop.
startMacMemorySampler(15_000);

// Same layout as owner-task-labels.ts: labels [running, last ended, published block label, block
// sequence]; times [heartbeat, running set, last ended, published block start, cumulative ledger
// occupied ms], ms since `origin`.
const shared=new Int32Array(workerData.shared as SharedArrayBuffer);
const times=new Float64Array(workerData.times as SharedArrayBuffer);
const statement=new Int32Array(workerData.statement as SharedArrayBuffer);
const origin=workerData.origin as number;
const labels:string[]=[...(workerData.labels as string[])];
parentPort?.on('message',(message:{id:number;label:string})=>{labels[message.id]=message.label;});

// The lag line's own threshold, so every lag line can carry the label; memory is logged from 500 ms.
const PUBLISH_MS=200,LOG_MS=500,STILL_MS=5_000,JUMP_MB=300,CHECK_MS=50;
const nowMs=()=>performance.timeOrigin+performance.now()-origin;
const rssMb=()=>Math.round(process.memoryUsage().rss/2**20); // the whole process, read from this thread

// The owner is the thread-group leader. Read only its own kernel task files from this watchdog
// thread; never sample on the owner's event loop or log syscall arguments and addresses.
type ThreadSample={at:number;cpuNs:number|null;runqueueNs:number|null;state:string;wchan:string;syscall:string};
const ownerTask=`/proc/${process.pid}/task/${process.pid}`;
function taskFile(name:string):string|null {
  try {return readFileSync(`${ownerTask}/${name}`,'utf8');} catch {return null;}
}
type ThreadReads={calls:number;chars:number;diskBytes:number};
type StatementSample={at:number;version:number;fingerprint:string;reads:ThreadReads;state:string;syscall:string};
function currentStatement():{version:number;fingerprint:string}|null {
  const version=Atomics.load(statement,0);
  if(version&1||!Atomics.load(statement,3))return null;
  const high=Atomics.load(statement,1),low=Atomics.load(statement,2);
  if(version!==Atomics.load(statement,0))return null;
  return {version,fingerprint:(high>>>0).toString(16).padStart(8,'0')+(low>>>0).toString(16).padStart(8,'0')};
}
function threadReads():ThreadReads|null {
  const counters=taskFile('io');
  if(!counters)return null;
  const value=(name:string)=>Number(counters.match(new RegExp(`^${name}:\\s*(\\d+)$`,'m'))?.[1]);
  const calls=value('syscr'),chars=value('rchar'),diskBytes=value('read_bytes');
  return [calls,chars,diskBytes].every(Number.isSafeInteger)?{calls,chars,diskBytes}:null;
}
function readEvidence(first:ThreadReads|null,last:ThreadReads|null,firstSampleMs:number) {
  if(!first||!last||last.calls<first.calls||last.chars<first.chars||last.diskBytes<first.diskBytes)
    return {thread_reads_available:false};
  return {thread_reads_available:true,thread_read_calls:last.calls-first.calls,
    thread_read_chars:last.chars-first.chars,thread_disk_read_bytes:last.diskBytes-first.diskBytes,
    thread_reads_first_sample_ms:firstSampleMs};
}
function threadSample(at:number):ThreadSample {
  const counters=taskFile('schedstat')?.trim().split(/\s+/);
  const status=taskFile('status');
  const channel=taskFile('wchan')?.trim()??'';
  const call=taskFile('syscall')?.trim().split(/\s+/,1)[0]??'';
  const counter=(index:number)=>counters?.[index]&&/^\d+$/.test(counters[index]!)?Number(counters[index]):null;
  return {at,cpuNs:counter(0),runqueueNs:counter(1),state:status?.match(/^State:\s+([A-Z])/m)?.[1]??'?',
    wchan:/^[A-Za-z0-9_.]{1,80}$/.test(channel)?channel:'unavailable',
    syscall:/^(running|-1|\d{1,4})$/.test(call)?call:'unavailable'};
}
function threadEvidence(samples:ThreadSample[]) {
  const first=samples[0],last=samples.at(-1);
  const delta=(field:'cpuNs'|'runqueueNs')=>first?.[field]!=null&&last?.[field]!=null&&last[field]!>=first[field]!
    ?Math.round((last[field]!-first[field]!)/1e6):null;
  const counts=(field:'state'|'wchan'|'syscall')=>Object.fromEntries(
    [...new Set(samples.map(sample=>sample[field]))].map(value=>[value,samples.filter(sample=>sample[field]===value).length]));
  return {thread_sample_count:samples.length,thread_sample_span_ms:first&&last?Math.round(last.at-first.at):0,
    thread_cpu_ms:delta('cpuNs'),thread_runqueue_wait_ms:delta('runqueueNs'),
    thread_states:counts('state'),thread_wait_channels:counts('wchan'),thread_syscalls:counts('syscall')};
}

/** Only a contiguous, unchanged statement identity is attributed. These periodic samples
 * are an interval inside the statement, not its exact begin/end or a syscall trace. */
function statementEvidence(samples:StatementSample[],truncated:boolean) {
  let longest:StatementSample[]=[];
  for(let i=0;i<samples.length;){
    let end=i+1;
    while(end<samples.length&&samples[end]!.version===samples[i]!.version)end++;
    if(end-i>longest.length)longest=samples.slice(i,end);
    i=end;
  }
  const first=longest[0],last=longest.at(-1);
  if(!first||!last||longest.length<2||last.reads.calls<first.reads.calls||last.reads.chars<first.reads.chars||last.reads.diskBytes<first.reads.diskBytes)
    return {statement_reads_available:false,statement_sample_count:longest.length,statement_history_truncated:truncated};
  return {statement_reads_available:true,statement_fingerprint:first.fingerprint,
    statement_sample_span_ms:Math.round(last.at-first.at),statement_sample_count:longest.length,
    statement_history_truncated:truncated,
    statement_read_calls:last.reads.calls-first.reads.calls,
    statement_read_chars:last.reads.chars-first.reads.chars,
    statement_disk_read_bytes:last.reads.diskBytes-first.reads.diskBytes,
    // Cumulative read calls show whether the long D-state interval contains one slow read
    // or repeated reads. No SQL, values, file paths or syscall arguments are retained.
    statement_read_timeline:longest.map(sample=>[Math.round(sample.at-first.at),sample.reads.calls-first.reads.calls,
      sample.reads.diskBytes-first.reads.diskBytes,sample.state,sample.syscall])};
}

// Shares: the running label is sampled every check while a block lasts, so a stretch in which
// several pieces of work ran back to back names each one (2026-11-05: a 10.9 s block named only
// the timer that started it, while an unlabelled runner-route transaction took 6.6 s of it).
type Block={running:number;lastEnded:number;endedBeforeMs:number;markedBeforeMs:number;startMb:number;peakMb:number;heldMs:number;stillLogged:boolean;
  ledgerAtStart:number;shareMs:Map<string,number>;sampledHeldMs:number;threadSamples:ThreadSample[];nextThreadSampleAt:number;
  readsAtFirstSample:ThreadReads|null;firstSampleAtMs:number;statementSamples:StatementSample[];statementHistoryTruncated:boolean};
let block:Block|null=null,sequence=0;
let previousMb=rssMb(),previousAt=nowMs(),lastJumpAt=-Infinity;

function shares(current:Block) {
  return Object.fromEntries([...current.shareMs].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([label,ms])=>[label,Math.round(ms)]));
}

function describe(current:Block) {
  // A running label was set by the work that is executing; with none, the block is in awaited or
  // event-driven work that passed no marking point, and the label that ended last is context only.
  return current.running
    ?{label:labels[current.running]??'unknown',label_running:true,label_marked_ms_before_block:Math.max(0,Math.round(current.markedBeforeMs))}
    :{label:'unmarked',label_running:false,last_ended_label:labels[current.lastEnded]??'none',last_ended_ms_before_block:Math.max(0,Math.round(current.endedBeforeMs))};
}

setInterval(()=>{
  const now=nowMs(),heldMs=Math.round(now-times[0]!);
  if(heldMs>=PUBLISH_MS){
    const mb=rssMb();
    if(!block){
      const blockStart=times[0]!,running=Atomics.load(shared,0),lastEnded=Atomics.load(shared,1);
      block={running,lastEnded,endedBeforeMs:blockStart-times[2]!,markedBeforeMs:blockStart-times[1]!,startMb:mb,peakMb:mb,heldMs,stillLogged:false,
        ledgerAtStart:times[4]!,shareMs:new Map(),sampledHeldMs:0,threadSamples:[],nextThreadSampleAt:now,
        readsAtFirstSample:threadReads(),firstSampleAtMs:heldMs,statementSamples:[],statementHistoryTruncated:false};
      times[3]=blockStart;Atomics.store(shared,2,running?running:-lastEnded);Atomics.store(shared,3,++sequence);
    }
    block.peakMb=Math.max(block.peakMb,mb);block.heldMs=heldMs;
    // Each check credits the time since the previous one to the label running now; the first
    // credits the whole time before the block was noticed.
    const sampled=Atomics.load(shared,0),sampledLabel=sampled?labels[sampled]??'unknown':'unmarked';
    block.shareMs.set(sampledLabel,(block.shareMs.get(sampledLabel)??0)+heldMs-block.sampledHeldMs);block.sampledHeldMs=heldMs;
    if(now>=block.nextThreadSampleAt){
      const sample=threadSample(now);
      block.threadSamples.push(sample);
      if(block.threadSamples.length>40)block.threadSamples.shift();
      const active=currentStatement(),reads=active?threadReads():null;
      if(active&&reads&&currentStatement()?.version===active.version){
        block.statementSamples.push({at:now,version:active.version,fingerprint:active.fingerprint,reads,state:sample.state,syscall:sample.syscall});
        if(block.statementSamples.length>40){block.statementSamples.shift();block.statementHistoryTruncated=true;}
      }
      block.nextThreadSampleAt=now+500;
    }
    // Logged while still blocked too, in case the process dies before the loop answers again.
    if(heldMs>=STILL_MS&&!block.stillLogged){block.stillLogged=true;log('warn','owner_task_still_blocked',{...describe(block),blocked_ms:heldMs,rss_start_mb:block.startMb,rss_now_mb:mb,...macMemoryEvidence(),
      ...threadEvidence(block.threadSamples),...readEvidence(block.readsAtFirstSample,threadReads(),block.firstSampleAtMs),
      ...statementEvidence(block.statementSamples,block.statementHistoryTruncated)});}
  } else if(block) {
    // Ledger time is added when each statement ends, so after the block it covers the whole block.
    if(block.heldMs>=LOG_MS)log('warn','owner_task_blocked',{...describe(block),blocked_ms:block.heldMs,label_shares_ms:shares(block),
      ledger_wait_ms:Math.round(times[4]!-block.ledgerAtStart),rss_start_mb:block.startMb,rss_peak_mb:block.peakMb,rss_end_mb:rssMb(),...macMemoryEvidence(),
      ...threadEvidence([...block.threadSamples,threadSample(now)]),...readEvidence(block.readsAtFirstSample,threadReads(),block.firstSampleAtMs),
      ...statementEvidence(block.statementSamples,block.statementHistoryTruncated)});
    block=null;
  }
  if(now-previousAt>=1000){
    const mb=rssMb();
    if(mb-previousMb>=JUMP_MB&&now-lastJumpAt>=10_000){
      lastJumpAt=now;
      const running=Atomics.load(shared,0);
      log('warn','owner_memory_jump',{label:running?labels[running]??'unknown':'unmarked',last_ended_label:labels[Atomics.load(shared,1)]??'none',from_mb:previousMb,to_mb:mb,loop_held_ms:heldMs});
    }
    previousMb=mb;previousAt=now;
  }
},CHECK_MS);
