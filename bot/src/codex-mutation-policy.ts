import {db} from './state';
import {readFileSync} from 'node:fs';
import {grantCodexMutationPermit,consumeCodexMutationPermit,recordCodexMutationResponse,reconcileCodexMutationIntent} from './codex-mutation-fence';
import {prepareCodexRecoveryMutation,consumeCodexRecoveryMutation,recordCodexRecoveryMutationResponse,
  authorizeCodexRecoveryInterrupt,consumeCodexRecoveryInterrupt,recordCodexRecoveryInterruptResponse} from './codex-recovery-dispatch-authorization';
import {registerManagedCodexChild,observeManagedCodexChildExit} from './codex-managed-process-registry';
import {mutationDigest} from './codex-mutation-channel.mjs';
import {CODEX_DAEMON_LIFECYCLE_METHOD,runnerCodexLifecycleOutcome} from './codex-daemon-lifecycle';
import {reconcileManagedCodexMutationFromRetainedTerminal} from './codex-managed-native-terminal';

/** Private transport command. It never accepts a caller's claim that an Astra
 * continuation is authorized. Recovery capability admission is owned separately. */
export function codexMutationGate(input:any){
  const id=(value:unknown,max=256)=>typeof value==='string'&&value.length>0&&value.length<=max;
  const digest=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  const processPhase=input?.phase==='register-process'||input?.phase==='observed-exit';
  if(!input||!['prepare','consume','response','register-process','observed-exit'].includes(input.phase)||!id(input.connectionId)
    ||!id(input.permitId,512)||!input.permitId.startsWith(`${input.connectionId}:`)
    ||(processPhase?!id(input.method):input.intentId!==input.permitId||!id(input.method))
    ||!digest(input.paramsDigest)||input.threadId!==null&&input.threadId!==undefined&&!id(input.threadId))
    return {allowed:false,forward:false,reason:'invalid_mutation_identity'};
  const threadId=input.threadId??'*';
  if(!['response','observed-exit'].includes(input.phase)&&mutationDigest(input.params??{})!==input.paramsDigest)
    return {allowed:false,forward:false,reason:'actual_native_parameter_digest_conflict'};
  if(input.phase==='register-process'){
    if(!Number.isInteger(input.pid)||input.pid<1)return {registered:false,reason:'invalid_native_process_id'};
    if(input.method==='managed/proxy-process'){
      const params={kind:'rawproxy',threadScope:'*',mediated:true};
      if(input.permitId!==`${input.connectionId}:process`||input.intentId!==null||input.threadId!==null||mutationDigest(params)!==input.paramsDigest||
        mutationDigest(input.params??{})!==input.paramsDigest)
        return {registered:false,reason:'proxy_process_registration_identity_conflict'};
      return registerManagedCodexChild({db,registration:{connectionId:input.connectionId,permitId:input.permitId,
        kind:'rawproxy',threadScope:'*',mediated:true,evidenceIds:[input.connectionId,input.permitId]},
        pid:input.pid,nowMs:Date.now()});
    }
    if(input.method==='managed/cli-lifetime'){
      const permit=db.query('SELECT * FROM codex_mutation_permits WHERE permit_id=?').get(input.permitId) as any;
      const intent=db.query('SELECT * FROM codex_mutation_intents WHERE intent_id=?').get(input.permitId) as any;
      if(input.intentId!==input.permitId||!permit||!intent||permit.state!=='consumed'||intent.state!=='forwarding'||
        permit.method!=='managed/cli-lifetime'||permit.thread_id!==threadId||intent.thread_id!==threadId||
        permit.permit_id!==input.permitId||intent.params_digest!==input.paramsDigest||
        permit.run_id!==input.connectionId||!digest(input.params?.argvDigest)||Object.keys(input.params??{}).length!==1||
        mutationDigest({argvDigest:input.params.argvDigest})!==input.paramsDigest)
        return {registered:false,reason:'cli_lifetime_registration_identity_conflict'};
      return registerManagedCodexChild({db,registration:{connectionId:input.connectionId,permitId:input.permitId,
        intentId:input.intentId,kind:'cli',threadScope:threadId,mediated:false,lifetimeIntentConsumed:true,
        evidenceIds:[permit.accepted_input_id,permit.run_id,input.permitId,input.intentId]},pid:input.pid,nowMs:Date.now()});
    }
    return {registered:false,reason:'unsupported_managed_process_kind'};
  }
  if(input.phase==='observed-exit'){
    if(!Number.isInteger(input.pid)||input.pid<1||!/^\d+$/.test(input.startTicks??'')||
      !Number.isInteger(input.exitCode)&&input.exitCode!==null||!digest(input.exitEvidenceDigest))
      return {observed:false,reason:'invalid_process_exit_observation'};
    const row=db.query(`SELECT * FROM codex_managed_process_registrations WHERE connection_id=? AND permit_id=?`).get(input.connectionId,input.permitId) as any;
    if(!row||row.pid!==input.pid||row.start_ticks!==input.startTicks||row.intent_id!==(input.intentId??null)||
      row.thread_scope!==threadId||row.process_kind!==(input.method==='managed/cli-lifetime'?'cli':'rawproxy')||
      input.method!=='managed/cli-lifetime'&&input.method!=='managed/proxy-process'||
      input.method==='managed/cli-lifetime'&&input.intentId!==input.permitId||
      input.method==='managed/proxy-process'&&input.intentId!==null)
      return {observed:false,reason:'managed_process_exit_identity_conflict'};
    if(input.responseDigest!==input.exitEvidenceDigest||
      mutationDigest({pid:input.pid,startTicks:input.startTicks,exitCode:input.exitCode,observedExit:true})!==input.exitEvidenceDigest)
      return {observed:false,reason:'managed_process_exit_digest_conflict'};
    // A child-handle callback alone is a caller claim. The owner independently checks /proc:
    // the exact process must be gone or the PID must now identify a different start time.
    try{
      const stat=readFileSync(`/proc/${input.pid}/stat`,'utf8'),close=stat.lastIndexOf(')');
      const liveStart=close<0?null:stat.slice(close+1).trim().split(/\s+/)[19];
      if(liveStart===input.startTicks)return {observed:false,reason:'managed_process_still_live'};
      if(liveStart!==null&&(!liveStart||!/^\d+$/.test(liveStart)))return {observed:false,reason:'managed_process_exit_unverified'};
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&(error as NodeJS.ErrnoException).code!=='ESRCH')
      return {observed:false,reason:'managed_process_exit_unverified'};}
    const result=observeManagedCodexChildExit({db,connectionId:input.connectionId,permitId:input.permitId,pid:input.pid,
      startTicks:input.startTicks,exitCode:input.exitCode,exitEvidenceDigest:input.exitEvidenceDigest,nowMs:Date.now()});
    if(row.process_kind==='cli'){
      if(row.intent_id!==input.permitId||row.state!=='active'&&row.state!=='observed_exit')
        return {observed:false,reason:'cli_lifetime_exit_identity_conflict'};
      reconcileCodexMutationIntent(db,{intentId:row.intent_id,outcome:'applied',evidenceDigest:input.exitEvidenceDigest,nowMs:Date.now()});
    }
    return {observed:result.observed,duplicate:result.duplicate,state:result.state};
  }
  // Stop may arrive after adoption without the dispatcher's ephemeral capability.
  // Only the common owner's exact issued native turn and canonical Stop can grant it.
  if(input.method==='turn/interrupt'&&input.phase!=='response'){
    const protectedExecution=db.query(`SELECT a.authorization_id FROM codex_recovery_dispatch_authorizations a
      WHERE a.thread_id=? AND EXISTS (SELECT 1 FROM codex_mutation_intents i WHERE i.fence_id=a.fence_id
        AND i.method='turn/start' AND i.state IN ('forwarding','response_received','ambiguous'))
      ORDER BY a.created_at_ms DESC LIMIT 1`).get(threadId) as any;
    if(input.authority||protectedExecution){
      const authorizationId=input.authority?.authorizationId??protectedExecution.authorization_id;
      if(!id(authorizationId)||input.authority&&!id(input.authority.capability))
        return {allowed:false,forward:false,reason:'invalid_recovery_interrupt_authority'};
      const interrupt={authorizationId,threadId,providerTurnId:input.params?.turnId,
        permitId:input.permitId,params:input.params,nowMs:Date.now(),
        ...(input.authority?{capability:input.authority.capability}:{})};
      if(input.phase==='prepare')return authorizeCodexRecoveryInterrupt(db,interrupt);
      return consumeCodexRecoveryInterrupt(db,{...interrupt,intentId:input.intentId});
    }
  }
  if(input.authority){
    if(!id(input.authority.authorizationId)||!id(input.authority.capability))return {allowed:false,forward:false,reason:'invalid_recovery_authority'};
    const authority={authorizationId:input.authority.authorizationId,capability:input.authority.capability,
      permitId:input.permitId,method:input.method,params:input.params,nowMs:Date.now()};
    if(input.phase==='prepare')return prepareCodexRecoveryMutation(db,{...authority,
      preparedPromptDigest:input.authority.preparedPromptDigest});
    if(input.phase==='consume')return consumeCodexRecoveryMutation(db,{...authority,intentId:input.intentId});
    return {allowed:false,forward:false,reason:'invalid_recovery_phase'};
  }
  if(input.phase==='prepare'){
    const nativeTurnId=input.method==='turn/steer'?input.params?.expectedTurnId:
      input.method==='turn/interrupt'?input.params?.turnId:undefined;
    if(nativeTurnId!==undefined&&(!id(nativeTurnId)||input.nativeTurnId!==nativeTurnId))
      return {allowed:false,forward:false,reason:'actual_native_turn_identity_conflict'};
    const grant=grantCodexMutationPermit(db,{permitId:input.permitId,threadId,
      owner:{acceptedInputId:`managed:${input.connectionId}`,runId:input.connectionId,dispatchAttempt:1},
      method:input.method,paramsDigest:input.paramsDigest,purpose:'ordinary',
      ...(nativeTurnId?{nativeTurnId}:{}),nowMs:Date.now()});
    return {allowed:grant.granted,...grant};
  }
  const permit=db.query('SELECT * FROM codex_mutation_permits WHERE permit_id=?').get(input.permitId) as any;
  if(!permit||!permit.fence_id&&permit.run_id!==input.connectionId||permit.thread_id!==threadId
    ||permit.method!==input.method||permit.params_digest!==input.paramsDigest)
    return {allowed:false,forward:false,reason:'mutation_permit_identity_conflict'};
  if(input.phase==='consume')return consumeCodexMutationPermit(db,{permitId:input.permitId,intentId:input.intentId,
    paramsDigest:input.paramsDigest,nowMs:Date.now()});
  if(!digest(input.responseDigest))return {allowed:false,reason:'invalid_mutation_response_digest'};
  if(permit.fence_id){
    const authorization=db.query('SELECT authorization_id FROM codex_recovery_dispatch_authorizations WHERE fence_id=? AND accepted_input_id=?')
      .get(permit.fence_id,permit.accepted_input_id) as any;
    if(!authorization||input.authorizationId!==authorization.authorization_id)return {allowed:false,reason:'recovery_response_identity_conflict'};
    if(permit.purpose==='owned_interrupt')return recordCodexRecoveryInterruptResponse(db,{
      authorizationId:authorization.authorization_id,intentId:input.intentId,
      kind:input.nativeError?'rpc_error':'accepted',responseDigest:input.responseDigest,nowMs:Date.now()});
    if(input.nativeError){recordCodexMutationResponse(db,{intentId:input.intentId,kind:'rpc_error',responseDigest:input.responseDigest,nowMs:Date.now()});return {recorded:true};}
    return recordCodexRecoveryMutationResponse(db,{authorizationId:authorization.authorization_id,intentId:input.intentId,
      response:input.response?.result,responseDigest:input.responseDigest,nowMs:Date.now()});
  }
  recordCodexMutationResponse(db,{intentId:input.intentId,kind:input.nativeError?'rpc_error':'accepted',
    responseDigest:input.responseDigest,providerTurnId:typeof input.providerTurnId==='string'?input.providerTurnId:undefined,nowMs:Date.now()});
  if(['turn/start','turn/steer','turn/interrupt'].includes(permit.method))
    reconcileManagedCodexMutationFromRetainedTerminal(db,{intentId:input.intentId,nowMs:Date.now()});
  // Pinned native 0.162 sends these successful replies after thread setup or
  // resumed-state materialization completes. It does not give that guarantee for
  // submitted turns, compaction, settings updates or unknown methods.
  if(!input.nativeError&&['thread/start','thread/resume'].includes(permit.method)){
    const returnedThreadId=input.response?.result?.thread?.id;
    if(id(returnedThreadId)&&(permit.method==='thread/start'||returnedThreadId===permit.thread_id))
      reconcileCodexMutationIntent(db,{intentId:input.intentId,outcome:'applied',
        evidenceDigest:input.responseDigest,nowMs:Date.now()});
  }
  if(permit.method===CODEX_DAEMON_LIFECYCLE_METHOD&&!input.nativeError){
    const outcome=runnerCodexLifecycleOutcome(input.response?.result?.status);
    if(outcome)reconcileCodexMutationIntent(db,{intentId:input.intentId,outcome,
      evidenceDigest:input.responseDigest,nowMs:Date.now()});
  }
  return {recorded:true};
}
