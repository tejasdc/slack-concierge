/** Watches the owner's heartbeat from outside its event loop; see owner-task-labels.ts. */
import {parentPort,workerData} from 'node:worker_threads';
import {log} from './log';

const shared=new Int32Array(workerData.shared as SharedArrayBuffer);
const labels:string[]=[...(workerData.labels as string[])];
parentPort?.on('message',(message:{id:number;label:string})=>{labels[message.id]=message.label;});

const BLOCK_MS=500,JUMP_MB=300,CHECK_MS=50;
const nowMs=()=>Date.now()%2**31;
const age=(at:number)=>(nowMs()-at+2**31)%2**31;
const rssMb=()=>Math.round(process.memoryUsage().rss/2**20); // the whole process, read from this thread
const label=()=>labels[Atomics.load(shared,1)]??'unknown';

let block:{label:string;markedBeforeMs:number;startMb:number;peakMb:number;longestMs:number}|null=null;
let previousMb=rssMb(),previousAt=Date.now(),lastJumpAt=0;

setInterval(()=>{
  const heldMs=age(Atomics.load(shared,0));
  if(heldMs>=BLOCK_MS){
    const mb=rssMb();
    if(!block)block={label:label(),markedBeforeMs:age(Atomics.load(shared,2))-heldMs,startMb:mb,peakMb:mb,longestMs:heldMs};
    block.peakMb=Math.max(block.peakMb,mb);block.longestMs=Math.max(block.longestMs,heldMs);
  } else if(block) {
    // Logged once the loop runs again, from this thread: the label is the work that was running
    // when the loop stopped answering, and how long before the block it was last marked.
    log('warn','owner_task_blocked',{label:block.label,blocked_ms:block.longestMs,label_marked_ms_before_block:Math.max(0,block.markedBeforeMs),
      rss_start_mb:block.startMb,rss_peak_mb:block.peakMb,rss_end_mb:rssMb()});
    block=null;
  }
  if(Date.now()-previousAt>=1000){
    const mb=rssMb();
    if(mb-previousMb>=JUMP_MB&&Date.now()-lastJumpAt>=10_000){
      lastJumpAt=Date.now();
      log('warn','owner_memory_jump',{label:label(),from_mb:previousMb,to_mb:mb,loop_held_ms:heldMs});
    }
    previousMb=mb;previousAt=Date.now();
  }
},CHECK_MS);
