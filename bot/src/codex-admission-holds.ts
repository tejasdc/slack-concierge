/** Only a source-bound shared-runtime maintenance hold leaves independent CLI admission open. */
export class CodexAdmissionHolds {
  private readonly holders=new Map<string,boolean>();
  set(holder:string,held:boolean,recovery?:unknown):boolean{
    if(!holder.trim())throw new Error('A Codex admission hold needs a stable holder identity.');
    if(held){
      const sharedRuntimeOnly=isSharedRuntimeMaintenance(holder,recovery);
      const changed=this.holders.get(holder)!==sharedRuntimeOnly;
      this.holders.set(holder,sharedRuntimeOnly);return changed;
    }
    return this.holders.delete(holder);
  }
  get isHeld():boolean{return this.holders.size>0;}
  get names():string[]{return [...this.holders.keys()];}
  get isOutsideHeld():boolean{return [...this.holders.values()].some(sharedRuntimeOnly=>!sharedRuntimeOnly);}
}

export function isSharedRuntimeMaintenance(holder:string,recovery:unknown):boolean{
  if(!recovery||typeof recovery!=='object')return false;
  const value=recovery as Record<string,unknown>;
  return value.kind==='runner-runtime-maintenance'
    && ['runner','sourceInputId','sourceRunId','actionId'].every(key=>typeof value[key]==='string'&&(value[key] as string).trim().length>0)
    && typeof value.operationId==='string'&&/^runtime:[a-f0-9]{40}$/.test(value.operationId)
    && typeof value.requiredCommit==='string'&&/^[a-f0-9]{40}$/.test(value.requiredCommit)
    && holder===`codex:runner-runtime-maintenance:${value.runner}:${value.operationId}`;
}

/**
 * Runner re-home and account-switch holds guard one bounded runner call (220 s and 130 s). Once
 * this much time has passed since the hold was taken, the call it guarded has ended on the runner
 * whatever its lost answer said, so the hold is released instead of waiting on running work. On
 * 2026-11-17 an unbounded re-home hold queued every new server Codex turn for over an hour.
 */
export const CODEX_RUNNER_HOLD_BOUND_MS=5*60_000;
const BOUNDED_KINDS=new Set(['runner-rehome','runner-activation']);
type HoldRow={holder:string;recovery_json:string;created_at_ms:number};
type Source={query:(sql:string)=>{all:(...args:any[])=>unknown[]}};
function holdKind(row:HoldRow):string|null{
  try{const value=JSON.parse(row.recovery_json);return value&&typeof value.kind==='string'?value.kind:null;}catch{return null;}
}
/** Durable holds whose bounded runner call has certainly ended. */
export function expiredCodexRunnerHolds(source:Source,nowMs:number):Array<{holder:string;kind:string;ageMs:number}>{
  return (source.query('SELECT holder,recovery_json,created_at_ms FROM codex_admission_holds').all() as HoldRow[])
    .flatMap(row=>{const kind=holdKind(row);
      return kind&&BOUNDED_KINDS.has(kind)&&nowMs-row.created_at_ms>=CODEX_RUNNER_HOLD_BOUND_MS?[{holder:row.holder,kind,ageMs:nowMs-row.created_at_ms}]:[];});
}
export type CodexAdmissionHoldFact={kind:string;holder:string;sinceMs:number;clearsAtMs:number|null};
/**
 * Why a queued Codex turn is not admitted, from the durable holds both the owner and the read-only
 * presentation worker can see. An independent outside run passes a shared-runtime maintenance hold.
 */
export function codexAdmissionHoldFact(source:Source,outside:boolean):CodexAdmissionHoldFact|null{
  const rows=(source.query('SELECT holder,recovery_json,created_at_ms FROM codex_admission_holds ORDER BY created_at_ms').all() as HoldRow[])
    .filter(row=>{if(!outside)return true;let recovery:unknown;try{recovery=JSON.parse(row.recovery_json);}catch{}return !isSharedRuntimeMaintenance(row.holder,recovery);});
  const row=rows[0];if(!row)return null;
  const kind=holdKind(row)??'unknown';
  return {kind,holder:row.holder,sinceMs:row.created_at_ms,clearsAtMs:BOUNDED_KINDS.has(kind)?row.created_at_ms+CODEX_RUNNER_HOLD_BOUND_MS:null};
}
