import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {startLiveSpeechListener} from './live-speech';
import {resolveRuntimeProfile,clearSandboxReadyReceipt,writeNativeSandboxReadyReceipt} from './runtime-profile';
import {db,abandonTurnArtifactBatch,claimNextQueuedTurn,nextQueuedTurnAttemptMs,registerProcessInstance,recoverUnsettledSteeringMessages,recoverTurnArtifactDeliveryClaims,observeExecutionChanges,type QueuedTurnClaimRow} from './state';
import {providers} from './providers';
import {SessionExecutionHost} from './session-execution-host';
import {installSessionProjection} from './session-projection';
import {SessionCommunicationCoordinator} from './session-communication';
import {ActiveTurnDispatchRegistry} from './turn-dispatch-seams';
import {SessionTurnQueueCoordinator} from './session-turn-queue';
import {currentProcessIdentity,isProcessIdentityAlive} from './runtime-identity';
import {startRoutedRequestApi,requestApiHandler} from './routed-request-api';
import {peerSettings,PeerClient,SessionPeers,startPeerListener} from './session-peers';
import {reconcileRecoverableTurns} from './turn-recovery';
import {retainSlackInput} from './session-inputs';
import {migrateInboxTopics} from './session-topics';
import {log,errorFields} from './log';
import {CodexSessionObserver} from './codex-session-observer';

/** Composition with the Slack surface removed; the same ledger, FIFO and executor remain. */
export async function startSessionRuntime() {
  const runtime=resolveRuntimeProfile();
  clearSandboxReadyReceipt(runtime);
  const instanceId=randomUUID(),identity=currentProcessIdentity();
  registerProcessInstance(instanceId,identity.pid,identity.bootId,identity.startTicks);
  let draining=false;
  const active=new Set<number>();
  const registry=new ActiveTurnDispatchRegistry({onStarted:()=>{},onSettled:()=>queue.wake()});
  let codexSessionObserver:CodexSessionObserver|null=null;
  const host=new SessionExecutionHost({instanceId,registry,providers,defaultCwd:process.env.CONCIERGE_WORKSPACE_ROOT||'/root/workspace',capabilitySocket:process.env.CONCIERGE_SESSION_CAPABILITY_SOCKET,wake:()=>queue.wake(),providerSessionBound:uuid=>codexSessionObserver?.providerSessionBound(uuid)??Promise.resolve()});
  codexSessionObserver=new CodexSessionObserver();
  const unavailable=()=>{throw new Error('Slack adapter is disabled.');};
  const isOwnerAlive=(owner:string)=>{const process=db.query('SELECT pid,boot_id AS bootId,process_start_ticks AS startTicks FROM process_instances WHERE instance_id=?').get(owner) as any;return !!process&&isProcessIdentityAlive(process);};
  const onError=(error:unknown)=>log('error','session_communication_failed',errorFields(error));
  const peering=peerSettings();
  const peers=peering.self?new SessionPeers({self:peering.self,clients:new Map(peering.peers.map(peer=>[peer.name,new PeerClient(peer.name,peer.url,peering.token!,peer.paths,peer.archives)])),owner:host.owner,onError,isOwnerAlive}):undefined;
  const communication=new SessionCommunicationCoordinator({owner:host.owner,isOwnerAlive,onError,...(peers?{peers}:{})});
  host.owner.communication=communication;
  const detachProjection=installSessionProjection(host.owner);
  // One topic per existing Inbox thread, once, after the schema migration state.ts ran.
  // Additive and safe while the Inbox is live; a second start finds its guard event.
  try {migrateInboxTopics();} catch(error) {log('error','inbox_topics_migration_failed',errorFields(error));}
  const queue=new SessionTurnQueueCoordinator({claim:()=>claimNextQueuedTurn(instanceId,Date.now(),registry.activeSessions),shouldStop:()=>draining,
    nextAttemptMs:()=>nextQueuedTurnAttemptMs(),
    run:async(claim:QueuedTurnClaimRow)=>{
      active.add(claim.turn_id);
      try {
        if(claim.turn_kind!=='native') {
          if(claim.turn_kind!=='slack_user'||!claim.slack_channel_id||!claim.slack_user_msg_ts)throw new Error('This queued adapter control requires its original surface.');
          const input=retainSlackInput(claim.slack_channel_id,claim.slack_user_msg_ts);
          abandonTurnArtifactBatch(claim.turn_id,'Slack publication is disabled; the original empty collection intent is retained.');
          db.query("UPDATE turns SET turn_kind='native',accepted_input_id=?,status_projection_status='not_needed' WHERE id=? AND owner_instance_id=? AND provider_admission_intended_at IS NULL").run(input.id,claim.turn_id,instanceId);
          claim={...claim,turn_kind:'native',accepted_input_id:input.id};
        }
        return await host.run(claim);
      } finally {active.delete(claim.turn_id);}
    },onError:(claim,error)=>{host.settleSetupFailure(claim,error);log('error','native_turn_setup_failed',{turn_id:claim.turn_id,...errorFields(error)});}});
  recoverUnsettledSteeringMessages(isProcessIdentityAlive);
  recoverTurnArtifactDeliveryClaims(isProcessIdentityAlive);
  await reconcileRecoverableTurns({client:null,instanceId,isOwnerAlive:isProcessIdentityAlive,nativeOnly:true,
    services:{deliverNativeResult:result=>host.deliverResult(result),deliverOutcome:unavailable,projectTurnStatus:unavailable,projectThreadSummary:unavailable}});
  const server=await startRoutedRequestApi(process.env.CONCIERGE_STATE_DIR!,null,null,communication,host.owner);
  const peerServer=peering.listen?startPeerListener({...peering.listen,token:peering.token!,fetch:requestApiHandler(null,null,communication,host.owner)}):null;
  // Words while he talks for Thinkering in this Mac's browser; null off a Mac.
  const liveSpeech=startLiveSpeechListener();
  if(peerServer)log('info','concierge_peer_listener_online',{instance:peering.self,hostname:peering.listen!.hostname,port:peering.listen!.port,peers:peering.peers.map(peer=>peer.name)});
  const detach=observeExecutionChanges(()=>queue.wake());
  codexSessionObserver.start();communication.start();queue.wake();
  writeNativeSandboxReadyReceipt(runtime,resolve(runtime.stateDir,'requests.sock'));
  log('info','concierge_session_owner_online',{instance_id:instanceId,slack_enabled:false});
  let stopping:Promise<void>|null=null;
  const stop=()=>stopping??=(async()=>{
    draining=true;clearSandboxReadyReceipt(runtime);detach();detachProjection();queue.stop();await communication.stop();await codexSessionObserver?.stop();
    for(const turnId of active){
      const row=db.query('SELECT session_id FROM turns WHERE id=?').get(turnId) as {session_id:number}|null;
      if(row){const cancellation=registry.requestSessionCancellation(row.session_id,turnId);if(cancellation.matched)await cancellation.completion;}
    }
    await server.stop(true);
    if(peerServer)await peerServer.stop(true);
    await liveSpeech?.stop();
  })();
  for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>void stop().then(()=>process.exit(0)));
  return {host,communication,server,stop};
}
