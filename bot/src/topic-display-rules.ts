import {OPEN_QUESTION_STATES,questionReadiness,missingFor,awaitingHim,toReadByHim} from './topic-attention-rules';

/** Shared complete question display; storage readers supply facts, never their own attention rule. */
export function questionDisplay(question:any,replies:any[],reading:any[],reads:any[]){
  const exposed=reading.filter(row=>row.kind==='exposed'&&row.revision===question.revision).at(-1);
  const acknowledged=reading.filter(row=>row.kind==='acknowledged').at(-1);
  // He answered and the router has not reconciled it yet. Retained input times are
  // second-granularity, so a reply in the same second as the question's last change counts
  // as older: a question that stays in Needs you is recoverable, one silently hidden is not.
  // Only a reply that names this question (a reviewed question, or a reply to the message that
  // raised it) is his answer to it; an unrelated later message in the thread changes nothing.
  const reply=OPEN_QUESTION_STATES.includes(question.state)?replies.find(candidate=>candidate.at>question.updatedAt
    &&(candidate.reviews.includes(question.questionId)||(!!candidate.replyTo&&question.sources.includes(candidate.replyTo)))):undefined;
  const pending=reply?{inputId:reply.inputId,at:reply.at}:null;
  const view={id:question.questionId,topicId:question.topicId,revision:question.revision,state:question.state,blocking:question.blocking,
    optional:question.optional,context:question.context,readiness:questionReadiness(question),missing:missingFor(question),
    kind:question.kind,origin:question.origin,generation:question.generation,pendingReply:pending,brief:question.brief,deferUntil:question.deferUntil,
    // What a reading item is for him to read, in full, from the thread's own messages.
    reads};
  return {...view,
    // The owner's own answer to "is this his to act on", so no surface recomputes it.
    waiting:awaitingHim(view)||toReadByHim(view),
    owner:question.owner,sources:question.sources,
    replaces:question.replaces,replacedBy:question.replacedBy,answer:question.answer,
    exposed:exposed?{revision:exposed.revision,at:exposed.at}:null,
    acknowledged:acknowledged?{at:acknowledged.at,by:acknowledged.by_json?JSON.parse(acknowledged.by_json):null}:null,
    pendingReply:pending,recovered:question.recovered,createdAt:question.createdAt,updatedAt:question.updatedAt};
}
