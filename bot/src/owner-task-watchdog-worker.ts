/** Watches the owner's heartbeat from outside its event loop; see owner-task-labels.ts. */
import {parentPort,workerData} from 'node:worker_threads';
import {log} from './log';

// Same layout as owner-task-labels.ts: labels [running, last ended, published block label, block
// sequence]; times [heartbeat, running set, last ended, published block start], ms since `origin`.
const shared=new Int32Array(workerData.shared as SharedArrayBuffer);
const times=new Float64Array(workerData.times as SharedArrayBuffer);
const origin=workerData.origin as number;
const labels:string[]=[...(workerData.labels as string[])];
parentPort?.on('message',(message:{id:number;label:string})=>{labels[message.id]=message.label;});

// The lag line's own threshold, so every lag line can carry the label; memory is logged from 500 ms.
const PUBLISH_MS=200,LOG_MS=500,STILL_MS=5_000,JUMP_MB=300,CHECK_MS=50;
const nowMs=()=>performance.timeOrigin+performance.now()-origin;
const rssMb=()=>Math.round(process.memoryUsage().rss/2**20); // the whole process, read from this thread

type Block={running:number;lastEnded:number;endedBeforeMs:number;markedBeforeMs:number;startMb:number;peakMb:number;heldMs:number;stillLogged:boolean};
let block:Block|null=null,sequence=0;
let previousMb=rssMb(),previousAt=nowMs(),lastJumpAt=-Infinity;

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
      block={running,lastEnded,endedBeforeMs:blockStart-times[2]!,markedBeforeMs:blockStart-times[1]!,startMb:mb,peakMb:mb,heldMs,stillLogged:false};
      times[3]=blockStart;Atomics.store(shared,2,running?running:-lastEnded);Atomics.store(shared,3,++sequence);
    }
    block.peakMb=Math.max(block.peakMb,mb);block.heldMs=heldMs;
    // Logged while still blocked too, in case the process dies before the loop answers again.
    if(heldMs>=STILL_MS&&!block.stillLogged){block.stillLogged=true;log('warn','owner_task_still_blocked',{...describe(block),blocked_ms:heldMs,rss_start_mb:block.startMb,rss_now_mb:mb});}
  } else if(block) {
    if(block.heldMs>=LOG_MS)log('warn','owner_task_blocked',{...describe(block),blocked_ms:block.heldMs,rss_start_mb:block.startMb,rss_peak_mb:block.peakMb,rss_end_mb:rssMb()});
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
