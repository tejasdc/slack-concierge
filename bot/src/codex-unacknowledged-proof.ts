export interface CodexAttemptIdentity {dispatchAttempt:number;providerTurnId:string}

/** Exact native evidence for every owner-recorded attempt of one input. Other turns in the
 * same conversation belong to their own accepted inputs and do not weaken this mapping. */
export function proveCodexInputNeverAcknowledged(input:{thread:any;threadId:string;attempts:CodexAttemptIdentity[]}):
  {attempts:Array<{dispatchAttempt:number;providerTurnId:string;status:string;itemCount:number}>;unmappedEmptyTurns:number}|null {
  const thread=input.thread?.thread;
  if(thread?.id!==input.threadId||!Array.isArray(thread.turns)||!input.attempts.length)return null;
  if(new Set(input.attempts.map(attempt=>attempt.dispatchAttempt)).size!==input.attempts.length
    ||new Set(input.attempts.map(attempt=>attempt.providerTurnId)).size!==input.attempts.length)return null;
  const nativeTurns=thread.turns;
  const byId=new Map<string,any>();
  for(const turn of nativeTurns){
    if(typeof turn?.id!=='string'||byId.has(turn.id)||!Array.isArray(turn.items))return null;
    byId.set(turn.id,turn);
  }
  const mapped=new Set<string>();
  const proof=[];
  for(const attempt of input.attempts){
    const turn=byId.get(attempt.providerTurnId);
    if(!turn||turn.status!=='completed'||turn.error!=null||turn.items.length!==0)return null;
    mapped.add(attempt.providerTurnId);
    proof.push({dispatchAttempt:attempt.dispatchAttempt,providerTurnId:attempt.providerTurnId,status:turn.status,itemCount:turn.items.length});
  }
  return {attempts:proof,unmappedEmptyTurns:0};
}
