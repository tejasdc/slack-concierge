/** Read the existing switch result without inventing a second receipt state vocabulary. */
export type CodexAccountSwitchState='waiting'|'completed'|'failed'|'uncertain';

export function codexAccountSwitchState(result:unknown):CodexAccountSwitchState|null {
  if(!result||typeof result!=='object')return null;
  const status=(result as {status?:unknown}).status;
  if(status==='completed'||status==='applied')return 'completed';
  if(status==='failed')return 'failed';
  if(status==='uncertain')return 'uncertain';
  if(status==='deferred')return 'waiting';
  return null;
}

/** Keep the operation ID beside the existing result fields; status and detail remain authoritative. */
export function codexAccountSwitchReply<T extends Record<string,unknown>>(operationId:string,result:T):T&{operationId:string} {
  return {...result,operationId};
}

export function codexAccountSwitchProjection(result:unknown):{state:CodexAccountSwitchState|null;resultPreview:string|null} {
  const state=codexAccountSwitchState(result);
  if(!result||typeof result!=='object')return {state,resultPreview:null};
  const value=result as {detail?:unknown;status?:unknown};
  return {state,resultPreview:typeof value.detail==='string'?value.detail:
    state??(typeof value.status==='string'?value.status:null)};
}
