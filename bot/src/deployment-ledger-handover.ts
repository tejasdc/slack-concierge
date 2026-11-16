import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {db} from './state-database';
import {runLedgerSteps} from './ledger-admission';
import {activateLedgerMaintenance,enableLedgerRecycling,initializeLedgerRecycling,installLedgerMaintenanceAuthority} from './ledger-durability';
import {ledgerDurable} from './ledger-durability-barrier';
import {acquireRecyclingLaunchAuthority,applicationIncarnation} from './deployment-launch-authority';
import {launchBootstrapPath,runningApplicationOffOwner,type ApplicationSelection} from './deployment-launch-authority';
import {isLiveLedgerPath} from './ledger-access-policy';
import {log,errorFields} from './log';

export type OwnerHandover={key:string;application:ApplicationSelection;artifactDigest:string};
type HandoverServices={application:()=>Promise<ApplicationSelection>;acquire:()=>Promise<()=>void|Promise<void>>;
 prime:()=>Promise<void>;prove:()=>Promise<void>;enable:()=>void};
const handoverServices:HandoverServices={application:runningApplicationOffOwner,acquire:acquireRecyclingLaunchAuthority,
 prime:initializeLedgerRecycling,prove:ledgerDurable,enable:enableLedgerRecycling};
let coordinator:DeploymentLedgerHandover|null=null;

export function ownerHandover(application:ApplicationSelection,artifactDigest:string):OwnerHandover{
 const key=createHash('sha256').update(JSON.stringify({application:applicationIncarnation(application),artifactDigest})).digest('hex');
 return{key,application,artifactDigest};
}

function event(runId:string,name:string,detail:Record<string,unknown>){
 if(!db.query('SELECT 1 FROM deployment_run_events WHERE run_id=? AND event=? AND json_extract(detail_json,\'$.key\')=?').get(runId,name,detail.key))
  db.query('INSERT INTO deployment_run_events(run_id,event,detail_json) VALUES(?,?,?)').run(runId,name,JSON.stringify(detail));
}

/** The old completion response remains compatible. It records custody; it never
 * waits for the sender's enclosing supervisor, which may be waiting for that response. */
export class DeploymentLedgerHandover{
 private active:Promise<void>|null=null;
 private complete=false;
 constructor(readonly owner:OwnerHandover,readonly services:HandoverServices=handoverServices){}

 register(runId:string):void{
 const owner=this.owner;
 const run=db.query('SELECT status,candidate_artifact_digest,service_invocation_id FROM deployment_runs WHERE id=?').get(runId) as any;
 if(!run||run.status!=='succeeded'||run.candidate_artifact_digest!==owner.artifactDigest)
  throw Error('Deployment handover does not match the serving application incarnation.');
 event(runId,'ledger_handover_pending',{...owner,bootstrap:launchBootstrapPath()});
 }

 reconcile():Promise<void>{
 if(this.complete)return Promise.resolve();
 if(this.active)return this.active;
 const observed=this.owner,services=this.services;
 const current=runLedgerSteps((function*(this:DeploymentLedgerHandover):Generator<unknown,void,any>{
  const application:ApplicationSelection=yield services.application();
  if(JSON.stringify(applicationIncarnation(application))!==JSON.stringify(applicationIncarnation(observed.application)))throw Error('Serving application changed during ledger handover.');
  const run=db.query('SELECT id,status FROM deployment_runs WHERE candidate_artifact_digest=? ORDER BY rowid DESC LIMIT 1')
   .get(observed.artifactDigest) as {id:string;status:string}|null;
  if(!run||run.status!=='succeeded')return;
  this.register(run.id);
  yield services.prove();
  // The first acquisition is an asynchronous eligibility observation. The prime
  // reacquires the same exclusion and validates the frontier under its own custody.
  const authority:()=>void|Promise<void>=yield services.acquire();
  yield authority();
  yield services.prime();
  event(run.id,'ledger_handover_complete',{...observed});
  yield services.prove();
  services.enable();this.complete=true;
  log('info','ledger_handover_complete',{run_id:run.id,key:observed.key});
 }).call(this));
 this.active=current;
 void current.then(()=>{if(this.active===current)this.active=null;},()=>{if(this.active===current)this.active=null;});
 return current;
 }
}

export function registerDeploymentLedgerHandover(runId:string):void{coordinator?.register(runId);}

/** Installed startup supplies a verified identity; disposable compositions supply
 * their own explicit service collaborator and exercise the same receiver instance. */
export function installDeploymentLedgerHandover(application:ApplicationSelection,artifactDigest:string,services:HandoverServices=handoverServices):DeploymentLedgerHandover{
 if(coordinator)throw Error('Deployment ledger handover is already installed.');
 return coordinator=new DeploymentLedgerHandover(ownerHandover(application,artifactDigest),services);
}

/** Startup does not reuse a prior incarnation's completion. Existing release events
 * reconstruct a lost pending reply; the same kernel lifetime proof must be made again. */
export async function startDeploymentLedgerHandover():Promise<void>{
 const directory=process.env.CONCIERGE_STATE_DIR;
 if(process.platform!=='linux'||!directory||!isLiveLedgerPath(join(directory,'state.db'))){activateLedgerMaintenance();return;}
 const application=await runningApplicationOffOwner();
 if(application.pid!==process.pid||application.ledgerCommands!==true)throw Error('Recycling startup requires the verified supervised application.');
 const artifactDigest=application.artifactDigest!;
 installDeploymentLedgerHandover(application,artifactDigest);
 installLedgerMaintenanceAuthority(acquireRecyclingLaunchAuthority);
 activateLedgerMaintenance({recycling:false});
 scheduleDeploymentLedgerHandover();
}

/** Called by existing owner reconciliation inputs. This never awaits an ancestor
 * from the deploy child, and introduces no independent timer, store or lease. */
export function scheduleDeploymentLedgerHandover():void{
 if(coordinator)void coordinator.reconcile().catch(error=>log('warn','ledger_handover_pending',errorFields(error)));
}
