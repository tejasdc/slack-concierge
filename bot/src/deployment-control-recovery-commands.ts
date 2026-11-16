import {createHash} from 'node:crypto';
import * as state from './deployment-state';
import {db} from './state';

export type RecoverySelection={runId?:string|null;incidentId?:string|null};
function observe(selection:RecoverySelection) {
 const intent=selection.runId?state.getControlRecoveryIntent(selection.runId):null;
 const incident=state.getDeploymentRepairIncident(selection.incidentId??intent?.incidentId??'');
 const incidentRun=incident?state.getDeploymentRun(incident.run_id):null;
 const target=incidentRun?.target??'concierge';
 return {selection,intent,incident,incidentRun,lkgUnavailableError:state.LKG_UNAVAILABLE_ERROR,run:selection.runId?state.getDeploymentRun(selection.runId):null,
  lkg:state.getLastKnownGoodRelease(),desired:state.getDeploymentDesiredState(),latest:state.getLatestDeploymentRun(),
  active:state.getActiveDeploymentRun(target),history:incidentRun?state.listDeploymentRunEvents(incidentRun.id):[],
  mask:selection.runId?state.controlRecoveryEvent(selection.runId,'control_recovery_mask_intended'):null};
}
export type RecoveryObservation=ReturnType<typeof observe>;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Operation={kind:'prepare'|'prepare-self'|'prepare-lost'|'event'|'claim'|'failed'|'prepared';args:any[]};
export type RecoveryLedgerCommand={selection:RecoverySelection;expected?:string;operations?:Operation[]};

function execute(operation:Operation):unknown {
 const a=operation.args;
 switch(operation.kind){
  case 'prepare':return state.prepareControlRecovery(a[0]);
  case 'prepare-self':return state.prepareSelfVerificationControlRecovery(a[0]);
  case 'prepare-lost':return state.prepareLostRegistryControlRecovery(a[0]);
  case 'event':state.recordControlRecoveryEvent(a[0],a[1],a[2]);return null;
  case 'claim':return state.claimControlRecovery(a[0],a[1]);
  case 'failed':return state.failControlRecovery(a[0],a[1]);
  case 'prepared':return state.recordDeploymentReleasePrepared(a[0],a[1],a[2]);
  default:throw Error('Unknown controller recovery ledger operation.');
 }
}

/** Replay recognition uses existing durable recovery evidence, never transport success.
 * Every operation is inspected before executing any part of the original atomic batch. */
function replay(operation:Operation):{matched:boolean;result:unknown} {
 const a=operation.args;
 switch(operation.kind){
  case 'prepare':case 'prepare-self':case 'prepare-lost':{
   const intent=operation.kind==='prepare-lost'?a[0].intent:a[0];
   const existing=state.getControlRecoveryIntent(intent.runId);
   return {matched:Boolean(existing)&&digest(existing)===digest(intent),result:existing};
  }
  case 'event':{
   const existing=state.controlRecoveryEvent(a[0],a[1]);
   return {matched:Boolean(existing)&&digest(existing)===digest({...a[2],recovery_run_id:a[0]}),result:null};
  }
  case 'claim':{
   const run=state.getDeploymentRun(a[0]);
   return {matched:run?.status==='succeeded'||Boolean(run&&run.runner_pid===a[1]?.pid&&run.runner_boot_id===a[1]?.bootId&&run.runner_start_ticks===a[1]?.startTicks),result:run};
  }
  case 'failed':{
   const run=state.getDeploymentRun(a[0]);const event=state.controlRecoveryEvent(a[0],'control_recovery_failed');
   return {matched:Boolean(event&&event.error===a[1]&&run&&(run.status==='succeeded'||run.status==='releasing'&&run.error===a[1]&&run.runner_pid===null)),result:run};
  }
  case 'prepared':{
   const release=state.getDeploymentRelease(a[2]?.artifact_digest);
   return {matched:Boolean(release&&release.run_id===a[0]&&release.artifact_path===a[1]
    &&release.git_commit===a[2]?.git_commit&&release.source_tree_digest===a[2]?.source_tree_digest
    &&release.runtime_digest===a[2]?.runtime_digest&&release.compatibility_digest===a[2]?.compatibility_digest),result:release};
  }
  default:throw Error('Unknown controller recovery ledger operation.');
 }
}

/** This module contains only ledger operations; preparation, Git and systemd stay external. */
export function dispatchControlRecoveryCommand(input:RecoveryLedgerCommand) {
 if(!input||typeof input!=='object'||!input.selection||typeof input.selection!=='object')throw Error('Invalid controller recovery command.');
 if(input.operations&&!Array.isArray(input.operations))throw Error('Invalid controller recovery operations.');
 for(const operation of input.operations??[]){
  if(!operation||!Array.isArray(operation.args))throw Error('Invalid controller recovery operation.');
  if(operation.kind==='event'&&!['operator_failure_observed','control_recovery_mask_intended','control_recovery_contained',
   'control_recovery_launch_intended','control_recovery_unmasked'].includes(operation.args[1]))throw Error('Unknown controller recovery event.');
 }
 const perform=()=>{
  const before=observe(input.selection);
  const operations=input.operations??[];
  let results:unknown[]=[];
  if(operations.length){
   const prior=operations.map(replay);
   if(prior.every(item=>item.matched))results=prior.map(item=>item.result);
   else {
    if(input.expected!==digest(before))throw Error('Controller recovery observation changed; refusing stale decision.');
    results=operations.map(execute);
   }
  }
  const observation=observe(input.selection);
  return {observation,expected:digest(observation),results};
 };
 return input.operations?.length?state.writeDeploymentTransaction(perform)():db.transaction(perform).deferred();
}
