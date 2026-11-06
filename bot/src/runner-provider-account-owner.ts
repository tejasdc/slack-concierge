/** Owner-only guard around a runner's Codex App Server account replacement. */
import { holdCodexAdmission } from "./state";
import { runningCodexTurns } from "./provider-activation";
import { runnerMachineCall } from "./runner-machine-calls";

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
        const result=await runnerMachineCall<any>(runner,"accounts.codex.activate",{account,operationId},130_000);
        if(terminalActivation(result)){if(activeActivationOperationId===operationId)activeActivationOperationId=null;holdCodexAdmission(false);return;}
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
  holdCodexAdmission(true);
  try {
    const running = runningCodexTurns(excludeTurnId);
    if (running !== 0) { activeActivationOperationId=null;holdCodexAdmission(false); return { status: "deferred", detail: running < 0
      ? "Codex activity could not be checked, so the runner was left alone."
      : `The runner was left alone because ${running} Codex turn${running === 1 ? " is" : "s are"} still running.` }; }
    try{
      const result=await runnerMachineCall<any>(runner,"accounts.codex.activate",{account,operationId},130_000);
      if(terminalActivation(result)){activeActivationOperationId=null;holdCodexAdmission(false);return result;}
      // The runner can have restarted its App Server even when the relay answer was lost.
      // Keep admission closed and reconcile this same durable operation id until the runner
      // confirms applied/failed; a timeout is not evidence that switching stopped.
      void reconcileActivation(runner,account,operationId);
      return {status:'uncertain',detail:'The runner has not yet confirmed the Codex account switch; new Codex turns remain held while Concierge checks this same operation again.'};
    }catch(error){
      void reconcileActivation(runner,account,operationId);
      return {status:'uncertain',detail:`The runner did not confirm the Codex account switch; new Codex turns remain held while Concierge checks this same operation again. ${error instanceof Error?error.message:String(error)}`};
    }
  } catch(error) { activeActivationOperationId=null;holdCodexAdmission(false); throw error; }
}
