import type {Database} from 'bun:sqlite';
import {OPEN_QUESTION_STATES} from './topic-attention-rules';

/**
 * Who a reply inside an Inbox thread can go to, and the default: the one rule, used by the live
 * thread read and by the prepared read the app's thread page and recording bar use. It lived twice
 * until 2026-10-09: the prepared read carried its own copy taken before every agent that had worked
 * a thread became a choice, so a thread whose three agents had all finished offered only the router
 * and the one agent the router had just sent work to (Tejas, 2026-10-09: "there's no option to
 * select that … What happens when multiple sessions are there").
 *
 * Every agent sent work from the thread, finished or not, is a choice and owns the answers it sent
 * back or had posted here; open work also owns its request's messages. An agent working the thread
 * right now, or one with a question open, is a choice too. The default is the agent whose item he
 * replies to; else the one agent still at work here; else the router, which also covers "several
 * are at work", so he picks. A session on his Mac is a choice exactly as one here
 * [decision: mac-sessions-have-parity]. Whether a session can be offered at all, and its name, is
 * the caller's `resolve`, because each read keeps its own view of the session catalogue.
 */
export type ReplyTarget={sessionId:string;title:string|null;why:string;owns:string[]};
export type ReplyTargets={router:string;default:string;choices:ReplyTarget[]};
export type ReplyTargetInput=Readonly<{
 router:string;inboxSessionId:number;roots:readonly string[];
 requests:readonly Readonly<{title:string;state:string;sources:readonly Readonly<{inputId:string}>[];dispatches:readonly Readonly<{requestId:unknown;targetSessionId?:string|null}>[]}>[];
 questions:readonly Readonly<{id:string;state:string;ownerSessionId?:string|null;decision?:string|null;sources:readonly string[]}>[];
 /** Work the router has in flight from one of this thread's messages. */
 workDispatches:readonly Readonly<{root:string|null;sessionId:string|null}>[];
 /** The message he is replying under, and the agent that wrote it when the caller knows. */
 about?:string|null;spokenBy?:string|null;
 resolve:(sessionId:string)=>Readonly<{title:string|null}>|null;
}>;

export function topicReplyTargets(source:Database,input:ReplyTargetInput):ReplyTargets {
 const {router,roots,about}=input;
 const choices=new Map<string,ReplyTarget>();
 const add=(named:string|null|undefined,why:string,owns:readonly string[]):string|null=>{
  if(!named||named===router)return null;
  // Older records spelt a peer session `mac:concierge:84`; the catalogue and the app say `mac:84`.
  const sessionId=named.replace(/^([\w-]+):concierge:([1-9]\d*)$/,'$1:$2');
  const existing=choices.get(sessionId);
  if(existing){existing.owns.push(...owns.filter(item=>!existing.owns.includes(item)));return sessionId;}
  const session=input.resolve(sessionId);if(!session)return null;
  choices.set(sessionId,{sessionId,title:session.title,why,owns:[...new Set(owns)]});
  return sessionId;
 };
 // A request the owner has settled, or marked stalled, is not work in progress.
 const stillOpen=(requestId:string)=>!!source.query('SELECT 1 FROM session_communication_requests WHERE request_id=? AND outcome IS NULL AND stalled_at_ms IS NULL').get(requestId)
  ||!!source.query('SELECT 1 FROM session_peer_requests WHERE request_id=? AND outcome IS NULL AND stalled_at_ms IS NULL').get(requestId);
 // What an agent sent back into this thread: each answer it returned is a message he replies under.
 const returnsOf=(requestId:string)=>[
  ...(source.query('SELECT accepted_input_id FROM session_communication_events WHERE request_id=? AND accepted_input_id IS NOT NULL').all(requestId) as {accepted_input_id:string}[]),
  ...(source.query('SELECT accepted_input_id FROM session_peer_events WHERE request_id=? AND accepted_input_id IS NOT NULL').all(requestId) as {accepted_input_id:string}[]),
 ].map(row=>row.accepted_input_id);
 // Who is still at work here, which alone decides the default when nothing he replied to names one.
 const working=new Set<string>();
 const busy=(sessionId:string|null)=>{if(sessionId)working.add(sessionId);};
 for(const request of input.requests)for(const dispatch of request.dispatches){
  const requestId=String(dispatch.requestId);
  // Only open work owns the request's own messages: the router's request bookkeeping can lag by
  // weeks (five idle sessions were still listed on "Action Button recording" on 2026-10-07), so a
  // settled dispatch never catches a reply to something else. It stays a choice he can pick.
  if(request.state==='open'&&stillOpen(requestId))busy(add(dispatch.targetSessionId,`working on “${request.title}”`,[...request.sources.map(item=>item.inputId),...returnsOf(requestId)]));
  else add(dispatch.targetSessionId,`worked on “${request.title}”`,returnsOf(requestId));
 }
 // Answers the owner posted straight into this thread name the agent that wrote them.
 if(roots.length)for(const row of source.query(`SELECT event_id,json_extract(payload_json,'$.postedBySession') AS from_session FROM session_owner_events
  WHERE session_id=? AND kind='post' AND input_id IN (${roots.map(()=>'?').join(',')}) AND json_extract(payload_json,'$.postedBy')='owner-forward'`).all(input.inboxSessionId,...roots) as {event_id:string;from_session:string|null}[])
  add(row.from_session,'answered here',[row.event_id]);
 for(const dispatch of input.workDispatches)if(dispatch.root&&roots.includes(dispatch.root))busy(add(dispatch.sessionId,'working on this thread now',[dispatch.root]));
 for(const question of input.questions)if(OPEN_QUESTION_STATES.some(state=>state===question.state)||question.state==='deferred')
  busy(add(question.ownerSessionId,question.decision?`asked you: ${question.decision}`:'asked you a question here',[question.id,...question.sources]));
 if(about&&input.spokenBy)add(input.spokenBy,'answered here',[about]);
 const list=[...choices.values()];
 const owning=about?list.find(choice=>choice.owns.includes(about)):undefined;
 const atWork=list.filter(choice=>working.has(choice.sessionId));
 return {router,default:owning?.sessionId??(atWork.length===1?atWork[0]!.sessionId:router),choices:list};
}
