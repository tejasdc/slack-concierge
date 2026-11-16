import {isProcessIdentityAlive} from "./runtime-identity";
import * as state from './deployment-state';
import {db,getTurnCommitProvenance} from './state';

/** Closed commands execute on the canonical owner, inside its admission and receipt fence. */
export function dispatchRepairLedgerCommand(input:any):unknown {
 const observation=["getDeploymentRepairIncident","getDeploymentRun","latestDeploymentRepairAgentRun","getDeploymentRepairBudget","getTurnCommitProvenance","observeDeploymentRepair","observeInterruptedDeploymentRecovery","assertDeploymentRepairOwner"].includes(input?.operation);
 return observation?db.transaction(()=>dispatch(input)).deferred():state.writeDeploymentTransaction(()=>dispatch(input))();
}
function dispatch(input:any):unknown {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid repair command.');
  const a=input.args;
  if(!Array.isArray(a))throw new Error('Invalid repair command arguments.');
  switch(input.operation) {
    case 'requestDeploymentFromAgent': {const c=state.deploymentContinuationForAgent(a[0]);return state.requestDeployment({sourceTurnId:c.sourceTurnId,ownerInstanceId:c.ownerInstanceId,expectedCommit:a[1]});}
    case 'requestOperatorDeployment': return state.requestOperatorDeployment();
    case 'observeDeploymentRepair': {const incident=state.getDeploymentRepairIncident(a[0]);return {incident,run:incident?state.getDeploymentRun(incident.run_id):null,agent:state.latestDeploymentRepairAgentRun(a[0],"repair")};}
    case 'getDeploymentRepairIncident': return state.getDeploymentRepairIncident(a[0]);
    case 'getDeploymentRun': return state.getDeploymentRun(a[0]);
    case 'latestDeploymentRepairAgentRun': return state.latestDeploymentRepairAgentRun(a[0],a[1]);
    case 'getDeploymentRepairBudget': return state.getDeploymentRepairBudget(a[0]);
    case 'observeInterruptedDeploymentRecovery': return {
      runs:state.listDeadCandidateDeploymentRuns(isProcessIdentityAlive),
      lastKnownGood:state.getLastKnownGoodRelease(),
    };
    case 'getTurnCommitProvenance': return getTurnCommitProvenance(a[0]);
    case 'beginDeploymentRepair': return state.beginDeploymentRepairCommand(a[0],input.commandId);
    case 'claimDeploymentRepair': return state.claimDeploymentRepair(a[0]);
    case 'recoverDeadDeploymentRuns': return state.recoverDeadDeploymentRuns(isProcessIdentityAlive);
  }
  // All changing commands belonging to an incident retain the original supervisor identity.
  const current=state.getDeploymentRepairIncident(input.incidentId);
  const terminalReplay=current&&["parked","completed"].includes(current.status)&&["parkDeploymentRepair","completeDeploymentRepairIncident","parkDeploymentRepairAgentRun","completeDeploymentRepairAgentRun","settleDeploymentRepairAgent"].includes(input.operation);
  if(terminalReplay) {
    if(current.supervisor_pid!==input.identity?.pid||current.supervisor_boot_id!==input.identity?.bootId||current.supervisor_start_ticks!==input.identity?.startTicks)throw new Error("Repair terminal replay owner differs.");
    if(input.operation==="parkDeploymentRepair"&&current.status==="parked"&&current.error===a[1])return current;
    if(input.operation==="completeDeploymentRepairIncident"&&current.status==="completed")return current;
    if(input.operation==="settleDeploymentRepairAgent") {
      const settlement=a[0],agent=state.getDeploymentRepairAgentRun(settlement?.agentRunId);
      if(agent?.incident_id===current.id&&current.status==="parked"&&current.error===settlement.parkError&&((agent.launch_state==="completed"&&agent.result_json===JSON.stringify(settlement.result))||(agent.launch_state==="parked"&&agent.error===settlement.error)))return agent;
      throw new Error("Repair settlement replay differs.");
    }
    const agent=state.getDeploymentRepairAgentRun(a[0]);
    if(agent?.incident_id===current.id&&input.operation==="parkDeploymentRepairAgentRun"&&agent.launch_state==="parked"&&agent.error===a[1])return null;
    if(agent?.incident_id===current.id&&input.operation==="completeDeploymentRepairAgentRun"&&agent.launch_state==="completed"&&agent.result_json===JSON.stringify(a[1]))return null;
    throw new Error("Repair terminal replay differs from original settlement.");
  }
  const incident=state.assertDeploymentRepairOwner(input.incidentId,input.identity);
  switch(input.operation) {
    case 'assertDeploymentRepairOwner': return incident;
    case 'recordDeploymentRepairWorkspace': return state.recordDeploymentRepairWorkspace(incident.id,a[1],a[2],a[3]);
    case 'recordDeploymentRepairCommit': return state.recordDeploymentRepairCommit(incident.id,a[1]);
    case 'prepareDeploymentRetry': return state.prepareDeploymentRetry(incident.id);
    case 'completeDeploymentRepairIncident': return state.completeDeploymentRepairIncident(incident.id);
    case 'parkDeploymentRepair': return state.parkDeploymentRepair(incident.id,a[1],a[2]);
    case 'prepareDeploymentRepairAgentLaunch':
      if(a[0]?.incidentId!==incident.id||a[0]?.supervisorPid!==input.identity.pid
        ||a[0]?.supervisorBootId!==input.identity.bootId||a[0]?.supervisorStartTicks!==input.identity.startTicks)
        throw new Error('Repair launch owner differs.');
      return state.prepareDeploymentRepairAgentLaunch(a[0]);
    case 'settleDeploymentRepairAgent': {
      const agent=state.getDeploymentRepairAgentRun(a[0]?.agentRunId);
      if(agent?.incident_id!==incident.id)throw new Error("Repair settlement belongs to another incident.");
      return state.settleDeploymentRepairAgent(a[0]);
    }
    case 'recordDeploymentRepairChild':
    case 'bindDeploymentRepairSession':
    case 'completeDeploymentRepairAgentRun':
    case 'parkDeploymentRepairAgentRun': {
      const agent=state.getDeploymentRepairAgentRun(a[0]);
      if(!agent||agent.incident_id!==incident.id)throw new Error('Repair agent belongs to another incident.');
      if(input.operation==='recordDeploymentRepairChild'){state.recordDeploymentRepairChild(a[0],a[1]);return null;}
      if(input.operation==='bindDeploymentRepairSession'){state.bindDeploymentRepairSession(a[0],a[1]);return null;}
      if(input.operation==='completeDeploymentRepairAgentRun'){state.completeDeploymentRepairAgentRun(a[0],a[1]);return null;}
      state.parkDeploymentRepairAgentRun(a[0],a[1]);return null;
    }
    default: throw new Error('Unknown repair ledger command.');
  }
}
