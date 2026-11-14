/** These unresolved activation predicates cannot be replaced by agent assertions.
 * Removing a connection does not drain its native handlers;
 * Cold construction and original history are now checked from source-owned
 * observations under the exact fence, rather than unconditional readiness flags.
 * The current candidate still cannot activate accepted-binding recovery.
 * The existing explicit-human-choice recovery path is independent. */
import {codexMutationFirstProtectionReadiness} from './codex-mutation-release-compatibility';
export function codexContinuationActivationReadiness(){
  return {eligible:false as const,policy:'codex-accepted-binding-activation-v1',reasons:[
    {code:'LEGACY_NATIVE_ISSUED_SEND_DRAIN_UNPROVEN',
      detail:'Legacy retirement lacks a supported daemon/connection identity, positive native admission cut or successful handler drain, and relevant input/outside-scope custody. A canonical thread/read is a handler barrier only after that positive cut; process/socket exit is insufficient.'},
    {code:codexMutationFirstProtectionReadiness().reason,
      detail:'No existing host witness excludes already-running incompatible application requests, pinned release helpers and configuration writers across the first durable release requirement and protected authority.'},
  ]};
}

export function requireCodexContinuationActivation(){
  const readiness=codexContinuationActivationReadiness();
  throw new Error(`Accepted-binding recovery activation refuses: ${readiness.reasons.map(reason=>reason.code).join(', ')}. No provider input was sent.`);
}
