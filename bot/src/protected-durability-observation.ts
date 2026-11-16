import {randomBytes} from 'node:crypto';

export const DURABILITY_OBSERVATION = {version:1, detailLimit:256, outstandingLimit:2048} as const;
export type DurabilityLane = 'owner_receipt'|'provider_input';
/** 0: no coverage proof, 1: already covered, 2: confirmed sync, 3: synchronous commits, 4: failed path. */
export type DurabilityOutcome = 0|1|2|3|4;
export type DurabilityOperation = {proof:DurabilityOutcome; finish:(outcome:DurabilityOutcome)=>void};
type Completion = {sequence:number; enteredMs:number; completedMs:number; durationMs:number; outcome:DurabilityOutcome};
const lane = () => ({entered:0, completed:0, failed:0, unknown:0, alreadyCovered:0, confirmedSync:0,
  synchronous:0, totalDurationMs:0, maxDurationMs:0, detailDropped:0, startsDropped:0,
  active:new Map<object,number>(), unknownActive:0, completions:[] as Completion[]});

/** Memory only. Export never drains it, and an absent observer never participates in release. */
export class ProtectedDurabilityObservation {
  readonly epoch = randomBytes(6).readUIntBE(0,6);
  readonly startedMs:number;
  readonly lanes = {owner_receipt:lane(),provider_input:lane()};
  installed = 0;
  errors = 0;
  unlabelled = 0;
  constructor(private readonly clock=()=>performance.now(),
    private readonly detailLimit:number=DURABILITY_OBSERVATION.detailLimit,
    private readonly outstandingLimit:number=DURABILITY_OBSERVATION.outstandingLimit) {this.startedMs=this.clock();}
  begin(kind?:DurabilityLane):DurabilityOperation {
    const operation:DurabilityOperation={proof:0,finish:()=>{}};
    if(!kind){this.unlabelled++;return operation;}
    try {
      const state=this.lanes[kind],enteredMs=this.clock();
      state.entered++;
      const tracked=state.active.size<this.outstandingLimit;
      if(tracked)state.active.set(operation,enteredMs);
      else {state.unknownActive++;state.startsDropped++;}
      let finished=false;
      operation.finish=outcome=>{
        if(finished)return;
        finished=true;
        try {
          const completedMs=this.clock(),durationMs=Math.max(0,completedMs-enteredMs);
          if(tracked)state.active.delete(operation);else state.unknownActive--;
          if(outcome===4)state.failed++;
          else if(outcome===0)state.unknown++;
          else {state.completed++;if(outcome===1)state.alreadyCovered++;if(outcome===2)state.confirmedSync++;if(outcome===3)state.synchronous++;}
          state.totalDurationMs+=durationMs;state.maxDurationMs=Math.max(state.maxDurationMs,durationMs);
          const sequence=state.completed+state.failed+state.unknown;
          if(state.completions.length===this.detailLimit){state.completions.shift();state.detailDropped++;}
          state.completions.push({sequence,enteredMs,completedMs,durationMs,outcome});
        } catch {this.errors++;}
      };
    } catch {this.errors++;}
    return operation;
  }
  snapshot() {
    const sampledMs=this.clock();
    const snapshotLane=(state:ReturnType<typeof lane>)=>{
      const {active,unknownActive,completions,...counts}=state;
      let oldestTrackedMs:number|null=null;
      for(const start of active.values())oldestTrackedMs=Math.max(oldestTrackedMs??0,sampledMs-start);
      const outstanding=state.entered-state.completed-state.failed-state.unknown;
      return {...counts,outstanding,trackedOutstanding:active.size,unknownOutstanding:unknownActive,
        oldestOutstandingMs:unknownActive?null:oldestTrackedMs,oldestTrackedMs,
        accountingValid:Number(outstanding===active.size+unknownActive),
        details:completions.map(value=>({...value}))};
    };
    return {version:DURABILITY_OBSERVATION.version,epoch:this.epoch,startedMs:this.startedMs,sampledMs,
      sampledWallMs:Date.now(),installed:this.installed,errors:this.errors,unlabelled:this.unlabelled,
      detailLimit:this.detailLimit,outstandingLimit:this.outstandingLimit,
      lanes:{owner_receipt:snapshotLane(this.lanes.owner_receipt),provider_input:snapshotLane(this.lanes.provider_input)}};
  }
}
export const protectedDurability = new ProtectedDurabilityObservation();
export type ProtectedDurabilitySnapshot = ReturnType<ProtectedDurabilityObservation['snapshot']>;
