/** Receipt presentation for the existing, source-attributed Codex account switch. */
export type CodexAccountSwitchOutcome='completed'|'refused'|'failed'|'uncertain';

const KNOWN_OUTCOMES=new Set<CodexAccountSwitchOutcome>(['completed','refused','failed','uncertain']);

export function codexAccountSwitchOutcome(result:unknown):CodexAccountSwitchOutcome|null {
  if(!result||typeof result!=='object')return null;
  const value=result as {outcome?:unknown;status?:unknown;detail?:unknown};
  if(typeof value.outcome==='string'&&KNOWN_OUTCOMES.has(value.outcome as CodexAccountSwitchOutcome))
    return value.outcome as CodexAccountSwitchOutcome;
  if(value.status==='completed'||value.status==='applied')return 'completed';
  if(value.status==='uncertain')return 'uncertain';
  if(value.status==='deferred')return 'refused';
  if(value.status==='failed'){
    // These exact retained messages are explicit no-effect guard/selection refusals from
    // the existing switch owner. Older receipts have no separate outcome field.
    if(typeof value.detail==='string'&&(
      value.detail==='A Codex turn is active on the owner or another Codex client, so the runner was left alone.'
      ||value.detail==='Codex activity could not be checked, so the runner was left alone.'
      ||value.detail==='That Codex account is not available on the configured runner.'
      ||value.detail==='That Codex account is not available on this machine.'
    ))return 'refused';
    return 'failed';
  }
  return null;
}

export function codexAccountSwitchReply<T extends Record<string,unknown>>(operationId:string,result:T):T&{operationId:string;outcome:CodexAccountSwitchOutcome|null} {
  return {...result,operationId,outcome:codexAccountSwitchOutcome(result)};
}

export function codexAccountSwitchProjection(result:unknown):{outcome:CodexAccountSwitchOutcome|null;resultPreview:string|null} {
  const outcome=codexAccountSwitchOutcome(result);
  if(!result||typeof result!=='object')return {outcome,resultPreview:null};
  const value=result as {detail?:unknown;status?:unknown};
  return {outcome,resultPreview:typeof value.detail==='string'?value.detail:
    outcome??(typeof value.status==='string'?value.status:null)};
}
