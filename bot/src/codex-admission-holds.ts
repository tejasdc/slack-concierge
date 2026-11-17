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
  get isOutsideHeld():boolean{return [...this.holders.values()].some(sharedRuntimeOnly=>!sharedRuntimeOnly);}
}

function isSharedRuntimeMaintenance(holder:string,recovery:unknown):boolean{
  if(!recovery||typeof recovery!=='object')return false;
  const value=recovery as Record<string,unknown>;
  return value.kind==='runner-runtime-maintenance'
    && ['runner','sourceInputId','sourceRunId','actionId'].every(key=>typeof value[key]==='string'&&(value[key] as string).trim().length>0)
    && typeof value.operationId==='string'&&/^runtime:[a-f0-9]{40}$/.test(value.operationId)
    && typeof value.requiredCommit==='string'&&/^[a-f0-9]{40}$/.test(value.requiredCommit)
    && holder===`codex:runner-runtime-maintenance:${value.runner}:${value.operationId}`;
}
