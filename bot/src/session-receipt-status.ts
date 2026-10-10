/** One explanation policy for the live owner and the read-only presentation worker.
 * All changing facts are supplied by the caller; this module never opens the ledger. */
export type InputStatusDetail={code:string;message:string;clearsAt:string|null;automaticRetry:boolean};
export type RetryFact={attempt:number;maxRetries:number|null;status:number|null;retryAt:number|null};
export type OutageFact={incident:{name:string}|null}|null;
export type SavedTurnFact={saved_kind:'scheduled'|'banked';dispatch_failure_class:string|null;dispatch_next_attempt_ms:number|null}|null;
export type BlockingTurnFact={status:string;dispatch_failure_class:string|null;dispatch_next_attempt_ms:number|null;dispatch_hold:string|null;continuation_refusal:string|null}|null;
export type StatusContext={
  retry:(turnId:number)=>RetryFact|null;
  outage:(turnId:number)=>OutageFact;
  requestWait:(requestId:string,inputId:string)=>{after:boolean;held:{requestId:string;outcome:string}|null};
  savedTurn:(turnId:number)=>SavedTurnFact;
  continuationRefusal:(turnId:number)=>string|null;
  session:(sessionId:number)=>{status:string;providerId:string;suspended:boolean};
  deploymentHold:(providerId:string,inputKind:string)=>boolean;
  olderBlockingTurn:(sessionId:number,turnId:number)=>BlockingTurnFact;
  dependencyPending:(turnId:number)=>boolean;
  now:()=>number;
  formatTime:(ms:number)=>string;
};
export type StatusInput={id:string;session_id:number;kind:string;request_id:string|null};
export type StatusTurn={id:number;status:string;agent_text:string|null;dispatch_failure_class:string|null;
  dispatch_next_attempt_ms:number|null;dispatch_attempt:number;dispatch_hold?:string|null};
export type StatusSteering={status:string;provider_sent_at:string|null;error:string|null};

export function providerTroubleText(status:number|null,offer:OutageFact=null):string {
  if(offer?.incident)return `Claude is having an outage: “${offer.incident.name}” (status.claude.com).`;
  if(status===529)return 'Claude’s servers are overloaded right now (status.claude.com).';
  if(status!==null&&status>=500)return `Claude’s servers are returning errors (${status}; status.claude.com).`;
  if(status===429)return 'Claude is rate-limiting requests right now.';
  return 'Claude’s API call failed.';
}

export function receiptStatusFromFacts(input:StatusInput,observed:{turn:StatusTurn|null;steering:StatusSteering|null;state:string},
  saved:any,context:StatusContext):InputStatusDetail|null {
  const {turn,steering,state}=observed;
  if(steering?.status==='ambiguous'&&!steering.provider_sent_at){
    const outcome=turn?.status==='done'?'completed':turn?.status==='error'?'failed':turn?.status==='cancelled'?'was canceled':null;
    return {code:outcome?'STEERING_DELIVERY_UNCONFIRMED':'STEERING_ACK_PENDING',
      message:outcome?`The linked provider turn ${outcome}, but this specific message was not acknowledged. We cannot confirm whether the agent received or used it; it will not be sent again automatically.`
        :turn?.status==='running'||turn?.status==='delivering'?'The owner attempted to send this message to the active provider turn, but acknowledgement is still unconfirmed. Its status will update when that turn ends.'
        :'The owner attempted to send this message, but acknowledgement and the linked turn outcome remain unconfirmed. Reconciliation is required before another send.',
      clearsAt:null,automaticRetry:false};
  }
  // His thread reply carried to the agent: the owner writes where it stands (`followForwardedReply`).
  if(saved.forwardedTo&&['waiting','queued','running'].includes(saved.state))return saved.statusDetail??null;
  if(typeof saved.movedTo==='string'&&typeof saved.continuedAs==='string')return {
    code:'CONTINUED_ON_CODEX',message:`Claude ran out of usage before this work started. It continues in ${saved.movedTo} on Codex; the original request and its return are preserved.`,
    clearsAt:null,automaticRetry:false};
  if(saved.state==='failed'||state==='failed'||state==='uncertain'||turn?.status==='parked'||turn?.status==='interrupted'){
    const raw=saved.error?.message??saved.error??steering?.error??turn?.agent_text;
    const message=typeof raw==='string'?raw.replace(/^(?:ProviderDispatchError|ChatGptDispatchError|Error):\s*/,''):null;
    const reset=message?.match(/\b(?:until|resets? at)\s+(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\b/i)?.[1]??null;
    const clearsAt=reset&&!Number.isNaN(Date.parse(reset))?new Date(reset).toISOString():null;
    if(state==='uncertain'||turn?.status==='parked'||turn?.status==='interrupted')return {code:'OUTCOME_UNCONFIRMED',message:message??'The provider outcome is unconfirmed. This input needs reconciliation before any retry.',clearsAt:null,automaticRetry:false};
    if(message&&/usage (?:is |was )?(?:cached as )?exhausted|you(?:'|’)ve hit your (?:session |usage )?limit|usage limit/i.test(message))return {code:'PROVIDER_USAGE_EXHAUSTED',message:clearsAt?`Provider usage exhausted this input. Reported reset: ${clearsAt}. This input will not be retried automatically.`:'Provider usage exhausted this input. The reset time was not retained; this input will not be retried automatically.',clearsAt,automaticRetry:false};
    const code=message&&/timed? out|timeout|deadline exceeded/i.test(message)?'TIMEOUT':message&&/process exited|process crashed|signal (?:SIG|\d)/i.test(message)?'PROVIDER_PROCESS_EXIT':message&&/reject|blocked by|forbidden|unauthorized|not permitted/i.test(message)?'PROVIDER_REJECTED':saved.error?.code??'EXECUTION_FAILED';
    return {code,message:message??'This input failed without a retained provider explanation.',clearsAt:null,automaticRetry:false};
  }
  if(state==='running'&&turn&&!steering){
    const retry=context.retry(turn.id);
    if(retry)return {code:'PROVIDER_RETRYING',message:`${providerTroubleText(retry.status,context.outage(turn.id))} It is retrying on its own${retry.maxRetries?` (attempt ${retry.attempt} of ${retry.maxRetries})`:''}. Your message is kept; nothing to do.`,
      clearsAt:retry.retryAt?new Date(retry.retryAt).toISOString():null,automaticRetry:true};
  }
  if(state!=='queued'&&state!=='waiting')return null;
  if(steering&&['queued','sending'].includes(steering.status))return null;
  if(saved.forwardedTo)return null;
  if(!turn){
    const wait=input.request_id?context.requestWait(input.request_id,input.id):{after:false,held:null};
    if(wait.held)return {code:'WAITING_FOR_REQUESTER_DECISION',message:'An earlier required request ended without a confirmed answer. This work waits for the agent that sent it to decide what to do.',clearsAt:null,automaticRetry:false};
    if(wait.after)return {code:'WAITING_FOR_DEPENDENCY',message:'This accepted request is waiting for an earlier request to settle before provider submission.',clearsAt:null,automaticRetry:true};
    return {code:'INPUT_HELD',message:'This accepted input has not been submitted to a provider.',clearsAt:null,automaticRetry:false};
  }
  const deliberate=context.savedTurn(turn.id);
  const scheduledAt=deliberate?.saved_kind==='scheduled'&&deliberate.dispatch_failure_class!=='backoff'
    ?deliberate.dispatch_next_attempt_ms:null;
  if(deliberate&&turn.status==='queued'&&deliberate.saved_kind==='scheduled'&&turn.dispatch_failure_class!=='backoff'&&!scheduledAt)return null;
  if(deliberate&&turn.status==='queued'&&(deliberate.saved_kind==='banked'||turn.dispatch_failure_class!=='backoff'))return {
    code:deliberate.saved_kind==='scheduled'?'SCHEDULED_WORK':'BANKED_WORK',
    message:deliberate.saved_kind==='scheduled'?`This work is scheduled for ${context.formatTime(scheduledAt!)}.`:'This work is waiting for a safe allowance window; no start time has been chosen.',
    clearsAt:deliberate.saved_kind==='scheduled'&&deliberate.dispatch_failure_class!=='backoff'&&deliberate.dispatch_next_attempt_ms?new Date(deliberate.dispatch_next_attempt_ms).toISOString():null,automaticRetry:true};
  if(turn.dispatch_failure_class==='backoff'&&turn.dispatch_next_attempt_ms!==null){
    const reason=typeof turn.agent_text==='string'?turn.agent_text:'';
    const status=Number(reason.match(/\bAPI Error:\s*(\d{3})\b/)?.[1])||null;
    const next=turn.dispatch_next_attempt_ms>context.now()?new Date(turn.dispatch_next_attempt_ms).toISOString():null;
    const when=next?context.formatTime(turn.dispatch_next_attempt_ms):null;
    const product=context.session(input.session_id).providerId==='codex'?'Codex':'Claude';
    if(turn.dispatch_hold==='usage'||context.continuationRefusal(turn.id)==='usage'||/\busage (?:is|for)\b/i.test(reason)&&/exhaust/i.test(reason))return {code:'PROVIDER_USAGE_HELD',message:when
      ?`No ${product} account has room until ${when}, when the first one frees up. Your message is kept and starts then by itself, or straight away if you add an account with room in Accounts.`
      :`No ${product} account has room, and none has said when it frees up. Your message is kept and starts by itself as soon as one has room, or straight away if you add an account with room in Accounts.`,clearsAt:next,automaticRetry:true};
    const again=when?`at ${when}`:'now';
    return {code:'RETRY_SCHEDULED',message:status?`${providerTroubleText(status,context.outage(turn.id))} Your message is kept and goes again ${again}; nothing is needed from you.`
      :`${product} is not answering right now. Your message is kept and goes again ${again}; nothing is needed from you.`,clearsAt:next,automaticRetry:true};
  }
  if(turn.dispatch_failure_class==='auth_wait')return {code:'PROVIDER_AUTH_HELD',message:'This account could not sign in. Your message is kept and will start automatically after this machine can use its credentials again.',clearsAt:null,automaticRetry:true};
  if(turn.dispatch_failure_class==='usage_wait')return {code:'PROVIDER_USAGE_HELD',message:'The agent stopped partway because every account ran out of usage. It picks up where it left off by itself as soon as an account has room; what it already did is kept.',clearsAt:null,automaticRetry:true};
  if(turn.dispatch_failure_class==='chosen_time')return turn.dispatch_next_attempt_ms?{code:'CHOSEN_TIME_HELD',message:`The agent picks this work up again at ${context.formatTime(turn.dispatch_next_attempt_ms)}.`,clearsAt:new Date(turn.dispatch_next_attempt_ms).toISOString(),automaticRetry:true}:null;
  const session=context.session(input.session_id);
  if(context.deploymentHold(session.providerId,input.kind))return {code:'DEPLOYMENT_HOLD',message:'Provider admission is paused for a deployment. This input remains queued.',clearsAt:null,automaticRetry:true};
  if(session.status==='archived'||session.suspended)return {code:'SESSION_PAUSED',message:'This session is paused or archived. This input remains queued.',clearsAt:null,automaticRetry:false};
  const older=context.olderBlockingTurn(input.session_id,turn.id);
  if(older?.status==='parked')return {code:'EARLIER_INPUT_PARKED',message:'An earlier input is parked and must be reconciled before this queued input can run.',clearsAt:null,automaticRetry:false};
  if(context.dependencyPending(turn.id))return {code:'WAITING_FOR_DEPENDENCY',message:'This input is waiting for an earlier required outcome.',clearsAt:null,automaticRetry:true};
  if(older?.status==='queued'&&(older.dispatch_hold==='usage'||older.dispatch_failure_class==='usage_wait'||older.continuation_refusal==='usage')){
    const reset=older.dispatch_next_attempt_ms!==null&&older.dispatch_next_attempt_ms>context.now()?older.dispatch_next_attempt_ms:null;
    const product=session.providerId==='codex'?'Codex':'Claude';
    return {code:'PROVIDER_USAGE_HELD',message:reset
      ?`No ${product} account has room until ${context.formatTime(reset)}, when the first one frees up. This message waits behind earlier work and is read after that work resumes; an account with room can resume it sooner.`
      :`No ${product} account has room. This message waits behind earlier work and is read after that work resumes when an account has room.`,
      clearsAt:reset===null?null:new Date(reset).toISOString(),automaticRetry:true};
  }
  return null;
}
