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
  /** Why new Codex work is held for a session, in the words a requester reads; null when it is not. */
  reasonFor(outside:boolean):CodexAdmissionHoldReason|null{
    for(const [holder,sharedRuntimeOnly] of this.holders)if(!(outside&&sharedRuntimeOnly))return codexAdmissionHoldReason(holder);
    return null;
  }
}

export type CodexAdmissionHoldReason='account-switch'|'codex-update'|'app-server-repair'|'other';
/** The holder identity names its kind (`runner-provider-account-owner.ts`, `provider-activation.ts`). */
export function codexAdmissionHoldReason(holder:string):CodexAdmissionHoldReason{
  if(/^codex:(?:runner-activation:|local-account-activation$)/.test(holder))return 'account-switch';
  if(holder.startsWith('codex:runner-runtime-maintenance:'))return 'codex-update';
  if(/^codex:(?:runner-rehome:|local-rehome$)/.test(holder))return 'app-server-repair';
  return 'other';
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
