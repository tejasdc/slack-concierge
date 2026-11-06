/** Owner-only guard around a runner's Codex App Server account replacement. */
import { codexAdmissionRecoveryHolds, holdCodexAdmission } from "./state";
import { runningCodexTurns } from "./provider-activation";
import { runnerMachineCall } from "./runner-machine-calls";
import {withCodexRestartLock} from './codex-restart-lock';
import {externallyRunningCodexTurns} from './provider-activation';

const activationReconciliations=new Map<string,Promise<void>>();
let activeActivationOperationId:string|null=null;

function terminalActivation(answer:any):boolean {
  return answer?.status==='applied'||answer?.status==='failed';
}

async function reconcileActivation(runner:string,account:string,operationId:string):Promise<void>{
  if(activationReconciliations.has(operationId))return;
  const work=(async()=>{
    for(;;){
      try{
        const result=await withCodexRestartLock(()=>runnerMachineCall<any>(runner,"accounts.codex.activate",{account,operationId},130_000));
        if(terminalActivation(result)){if(activeActivationOperationId===operationId)activeActivationOperationId=null;holdCodexAdmission(`codex:runner-activation:${runner}:${operationId}`,false);return;}
        if(result?.status==='uncertain')return;
      }catch{}
      await new Promise(resolve=>setTimeout(resolve,5_000));
    }
  })().finally(()=>activationReconciliations.delete(operationId));
  activationReconciliations.set(operationId,work);
}

export async function activateRunnerCodexAccount(runner: string, account: string, operationId: string, excludeTurnId?: number): Promise<unknown> {
  if (!runner.trim() || !account.trim() || !operationId.trim()) throw new Error("A runner, Codex account and stable activation operation id are required.");
  if(activeActivationOperationId&&activeActivationOperationId!==operationId)
    return {status:'deferred',detail:'Another runner Codex account switch is unresolved; admission remains held until that exact operation is confirmed.'};
  activeActivationOperationId=operationId;
  const admissionHolder=`codex:runner-activation:${runner}:${operationId}`;
  holdCodexAdmission(admissionHolder,true,{kind:'runner-activation',runner,account,operationId});
  try {
    let result:any;
    try{result=await withCodexRestartLock(async()=>{
        // Recheck after queueing: an App Server re-home may have held this operation behind it,
        // and a Mac Codex client can start independently of the owner's turn queue.
        const running=runningCodexTurns(excludeTurnId),external=externallyRunningCodexTurns();
        if(running!==0||external!==0)return {status:'deferred',detail:running<0||external<0
          ?'Codex activity could not be checked, so the runner was left alone.'
          :'A Codex turn is active on the owner or another Codex client, so the runner was left alone.'};
        return runnerMachineCall<any>(runner,"accounts.codex.activate",{account,operationId},130_000);
      });}
    catch(error){
      void reconcileActivation(runner,account,operationId);
      return {status:'uncertain',detail:`The runner did not confirm the Codex account switch; new Codex turns remain held while Concierge checks this same operation again. ${error instanceof Error?error.message:String(error)}`};
    }
    if(result?.status==='deferred'){activeActivationOperationId=null;holdCodexAdmission(admissionHolder,false);return result;}
    if(terminalActivation(result)){activeActivationOperationId=null;holdCodexAdmission(admissionHolder,false);return result;}
    // The runner can have restarted its App Server even when the relay answer was lost.
    // Keep admission closed and reconcile this same durable operation id until the runner
    // confirms applied/failed; a timeout is not evidence that switching stopped.
    void reconcileActivation(runner,account,operationId);
    return {status:'uncertain',detail:'The runner has not yet confirmed the Codex account switch; new Codex turns remain held while Concierge checks this same operation again.'};
  } catch(error) { activeActivationOperationId=null;holdCodexAdmission(admissionHolder,false); throw error; }
}

/** Reconcile durable runner operations after an owner process restart, without gating startup. */
export function resumeRunnerCodexAdmissionHolds():void{
  for(const {recovery} of codexAdmissionRecoveryHolds())if(recovery.kind==='runner-activation'){
    activeActivationOperationId=recovery.operationId;
    holdCodexAdmission(`codex:runner-activation:${recovery.runner}:${recovery.operationId}`,true,recovery);
    void reconcileActivation(recovery.runner,recovery.account,recovery.operationId);
  }
}
