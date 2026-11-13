import {join} from 'node:path';
import {CACHE_BACKUP_POLICY} from './provider-history-cache-admission';
import {DURABILITY_OBSERVATION,type ProtectedDurabilitySnapshot} from './protected-durability-observation';

// Seven-minute exposure plus sample alignment, collection and launch/report headroom.
// This is an observation lifetime, never a maintenance/admission extension.
export const DURABILITY_OBSERVER_POLICY=Object.freeze({maxDurationMs:450000,collectionMaxMs:480000,commandMaxMs:510000});
export function durabilityObservationCommand(executable:string,script:string,durationMs:number) {
  return ['timeout',`--kill-after=${CACHE_BACKUP_POLICY.killGraceMs/1000}s`,`${DURABILITY_OBSERVER_POLICY.commandMaxMs/1000}s`,
    'nice','-n',String(CACHE_BACKUP_POLICY.nice),executable,script,'--observe-durability-owned',String(durationMs)];
}

const LANES=['owner_receipt','provider_input'] as const;
const TOP=['version','epoch','startedMs','sampledMs','sampledWallMs','installed','errors','unlabelled','detailLimit','outstandingLimit'] as const;
const COUNTS=['entered','completed','failed','unknown','alreadyCovered','confirmedSync','synchronous','totalDurationMs',
  'maxDurationMs','detailDropped','startsDropped','outstanding','trackedOutstanding','unknownOutstanding',
  'oldestOutstandingMs','oldestTrackedMs','accountingValid'] as const;
const DETAIL=['sequence','enteredMs','completedMs','durationMs','outcome'] as const;
const number=(value:unknown,nullable=false):number|null=>{
  if(nullable&&value===null)return null;
  if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error('Invalid observation');
  return value;
};
/** Reconstruct the allowlist; never forward unexpected private fields or exception strings. */
export function numericDurabilitySnapshot(input:unknown):ProtectedDurabilitySnapshot {
  const source=input as any,output:any={lanes:{}};
  for(const key of TOP)output[key]=number(source?.[key]);
  if(output.version!==DURABILITY_OBSERVATION.version||output.detailLimit>DURABILITY_OBSERVATION.detailLimit
    ||output.outstandingLimit>DURABILITY_OBSERVATION.outstandingLimit)throw new Error('Unsupported observation');
  for(const lane of LANES){
    const sourceLane=source.lanes?.[lane],target:any={};
    for(const key of COUNTS)target[key]=number(sourceLane?.[key],key==='oldestOutstandingMs'||key==='oldestTrackedMs');
    for(const key of COUNTS)if(!key.endsWith('Ms')&&!Number.isSafeInteger(target[key]))throw new Error('Invalid counter');
    if(!Array.isArray(sourceLane.details)||sourceLane.details.length>output.detailLimit)throw new Error('Invalid details');
    target.details=sourceLane.details.map((record:any)=>Object.fromEntries(DETAIL.map(key=>[key,number(record?.[key])])));
    if(target.entered!==target.completed+target.failed+target.unknown+target.outstanding
      ||target.outstanding!==target.trackedOutstanding+target.unknownOutstanding
      ||target.completed!==target.alreadyCovered+target.confirmedSync+target.synchronous
      ||target.accountingValid!==1)throw new Error('Invalid accounting');
    let previous=0;
    for(const record of target.details){
      if(!Number.isSafeInteger(record.sequence)||record.sequence<=previous||!Number.isInteger(record.outcome)||record.outcome>4
        ||record.enteredMs>record.completedMs||record.completedMs>output.sampledMs
        ||Math.abs(record.completedMs-record.enteredMs-record.durationMs)>0.01)throw new Error('Invalid duration');
      previous=record.sequence;
    }
    const terminal=target.completed+target.failed+target.unknown;
    if(target.details.length&&target.details.at(-1).sequence!==terminal)throw new Error('Missing latest detail');
    output.lanes[lane]=target;
  }
  return output;
}

export async function readProtectedDurability(state:string) {
  const response=await fetch('http://localhost/supervisor/durability',{
    unix:join(state,'request-owner.sock'),signal:AbortSignal.timeout(2000),redirect:'error',
  } as RequestInit);
  if(!response.ok){await response.body?.cancel();throw new Error('Unavailable observation');}
  const reader=response.body?.getReader();if(!reader)throw new Error('Missing observation');
  const chunks:Uint8Array[]=[];let bytes=0;
  try {
    for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;
      if(bytes>256*1024)throw new Error('Oversize observation');chunks.push(value);}
  } finally {await reader.cancel();}
  return numericDurabilitySnapshot(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

/** Missing reads invalidate evidence; they never call the foreground barrier or retry it. */
export async function observeProtectedDurability(durationMs:number,read:()=>Promise<unknown>,
  clock=()=>performance.now(),sleep=(ms:number)=>Bun.sleep(ms)) {
  if(!Number.isInteger(durationMs)||durationMs<1||durationMs>DURABILITY_OBSERVER_POLICY.maxDurationMs)
    throw new Error('Observation duration exceeds the bounded observation policy.');
  const startedMs=clock(),frames:any[]=[],previous:Partial<Record<typeof LANES[number],number>>={};
  const initial:Partial<Record<typeof LANES[number],any>>={};
  let first:any,coverageDeadline:number|undefined;
  let epoch:number|undefined,lastSampledMs=-1,lastErrors=0,valid=1,missing=0,dropped=0,details=0;
  do {
    const readStartedMs=clock(),readStartedWallMs=Date.now();let frame:any;
    try {
      const snapshot=numericDurabilitySnapshot(await read()),readEndedMs=clock();
      let reasons=0;
      // Bit flags: 1 not installed, 2 restart, 4 nonfresh, 8 instrumentation failure,
      // 16 unknown/overflowed starts, 32 missing completions, 64 observer detail overflow.
      if(snapshot.installed!==1)reasons|=1;
      if(epoch!==undefined&&snapshot.epoch!==epoch){reasons|=2;previous.owner_receipt=undefined;previous.provider_input=undefined;}
      if(epoch===snapshot.epoch&&snapshot.sampledMs<=lastSampledMs)reasons|=4;
      if(snapshot.errors>0||snapshot.errors<lastErrors)reasons|=8;
      if(readEndedMs-readStartedMs>2000)reasons|=4;
      if(snapshot.sampledWallMs<readStartedWallMs-2000||snapshot.sampledWallMs>Date.now()+2000)reasons|=4;
      const lanes:any={};
      for(const lane of LANES){
        const {details:retained,...counts}=snapshot.lanes[lane],terminal=counts.completed+counts.failed+counts.unknown;
        const prior=previous[lane];
        if(counts.unknownOutstanding||counts.unknown
          ||counts.startsDropped>(initial[lane]?.startsDropped??counts.startsDropped))reasons|=16;
        let fresh=prior===undefined?[]:retained.filter(record=>record.sequence>prior);
        if(prior!==undefined&&(terminal<prior||fresh.length!==terminal-prior))reasons|=32;
        if(details+fresh.length>4096){dropped+=fresh.length;fresh=[];reasons|=64;}
        details+=fresh.length;
        if(initial[lane]===undefined)initial[lane]={...counts};
        lanes[lane]={...counts,details:fresh};previous[lane]=terminal;
      }
      if(reasons)valid=0;
      frame={readStartedMs,readEndedMs,readStartedWallMs,readEndedWallMs:Date.now(),available:1,reasons,
        epoch:snapshot.epoch,ownerSampledMs:snapshot.sampledMs,ownerSampledWallMs:snapshot.sampledWallMs,
        ownerStartedMs:snapshot.startedMs,ownerErrors:snapshot.errors,unlabelled:snapshot.unlabelled,lanes};
      epoch=snapshot.epoch;lastSampledMs=snapshot.sampledMs;lastErrors=snapshot.errors;
    } catch {valid=0;missing++;frame={readStartedMs,readEndedMs:clock(),readStartedWallMs,readEndedWallMs:Date.now(),available:0,reasons:128};}
    if(frames.length>=512){valid=0;dropped++;break;}frames.push(frame);
    coverageDeadline??=clock()+durationMs;
    if(frame.available&&!first)first=frame;
    const covered=first&&frame.available&&first.epoch===frame.epoch
      &&frame.ownerSampledMs-first.ownerSampledMs>=durationMs;
    if(clock()>=coverageDeadline&&(covered||!valid))break;
    const remaining=startedMs+DURABILITY_OBSERVER_POLICY.collectionMaxMs-clock();if(remaining<=0)break;
    await sleep(Math.min(CACHE_BACKUP_POLICY.sampleMs,remaining));
  } while(true);
  const last=frames.filter(frame=>frame.available).at(-1),accounting:any={};
  for(const lane of LANES){
    const start=initial[lane],end=last?.lanes[lane];
    accounting[lane]=start&&end?{initialOutstanding:start.outstanding,entered:end.entered-start.entered,
      completed:end.completed-start.completed,failed:end.failed-start.failed,unknown:end.unknown-start.unknown,
      finalOutstanding:end.outstanding,trafficObserved:Number(start.outstanding+end.entered-start.entered>0),
      reconciled:Number(start.outstanding+end.entered-start.entered===end.completed-start.completed
        +end.failed-start.failed+end.unknown-start.unknown+end.outstanding)}:null;
    if(!accounting[lane]?.reconciled)valid=0;
  }
  const endedMs=clock(),deadlineExceeded=Number(endedMs-startedMs>=DURABILITY_OBSERVER_POLICY.collectionMaxMs);
  const coverageDurationMs=first&&last&&first.epoch===last.epoch?last.ownerSampledMs-first.ownerSampledMs:null;
  const spanValid=Number(!!first&&!!last&&first!==last&&coverageDurationMs!==null&&coverageDurationMs>=durationMs);
  if(!spanValid||deadlineExceeded)valid=0;
  return {version:1,coverageValid:valid,spanValid,startedMs,endedMs,durationMs,coverageDurationMs,deadlineExceeded,missing,dropped,
    coverageStartOwnerMs:first?.ownerSampledMs??null,coverageEndOwnerMs:last?.ownerSampledMs??null,
    externalResponseLatencyMeasured:0,newWritesAttributable:0,accounting,frames};
}
