/** These unresolved activation predicates cannot be replaced by agent assertions.
 * Removing a connection does not drain its native handlers;
 * an on-disk hook registration does not establish the cold runtime config.
 * The current candidate therefore cannot activate accepted-binding recovery.
 * The existing explicit-human-choice recovery path is independent. */
export function codexContinuationActivationReadiness(){
  return {eligible:false as const,policy:'codex-accepted-binding-activation-v1',reasons:[
    {code:'LEGACY_NATIVE_ISSUED_SEND_DRAIN_UNPROVEN',
      detail:'Legacy retirement lacks a supported daemon/connection identity, positive native admission cut or successful handler drain, and relevant input/outside-scope custody. A canonical thread/read is a handler barrier only after that positive cut; process/socket exit is insufficient.'},
    {code:'COLD_RESUME_HOOK_CONFIGURATION_UNPROVEN',
      detail:'The exact cold resume has no established binding to its effective enabled hook feature and required managed handler/configuration. Separate cwd reads or an on-disk registration do not prove those construction inputs.'},
    {code:'NATIVE_ORIGINAL_EFFECT_HISTORY_COVERAGE_UNPROVEN',
      detail:'Complete native item pagination does not prove lossless original acknowledgement/effect coverage across projection, migration or rollback.'},
  ]};
}

export function requireCodexContinuationActivation(){
  const readiness=codexContinuationActivationReadiness();
  throw new Error(`Accepted-binding recovery activation refuses: ${readiness.reasons.map(reason=>reason.code).join(', ')}. No provider input was sent.`);
}
