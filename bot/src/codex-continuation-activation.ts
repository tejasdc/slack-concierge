/** These are missing supported capabilities, rather than observations an agent
 * can attest away. Removing a connection does not drain its native handlers;
 * an on-disk hook registration does not establish the cold runtime config.
 * The current candidate therefore cannot activate accepted-binding recovery.
 * The existing explicit-human-choice recovery path is independent. */
export function codexContinuationActivationReadiness(){
  return {eligible:false as const,policy:'codex-accepted-binding-activation-v1',reasons:[
    {code:'LEGACY_NATIVE_ISSUED_SEND_DRAIN_UNPROVEN',
      detail:'No supported witness currently proves that previously issued unmediated native mutations have finished.'},
    {code:'COLD_RESUME_HOOK_CONFIGURATION_UNPROVEN',
      detail:'No supported current configuration witness currently proves the managed hook reconstructed for this exact native conversation.'},
  ]};
}

export function requireCodexContinuationActivation(){
  const readiness=codexContinuationActivationReadiness();
  throw new Error(`Accepted-binding recovery activation refuses: ${readiness.reasons.map(reason=>reason.code).join(', ')}. No provider input was sent.`);
}
