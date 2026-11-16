import {randomUUID} from "node:crypto";
import {deploymentLedgerMode} from "./deployment-launch-authority";
import {deploymentOwnerJson} from "./deployment-owner-fetch";
import type * as State from "./deployment-state";
import type {getTurnCommitProvenance as Provenance} from "./state";

type RepairCommandContext={incidentId?:string;identity?:{pid:number;bootId:string;startTicks:string};commandId?:string};
function acceptedCommandContext(operation:string,context:RepairCommandContext):RepairCommandContext {
  return operation==="beginDeploymentRepair"?{...context,commandId:context.commandId??randomUUID()}:context;
}

export async function repairLedgerCommand(operation:string,args:unknown[],context:RepairCommandContext={}):Promise<any> {
  const stableContext=acceptedCommandContext(operation,context),input={operation,args,...stableContext};
  if(await deploymentLedgerMode()==="legacy")return (await import("./deployment-repair-commands")).dispatchRepairLedgerCommand(input);
  return repairLedgerOwnerCommand(operation,args,stableContext);
}

/** Use only after the caller selected the serving owner for this whole recovery attempt. */
export async function repairLedgerOwnerCommand(operation:string,args:unknown[],context:RepairCommandContext={}):Promise<any> {
  const input={operation,args,...acceptedCommandContext(operation,context)};
  const {response,body:result}=await deploymentOwnerJson("/internal/deployment-repair",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)},{replaySafe:!["requestDeploymentFromAgent","requestOperatorDeployment"].includes(operation)});
  if(!response.ok)throw new Error(`Serving owner refused repair command ${operation}: ${JSON.stringify(result)}`);
  return result;
}

/** One owner snapshot keeps the interrupted runs and their rollback release in one view. */
export async function observeInterruptedDeploymentRecovery():Promise<{
  runs:State.DeploymentRunRow[];
  lastKnownGood:State.DeploymentReleaseRow|null;
}> {
  return repairLedgerOwnerCommand("observeInterruptedDeploymentRecovery",[]) as Promise<{
    runs:State.DeploymentRunRow[];
    lastKnownGood:State.DeploymentReleaseRow|null;
  }>;
}

export function repairLedgerClient(incidentId:string,identity:{pid:number;bootId:string;startTicks:string}) {
  const command=(operation:string,args:unknown[])=>repairLedgerCommand(operation,args,{incidentId,identity});
  return {
    bindDeploymentRepairSession: (...args:Parameters<typeof State.bindDeploymentRepairSession>)=>command("bindDeploymentRepairSession",args) as Promise<ReturnType<typeof State.bindDeploymentRepairSession>>,
    assertDeploymentRepairOwner: (...args:Parameters<typeof State.assertDeploymentRepairOwner>)=>command("assertDeploymentRepairOwner",args) as Promise<ReturnType<typeof State.assertDeploymentRepairOwner>>,
    claimDeploymentRepair: (...args:Parameters<typeof State.claimDeploymentRepair>)=>command("claimDeploymentRepair",args) as Promise<ReturnType<typeof State.claimDeploymentRepair>>,
    completeDeploymentRepairAgentRun: (...args:Parameters<typeof State.completeDeploymentRepairAgentRun>)=>command("completeDeploymentRepairAgentRun",args) as Promise<ReturnType<typeof State.completeDeploymentRepairAgentRun>>,
    completeDeploymentRepairIncident: (...args:Parameters<typeof State.completeDeploymentRepairIncident>)=>command("completeDeploymentRepairIncident",args) as Promise<ReturnType<typeof State.completeDeploymentRepairIncident>>,
    getDeploymentRepairIncident: (...args:Parameters<typeof State.getDeploymentRepairIncident>)=>command("getDeploymentRepairIncident",args) as Promise<ReturnType<typeof State.getDeploymentRepairIncident>>,
    getDeploymentRepairBudget: (...args:Parameters<typeof State.getDeploymentRepairBudget>)=>command("getDeploymentRepairBudget",args) as Promise<ReturnType<typeof State.getDeploymentRepairBudget>>,
    getDeploymentRun: (...args:Parameters<typeof State.getDeploymentRun>)=>command("getDeploymentRun",args) as Promise<ReturnType<typeof State.getDeploymentRun>>,
    latestDeploymentRepairAgentRun: (...args:Parameters<typeof State.latestDeploymentRepairAgentRun>)=>command("latestDeploymentRepairAgentRun",args) as Promise<ReturnType<typeof State.latestDeploymentRepairAgentRun>>,
    parkDeploymentRepair: (...args:Parameters<typeof State.parkDeploymentRepair>)=>command("parkDeploymentRepair",args) as Promise<ReturnType<typeof State.parkDeploymentRepair>>,
    parkDeploymentRepairAgentRun: (...args:Parameters<typeof State.parkDeploymentRepairAgentRun>)=>command("parkDeploymentRepairAgentRun",args) as Promise<ReturnType<typeof State.parkDeploymentRepairAgentRun>>,
    prepareDeploymentRepairAgentLaunch: (...args:Parameters<typeof State.prepareDeploymentRepairAgentLaunch>)=>command("prepareDeploymentRepairAgentLaunch",args) as Promise<ReturnType<typeof State.prepareDeploymentRepairAgentLaunch>>,
    prepareDeploymentRetry: (...args:Parameters<typeof State.prepareDeploymentRetry>)=>command("prepareDeploymentRetry",args) as Promise<ReturnType<typeof State.prepareDeploymentRetry>>,
    recoverDeadDeploymentRuns: ()=>command("recoverDeadDeploymentRuns",[]) as Promise<ReturnType<typeof State.recoverDeadDeploymentRuns>>,
    recordDeploymentRepairChild: (...args:Parameters<typeof State.recordDeploymentRepairChild>)=>command("recordDeploymentRepairChild",args) as Promise<ReturnType<typeof State.recordDeploymentRepairChild>>,
    recordDeploymentRepairCommit: (...args:Parameters<typeof State.recordDeploymentRepairCommit>)=>command("recordDeploymentRepairCommit",args) as Promise<ReturnType<typeof State.recordDeploymentRepairCommit>>,
    recordDeploymentRepairWorkspace: (...args:Parameters<typeof State.recordDeploymentRepairWorkspace>)=>command("recordDeploymentRepairWorkspace",args) as Promise<ReturnType<typeof State.recordDeploymentRepairWorkspace>>,
    settleDeploymentRepairAgent:(input:Parameters<typeof State.settleDeploymentRepairAgent>[0])=>command("settleDeploymentRepairAgent",[input]) as Promise<ReturnType<typeof State.settleDeploymentRepairAgent>>,
    observeDeploymentRepair:()=>command("observeDeploymentRepair",[incidentId]) as Promise<{incident:State.DeploymentRepairIncidentRow;run:State.DeploymentRunRow|null;agent:State.DeploymentRepairAgentRunRow|null}>,
    getTurnCommitProvenance:(...args:Parameters<typeof Provenance>)=>command("getTurnCommitProvenance",args) as Promise<ReturnType<typeof Provenance>>,
  };
}

export async function manualLedgerCommand(input:Record<string,unknown>):Promise<any> {
 if(await deploymentLedgerMode()==="legacy")return (await import("./manual-ledger-commands")).dispatchManualLedgerCommand(input);
 const {response,body:result}=await deploymentOwnerJson("/internal/manual-ledger",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});
 if(!response.ok)throw new Error(`Serving owner refused manual ledger command: ${JSON.stringify(result)}`);
 return result;
}
