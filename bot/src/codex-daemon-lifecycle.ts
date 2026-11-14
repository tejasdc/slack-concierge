import type {Database} from 'bun:sqlite';
import {CODEX_DAEMON_LIFECYCLE_METHOD,grantCodexMutationPermit,consumeCodexMutationPermit} from './codex-mutation-fence';

export const RUNNER_CODEX_LIFECYCLE_METHODS=new Set(['accounts.codex.activate','accounts.codex.repairUnmanaged']);
/** Only explicit terminal results from the supported runner handlers settle an
 * issued lifecycle call. Transport errors and unknown/uncertain results do not. */
export function runnerCodexLifecycleOutcome(status:unknown):'applied'|'not_applied'|null{
  if(['applied','failed','repaired','managed_or_absent'].includes(status as string))return 'applied';
  if(['busy','unsupported','refused'].includes(status as string))return 'not_applied';
  return null;
}
export {CODEX_DAEMON_LIFECYCLE_METHOD} from './codex-mutation-fence';

/** A private source-owned lifecycle operation, not an accepted human message.
 * Keep operationId stable through retries, restart and reconciliation. */
export function beginCodexDaemonLifecycle(db:Database,input:{operationId:string;paramsDigest:string;nowMs:number}){
  if(!input.operationId||input.operationId.length>256||!/^[a-f0-9]{64}$/.test(input.paramsDigest))
    throw new Error('Daemon lifecycle needs a stable source operation ID and exact parameter digest.');
  const permitId=`daemon-lifecycle:${input.operationId}`,intentId=permitId;
  return db.transaction(()=>{
    const prior=db.query('SELECT * FROM codex_mutation_intents WHERE intent_id=?').get(intentId) as any;
    if(prior){
      if(prior.permit_id!==permitId||prior.params_digest!==input.paramsDigest||prior.method!==CODEX_DAEMON_LIFECYCLE_METHOD
        ||prior.thread_id!=='*'||prior.accepted_input_id!==`managed-daemon-lifecycle:${input.operationId}`
        ||prior.run_id!==input.operationId||prior.dispatch_attempt!==1)
        throw new Error('Daemon lifecycle operation ID conflicts with retained issued work.');
      return {forward:false as const,permitId,intentId,reason:'already_issued' as const,duplicate:true as const,state:prior.state};
    }
    const grant=grantCodexMutationPermit(db,{permitId,threadId:'*',
      owner:{acceptedInputId:`managed-daemon-lifecycle:${input.operationId}`,runId:input.operationId,dispatchAttempt:1},
      method:CODEX_DAEMON_LIFECYCLE_METHOD,paramsDigest:input.paramsDigest,purpose:'ordinary',nowMs:input.nowMs});
    if(!grant.granted)return {forward:false as const,permitId,intentId,reason:'reason' in grant?grant.reason:'permit_not_granted',duplicate:false as const};
    const consumed=consumeCodexMutationPermit(db,{permitId,intentId,paramsDigest:input.paramsDigest,nowMs:input.nowMs});
    if(!consumed.forward)return {forward:false as const,permitId,intentId,reason:'reason' in consumed?consumed.reason:'already_issued',duplicate:false as const};
    return {forward:true as const,permitId,intentId,duplicate:false as const};
  }).immediate();
}

// The private caller uses existing recordCodexMutationResponse and
// reconcileCodexMutationIntent only after actual source completion/health proof.
// Timeout or disconnect leaves the issued intent outstanding; there is no lease.
