import {OPEN_QUESTION_STATES,questionReadiness,missingFor,awaitingHim,toReadByHim} from './topic-attention-rules';

/**
 * A question's heading is the line he scans; everything after it is detail. An agent's needs_you
 * question is stored as one text: its --summary line, a blank line, its whole body, then his words.
 * Filed as the brief's decision unchanged, the page drew all of it as one bold heading that ran
 * several phone screens (report 2026-11-16, the two-browsers approval). The stored words stay
 * whole; the display takes the first paragraph as the heading (its first sentence when that
 * paragraph runs past HEADING_LIMIT) and puts the rest ahead of why it came up, so every reader of
 * questions (the full view, the prepared thread lists, agents) gets the same split.
 */
const HEADING_LIMIT=200;
export function questionHeading(text:string):Readonly<{heading:string;detail:string}> {
  const whole=text.trim();
  const breakAt=whole.search(/\n\s*\n/);
  let end=breakAt<0?whole.length:breakAt;
  if(end>HEADING_LIMIT){
    const sentence=/^[\s\S]*?[.?!](?=\s|$)/.exec(whole.slice(0,end));
    if(sentence&&sentence[0].length<end)end=sentence[0].length;
  }
  return {heading:whole.slice(0,end).replace(/\s+/g,' ').trim(),detail:whole.slice(end).trim()};
}
function displayedBrief(brief:any):any {
  if(!brief||typeof brief.decision!=='string')return brief;
  const {heading,detail}=questionHeading(brief.decision);
  if(!detail)return brief;
  const why=brief.why;
  const whyText=typeof why==='string'?why:String(why?.text??'');
  const text=whyText.trim()&&!detail.includes(whyText.trim())?`${detail}\n\n${whyText.trim()}`:detail;
  return {...brief,decision:heading,why:typeof why==='string'||!why?{text,sources:[]}:{...why,text}};
}

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
    kind:question.kind,origin:question.origin,generation:question.generation,pendingReply:pending,brief:displayedBrief(question.brief),deferUntil:question.deferUntil,
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
