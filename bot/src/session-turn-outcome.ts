import {db,executionChanged,getSessionById} from './state';
import {getAcceptedSessionInput,sessionMetadata,updateSessionMetadata,nativeRunId} from './session-inputs';
import {inboxThreadRoot} from './session-inbox';
import {questionsDeclaredByRun,readsForTurn,type ReadingText} from './session-topics';
import {log} from './log';
import type {TurnOutcomeMark} from './turn-outcome-marker';

/**
 * Every turn says whether it needs Tejas through an outcome action. Older turns may
 * end their answer with an exact marker line (`turn-outcome-marker.ts`), and a final
 * hand-off reply's work disposition counts too. `needs_you` blocks work on his answer;
 * `response` is an answer he should read
 * (not every reply — the agent marks the ones that matter). Both raise attention. Needs attention comes only from these declarations, never from
 * reading the agent's text. See thinkering docs/plans/2026-09-18-turn-outcome.md.
 *
 * `finished_without_saying` is recorded by the owner, never declared: the turn ended
 * without an outcome action or marker. It is quiet — it neither raises nor clears
 * attention — so a missed declaration points at the provider path, not at him.
 */
export type DeclaredTurnOutcome='done'|'response'|'needs_you'|'failed';
export type TurnOutcome=DeclaredTurnOutcome|'finished_without_saying';
export type TurnOutcomeView={outcome:TurnOutcome;question:string|null;inputId:string;at:string};
/** One open question to Tejas. Its generation is compared with his dismiss, exactly like unread. */
export type OpenNeed={inputId:string;outcome?:'needs_you'|'response';question:string;generation:number;at:string;runId:string;eventId:string;
  /** A reading item's actual content: the messages its turn wrote into the thread, in full (`readsFor`). */
  reads?:ReadingText[]};

/**
 * The input a declaration belongs to. In the Inbox that is the request thread, never the
 * whole Inbox: a turn started by a reply inside a thread answers that thread's root.
 */
export function outcomeInputFor(sessionId:number,inputId:string):string {
  const session=getSessionById(sessionId);
  if(!session||!sessionMetadata(session).inbox)return inputId;
  const input=getAcceptedSessionInput(inputId);
  const replyTo=input?JSON.parse(input.payload_json).replyToMessage:null;
  return (typeof replyTo?.messageId==='string'&&inboxThreadRoot(sessionId,replyTo.messageId))||inboxThreadRoot(sessionId,inputId)||inputId;
}

export function turnDeclared(turnId:number):boolean {
  return !!db.query("SELECT 1 FROM session_owner_events WHERE turn_id=? AND kind='turn_outcome' LIMIT 1").get(turnId);
}

export function turnDeclaredByAction(turnId:number):boolean {
  return !!db.query("SELECT 1 FROM session_owner_events WHERE turn_id=? AND kind='turn_outcome' AND substr(event_id,1,20)='turn_outcome:action:' LIMIT 1").get(turnId);
}

/**
 * Records one turn's outcome. `eventId` is the idempotency identity; a retried declaration
 * with the same identity changes nothing. Must run inside the caller's transaction when
 * the caller retains an operation for it.
 */
export function recordTurnOutcome(input:{eventId:string;sessionId:number;turnId:number;inputId:string;outcome:TurnOutcome;text:string|null;
  /** An explicit declaration is refused when a `response` has nothing to read; a turn that has already ended is recorded `done` instead, with a log line. */
  refuseUnreadable?:boolean}) {
  if(db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(input.eventId))return false;
  const session=getSessionById(input.sessionId);
  if(!session)throw new Error('Unknown session.');
  const meta=sessionMetadata(session),at=new Date().toISOString();
  const inputId=outcomeInputFor(input.sessionId,input.inputId);
  // In the Inbox a `response` is a promise that there is something to read in this thread: the
  // turn's post there, or its closing text. A response with nothing behind it became an item
  // that showed him a heading and a link to his own message (Tejas, 2026-09-24: "I literally
  // cannot read this"), so it is refused when declared, and a finished turn's is recorded done.
  let outcome=input.outcome;
  if(outcome==='response'&&meta.inbox&&!readsForTurn(input.sessionId,input.turnId,new Set([inputId])).length) {
    if(input.refuseUnreadable)throw new Error('response needs something to read: post the answer into this thread first (sessions post), then declare it.');
    log('warn','turn_response_without_reads',{session_id:input.sessionId,turn_id:input.turnId,input_id:inputId,event_id:input.eventId});
    outcome='done';
  }
  // Both ask him to look: needs_you blocks work on his answer; response is an answer he
  // should read. For a response, `question` holds what the agent wants him to look at.
  const asks=outcome==='needs_you'||outcome==='response';
  const question=asks?input.text?.trim().slice(0,2000)||null:null;
  if(asks&&!question)throw new Error(`${outcome} requires what Tejas should answer or read.`);
  const generation=asks?(meta.generation??0)+1:meta.generation??0;
  const runId=nativeRunId(input.turnId);
  const needs=(meta.needs??[]).filter(need=>{
    if(input.outcome==='finished_without_saying')return true;
    // A later declaration settles what this turn answered. Outside the Inbox the session
    // is one conversation, so any declared turn settles its earlier questions.
    return meta.inbox?need.inputId!==inputId:false;
  });
  // In the Inbox a question the run declared in its topic is the record; the marker adds no
  // second, unfiled copy. An entry the run did not declare stays unfiled, in no thread, until
  // the router files it (docs/plans/2026-09-23-attention-that-ends.md).
  const declared=!!question&&!!meta.inbox&&!!runId&&questionsDeclaredByRun(input.sessionId,runId);
  if(question&&!declared)needs.push({inputId,outcome:outcome as 'needs_you'|'response',question,generation,at,runId,eventId:input.eventId});
  const payload={outcome:outcome,question,summary:asks?null:input.text?.trim()||null,inputId,runId,generation};
  db.query('INSERT INTO session_owner_events(event_id,session_id,input_id,turn_id,kind,payload_json) VALUES(?,?,?,?,?,?)')
    .run(input.eventId,input.sessionId,inputId,input.turnId,'turn_outcome',JSON.stringify(payload));
  if(question) {
    // The attention event is what a client lists: the question and the input (in the
    // Inbox, the thread) it opens.
    db.query('INSERT INTO session_owner_events(event_id,session_id,input_id,turn_id,kind,payload_json) VALUES(?,?,?,?,?,?)')
      .run(`needs_you:${input.eventId}`,input.sessionId,inputId,input.turnId,'needs_you',JSON.stringify({outcome:outcome,question,inputId,generation}));
  }
  updateSessionMetadata(session.id,{...(question?{generation}:{}),needs,turnOutcome:{outcome:outcome,question,inputId,at}});
  executionChanged();
  return true;
}

/**
 * The input a turn's final answer answers: the latest steering message the provider
 * acknowledged, else the input that opened the turn — the same attribution its output uses.
 */
function answeredInput(turnId:number,openingInputId:string):string {
  const steered=db.query(`SELECT accepted_input_id FROM turn_steering_messages
    WHERE turn_id=? AND status='sent' AND accepted_input_id IS NOT NULL ORDER BY id DESC LIMIT 1`).get(turnId) as {accepted_input_id:string}|null;
  return steered?.accepted_input_id??openingInputId;
}

/**
 * A delivered result declares its turn's outcome through the marker its answer ended
 * with only when no outcome action already declared it. ChatGPT is not given the marker,
 * so its answer is done. A consultation is information only and declares nothing.
 * A legacy marker supersedes a reply disposition in the same turn. A needs_you marker
 * without a question on its line keeps the answer itself as the question.
 */
export function recordResultTurnOutcome(result:{turnId:number;sessionId:number;inputId:string;text:string;turnOutcome?:TurnOutcomeMark}) {
  if(turnDeclaredByAction(result.turnId))return;
  const session=getSessionById(result.sessionId);
  if(!session||sessionMetadata(session).interactionPolicy==='consultation-only')return;
  const declared:{outcome:DeclaredTurnOutcome;question?:string;message:string}|undefined=session.provider_id==='chatgpt'?{outcome:'done',message:result.text}:result.turnOutcome;
  if(!declared)return;
  // Recording the outcome must never fail delivery of the answer it came with.
  const text=(declared.question??declared.message).trim().slice(0,2000)||(['needs_you','response'].includes(declared.outcome)?'See the latest answer.':'');
  recordTurnOutcome({eventId:`turn_outcome:result:${result.turnId}`,sessionId:session.id,turnId:result.turnId,
    inputId:answeredInput(result.turnId,result.inputId),outcome:declared.outcome,text:text||null});
}

/**
 * A native turn that ended without declaring — no action or marker, a crash, or a stop — is
 * recorded as such. Never
 * inferred from text, and quiet: it neither raises nor clears attention.
 */
export function recordUnsaidTurnOutcome(turn:{id:number;session_id:number;accepted_input_id:string|null}) {
  if(!turn.accepted_input_id||turnDeclared(turn.id))return;
  const session=getSessionById(turn.session_id),input=getAcceptedSessionInput(turn.accepted_input_id);
  if(!session||!input||input.kind==='fork'||sessionMetadata(session).interactionPolicy==='consultation-only')return;
  recordTurnOutcome({eventId:`turn_outcome:unsaid:${turn.id}`,sessionId:session.id,turnId:turn.id,
    inputId:answeredInput(turn.id,turn.accepted_input_id),outcome:'finished_without_saying',text:null});
}

/** Tejas answered. Outside the Inbox any message of his answers the session; in the Inbox only the thread it replies in. */
export function clearNeedsForHumanInput(sessionId:number,payload:{replyToMessage?:{messageId?:unknown}}) {
  const session=getSessionById(sessionId);
  if(!session)return;
  const meta=sessionMetadata(session);
  if(!meta.needs?.length)return;
  const thread=meta.inbox?(typeof payload.replyToMessage?.messageId==='string'?inboxThreadRoot(sessionId,payload.replyToMessage.messageId):null):undefined;
  if(thread===null)return;
  const needs=thread===undefined?[]:meta.needs.filter(need=>need.inputId!==thread);
  if(needs.length!==meta.needs.length)updateSessionMetadata(sessionId,{needs});
}

/** The questions still waiting on Tejas, oldest first. Empty when nothing is open. */
export function openNeeds(meta:{needs?:OpenNeed[]}):OpenNeed[] {
  return [...(meta.needs??[])].sort((first,second)=>first.generation-second.generation);
}

export function needsAttention(meta:{needs?:OpenNeed[];dismissedGeneration?:number}):boolean {
  return (meta.needs??[]).some(need=>need.generation>(meta.dismissedGeneration??0));
}
