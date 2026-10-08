import {questionDisplay} from './topic-display-rules';
import type {Database} from 'bun:sqlite';
import {inboxRootResolver} from './presentation-message-source';
import {preparedInboxDisplay} from './presentation-inbox-display';
import {awaitingHim,missingFor,preparingForHim,questionReadiness,toReadByHim,OPEN_QUESTION_STATES} from './topic-attention-rules';

const iso=(value:string|null|undefined)=>!value?null:value.includes('T')?value:value.replace(' ','T')+'Z';
const parse=(value:string|null|undefined,fallback:any=null)=>{try{return value?JSON.parse(value):fallback;}catch{return fallback;}};
const open=(state:string)=>OPEN_QUESTION_STATES.some(item=>item===state);
const relaySince='2026-09-23T05:30:00.000Z';
export type TopicContext={source:Database;prepared:Database;generation:number;sessionId:number;requestedSessionId?:number;boundedReads?:boolean;
  root:ReturnType<typeof inboxRootResolver>;humanReplies:Map<string,{inputId:string;at:string;reviews:string[];replyTo:string|null}[]>;
  queued:{inputId:string;root:string|null;position:number}[];
  dispatches:{root:string|null;sessionId:string|null;title:string;requestId:string}[];
  focus:any;focusTitle:string|null};

function sessionTitle(source:Database,id:number):string|null{
 const row=source.query('SELECT native_metadata_json FROM sessions WHERE id=?').get(id) as {native_metadata_json:string}|null;
 return parse(row?.native_metadata_json,{})?.title??null;
}
function peerAddress(peer:string,id:string){return `${peer}:${String(id).replace(/^concierge:/,'')}`;}
/** All shared read indexes are assembled once for a bounded change batch, in the worker. */
export function topicContext(source:Database,prepared:Database,generation:number,sessionId:number):TopicContext{
 const resolve=inboxRootResolver(source);
 const root:ReturnType<typeof inboxRootResolver>=(session,id,seen)=>resolve(session,id,seen)??
  (prepared.query('SELECT root_input_id AS root FROM presentation_messages WHERE generation=? AND message_id=? ORDER BY event_sequence LIMIT 1')
   .get(generation,id) as {root:string|null}|null)?.root??null;
 const humanReplies=new Map<string,{inputId:string;at:string;reviews:string[];replyTo:string|null}[]>();
 const replyRows=source.query(`SELECT id,created_at,json_extract(payload_json,'$.review.questions') AS review,
   json_extract(payload_json,'$.replyToMessage.messageId') AS reply_to FROM session_inputs
   WHERE session_id=? AND origin='human' AND kind IN ('input','create','inbox-capture')
   AND id NOT IN (SELECT input_id FROM session_input_author_corrections) ORDER BY rowid DESC LIMIT 2000`).all(sessionId) as any[];
 for(const row of replyRows){const where=root(sessionId,row.id);if(!where)continue;
  const reviews=parse(row.review,[]);
  const item={inputId:row.id,at:iso(row.created_at)!,reviews:Array.isArray(reviews)?reviews.map((x:any)=>String(x?.id??'')).filter(Boolean):[],
   replyTo:typeof row.reply_to==='string'?row.reply_to:null};
  humanReplies.set(where,[...(humanReplies.get(where)??[]),item]);
 }
 const focusRow=source.query('SELECT * FROM inbox_focus WHERE session_id=?').get(sessionId) as any;
 const focused=focusRow?.topic_id&&(!focusRow.run_id||source.query("SELECT 1 FROM turns WHERE session_id=? AND native_run_id=? AND status IN ('running','delivering')")
  .get(sessionId,focusRow.run_id))?{topicId:focusRow.topic_id,inputIds:parse(focusRow.input_ids_json,[]),runId:focusRow.run_id,
   summary:focusRow.summary,since:focusRow.since}:null;
 const focusTitle=focused?(source.query('SELECT title FROM inbox_topics WHERE topic_id=?').get(focused.topicId) as {title:string}|null)?.title??null:null;
 const queued=(source.query(`SELECT id FROM session_inputs WHERE session_id=? AND turn_id IS NULL AND steering_id IS NULL
   AND json_extract(COALESCE(receipt_json,'{}'),'$.state') IS NULL AND kind IN ('input','create','inbox-capture') ORDER BY rowid`)
   .all(sessionId) as {id:string}[]).map((row,index)=>({inputId:row.id,root:root(sessionId,row.id),position:index+1}));
 const dispatches:TopicContext['dispatches']=[];
 for(const row of source.query(`SELECT request_id,COALESCE(thread_root_input_id,source_input_id) AS input_id,target_session_id
    FROM session_communication_requests WHERE source_session_id=? AND outcome IS NULL AND source_input_id IS NOT NULL`).all(sessionId) as any[]){
  if(!source.query("SELECT 1 FROM turns WHERE session_id=? AND status IN ('running','delivering','queued')").get(row.target_session_id))continue;
  dispatches.push({root:root(sessionId,row.input_id),sessionId:`concierge:${row.target_session_id}`,
   title:sessionTitle(source,row.target_session_id)||'Agent session',requestId:row.request_id});
 }
 for(const row of source.query(`SELECT request_id,COALESCE(thread_root_input_id,source_input_id) AS input_id,peer,remote_session_id
   FROM session_peer_requests WHERE source_session_id=? AND outcome IS NULL`).all(sessionId) as any[]){
  const peer=source.query('SELECT view_json FROM session_peer_catalogue WHERE peer=? AND remote_session_id=?').get(row.peer,row.remote_session_id) as {view_json:string}|null;
  dispatches.push({root:row.input_id?root(sessionId,row.input_id):null,sessionId:peerAddress(row.peer,row.remote_session_id),
   title:parse(peer?.view_json,{})?.title||`${row.peer} session`,requestId:row.request_id});
 }
 return {source,prepared,generation,sessionId,root,humanReplies,queued,dispatches,focus:focused,focusTitle};
}

function messageById(context:TopicContext,id:string):{content:string;at:string;root:string|null;detailRef?:unknown;contentCoverage?:unknown}|null{
 const {source,sessionId,root}=context;
 if(context.boundedReads){
  const row=context.prepared.query(`SELECT m.root_input_id,d.display_json FROM presentation_messages m
   JOIN presentation_message_display d ON d.generation=m.generation AND d.event_sequence=m.event_sequence
   WHERE m.generation=? AND m.message_id=? ORDER BY m.event_sequence LIMIT 1`).get(context.generation,id) as {root_input_id:string;display_json:string}|null;
  if(!row)return null;
  const value=JSON.parse(row.display_json);
  return {content:value.content,at:value.createdAt,root:row.root_input_id,...(value.detailRef?{detailRef:value.detailRef,contentCoverage:value.contentCoverage}:{})};
 }
 const row=(source.query(`SELECT e.kind,e.event_id,e.input_id,e.created_at,e.payload_json,t.agent_text,i.payload_json AS input_json
  FROM session_owner_events e LEFT JOIN turns t ON t.id=e.turn_id LEFT JOIN session_inputs i ON i.id=e.input_id
  WHERE e.session_id=? AND e.event_id=? AND e.kind IN ('post','result') ORDER BY e.sequence LIMIT 1`).get(sessionId,id)
  ??source.query(`SELECT e.kind,e.event_id,e.input_id,e.created_at,e.payload_json,t.agent_text,i.payload_json AS input_json
  FROM session_owner_events e LEFT JOIN turns t ON t.id=e.turn_id LEFT JOIN session_inputs i ON i.id=e.input_id
  WHERE e.session_id=? AND e.input_id=? AND e.kind NOT IN ('post','result') ORDER BY e.sequence LIMIT 1`).get(sessionId,id)) as any;
 if(!row)return null;
 const sequence=source.query('SELECT sequence FROM session_owner_events WHERE event_id=?').get(row.event_id) as {sequence:number};
 const display=preparedInboxDisplay(source,sessionId,sequence.sequence,id);
 if(!display)return null;
 const message=display.detailJson?JSON.parse(display.detailJson):display.preview;
 return {content:message.content,at:message.createdAt,root:root(sessionId,id)};
}
const readingValue=(id:string,message:NonNullable<ReturnType<typeof messageById>>)=>({messageId:id,text:message.content,at:message.at,
 ...(message.detailRef?{detailRef:message.detailRef,contentCoverage:message.contentCoverage}:{})});

function readsFor(context:TopicContext,question:any,roots:Set<string>){
 if(question.kind!=='reading')return [];
 const {source,sessionId,root}=context;
 for(const id of question.sources??[])roots.add(root(sessionId,id)??id);
 const named=Array.isArray(question.brief?.reads)?question.brief.reads.filter((id:unknown)=>typeof id==='string'&&!!id.trim()):[];
 if(named.length)return named.flatMap((id:string)=>{const message=messageById(context,id);
  return message&&(message.content.trim()||message.detailRef)&&message.root&&roots.has(message.root)?[readingValue(id,message)]:[];});
 const turn=question.legacyNeedEventId?(source.query('SELECT turn_id FROM session_owner_events WHERE event_id=?').get(question.legacyNeedEventId) as {turn_id:number|null}|null)?.turn_id:null;
 const turnId=turn??(question.owner?.runId?(source.query('SELECT id FROM turns WHERE native_run_id=?').get(question.owner.runId) as {id:number}|null)?.id:null);
 if(turnId!==null&&turnId!==undefined){
  const posts=source.query(`SELECT event_id,input_id,created_at,${context.boundedReads?"''":"json_extract(payload_json,'$.text')"} AS text
    FROM session_owner_events WHERE session_id=? AND turn_id=? AND kind='post' ORDER BY sequence`).all(sessionId,turnId) as any[];
  const here=posts.filter(post=>!!post.input_id&&roots.has(post.input_id));
  const values=here.flatMap(post=>{
   const message=context.boundedReads?messageById(context,post.event_id):{content:String(post.text??''),at:iso(post.created_at)!,root:post.input_id};
   return message&&(message.content.trim()||message.detailRef)?[readingValue(post.event_id,message)]:[];
  });
  if(values.length)return values;
  const result=source.query(`SELECT e.event_id,e.input_id,e.created_at,${context.boundedReads?"''":"COALESCE(json_extract(e.payload_json,'$.text'),t.agent_text,'')"} AS text
    FROM session_owner_events e LEFT JOIN turns t ON t.id=e.turn_id
    WHERE e.session_id=? AND e.turn_id=? AND e.kind='result' LIMIT 1`).get(sessionId,turnId) as any;
  if(result&&result.input_id&&roots.has(root(sessionId,result.input_id)??'')){
   const message=context.boundedReads?messageById(context,result.event_id):{content:String(result.text??''),at:iso(result.created_at)!,root:result.input_id};
   if(message&&(message.content.trim()||message.detailRef))return [readingValue(result.event_id,message)];
  }
 }
 const notices=[] as {messageId:string;text:string;at:string}[];
 for(const id of question.sources??[]){
  const input=source.query('SELECT scope FROM session_inputs WHERE id=?').get(id) as {scope:string}|null;
  if(input?.scope!=='service:provider-free-notice'||!roots.has(root(sessionId,id)??id))continue;
  const message=messageById(context,id);
  if(message&&(message.content.trim()||message.detailRef))notices.push(readingValue(id,message));
 }
 return notices;
}

function questionValue(context:TopicContext,row:any,roots:string[],replies:{inputId:string;at:string;reviews:string[];replyTo:string|null}[]){
 const question={id:row.question_id,topicId:row.topic_id,revision:row.revision,state:row.state,blocking:!!row.blocking,
  optional:!!row.optional,context:row.context,brief:parse(row.brief_json,{}),owner:parse(row.owner_json),sources:parse(row.sources_json,[]),
  replaces:row.replaces,replacedBy:row.replaced_by,answer:parse(row.answer_json),recovered:!!row.recovered,
  legacyNeedEventId:row.legacy_need_event_id,kind:row.kind==='reading'?'reading':'decision',origin:['marker','recovered'].includes(row.origin)?row.origin:'declared',
  generation:typeof row.generation==='number'?row.generation:null,deferUntil:iso(row.defer_until),createdAt:iso(row.created_at)!,updatedAt:iso(row.updated_at)!};
 const reading=[context.source.query("SELECT kind,revision,at,by_json FROM inbox_topic_reading WHERE topic_id=? AND item_id=? AND kind='exposed' AND revision=? ORDER BY at DESC LIMIT 1")
  .get(question.topicId,question.id,question.revision),
  context.source.query("SELECT kind,revision,at,by_json FROM inbox_topic_reading WHERE topic_id=? AND item_id=? AND kind='acknowledged' ORDER BY at DESC LIMIT 1")
  .get(question.topicId,question.id)].filter(Boolean);
 return questionDisplay({...question,questionId:question.id},replies,reading,readsFor(context,question,new Set(roots)));
}

export type TopicItemSink={question:(value:any)=>void;request:(value:any)=>void};
function* topicRows(source:Database,table:'inbox_questions'|'inbox_requests',topicId:string){
 const key=table==='inbox_questions'?'question_id':'request_id';let after='';
 while(true){const rows=source.query(`SELECT * FROM ${table} WHERE topic_id=? AND ${key}>? ORDER BY ${key} LIMIT 50`).all(topicId,after) as any[];
  for(const row of rows)yield row;
  if(rows.length<50)return;after=rows.at(-1)[key];
 }
}
export function preparedTopicValue(context:TopicContext,topicId:string,sink?:TopicItemSink){
 const {source,prepared,generation,sessionId}=context;
 const row=source.query('SELECT * FROM inbox_topics WHERE topic_id=?').get(topicId) as any;
 if(!row)return null;
 const roots=(source.query('SELECT root_input_id FROM inbox_topic_roots WHERE topic_id=? ORDER BY placed_at,root_input_id').all(topicId) as {root_input_id:string}[]).map(item=>item.root_input_id);
 const topic={topicId:row.topic_id,sessionId:row.session_id,title:row.title,summary:row.summary,state:row.state,setAside:parse(row.set_aside_json),
  aliases:parse(row.aliases_json,[]),revision:row.revision,recovered:!!row.recovered,readSequence:row.read_sequence,
  closure:parse(row.closure_json),createdAt:iso(row.created_at)!,updatedAt:iso(row.updated_at)!};
 const replies=roots.flatMap(root=>context.humanReplies.get(root)??[]).sort((a,b)=>b.at.localeCompare(a.at));
 const questions:any[]=[],requests:any[]=[],questionCounts={open:0,reading:0,checking:0,deferred:0,history:0},requestCounts={open:0,closed:0};
 const needItems:any[]=[],readItems:any[]=[];
 const item=(question:any)=>({questionId:question.id,text:question.brief?.decision??'',at:question.createdAt,revision:question.revision,
  kind:question.kind,owner:question.owner?.sessionId??null,outcome:question.kind==='reading'?'response':'needs_you'});
 const retainOldest=(items:any[],question:any)=>{items.push(item(question));items.sort((a,b)=>a.at.localeCompare(b.at));if(sink&&items.length>3)items.length=3;};
 for(const row of topicRows(source,'inbox_questions',topicId)){
  const question=questionValue(context,row,roots,replies);sink?.question(question);
  if(awaitingHim(question)){questionCounts.open++;retainOldest(needItems,question);}
  if(toReadByHim(question)){questionCounts.reading++;retainOldest(readItems,question);}
  if(preparingForHim(question))questionCounts.checking++;
  if(question.state==='deferred')questionCounts.deferred++;
  if(['answered','declined','withdrawn','superseded','read','expired'].includes(question.state))questionCounts.history++;
  if(!sink)questions.push(question);
  else if(open(question.state)||question.state==='deferred')questions.push({id:question.id,state:question.state,owner:question.owner,
   brief:{decision:question.brief?.decision},sources:question.sources});
 }
 for(const request of topicRows(source,'inbox_requests',topicId)){
  const value={requestId:request.request_id,topicId:request.topic_id,title:request.title,brief:request.brief,
  state:request.state,disposition:request.disposition,revision:request.revision,sources:parse(request.sources_json,[]),
  dispatches:parse(request.dispatches_json,[]),closure:parse(request.closure_json),createdAt:iso(request.created_at)!,updatedAt:iso(request.updated_at)!};
  sink?.request(requestView(context,value));
  if(value.state==='open')requestCounts.open++;else if(value.state==='closed')requestCounts.closed++;
  if(!sink)requests.push(value);
  else if(value.state==='open')requests.push({requestId:value.requestId,title:value.title,state:value.state,sources:value.sources,dispatches:value.dispatches});
 }
 if(!sink){questions.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));requests.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.requestId.localeCompare(b.requestId));}
 let lastSequence=0,lastAt=topic.createdAt;
 let foundEntry=false;
 for(const root of roots){
  const latest=prepared.query(`SELECT event_sequence AS sequence,created_at AS at FROM presentation_messages
   WHERE generation=? AND root_input_id=? ORDER BY event_sequence DESC LIMIT 1`).get(generation,root) as {sequence:number;at:string}|null;
  if(!latest)continue;
  lastSequence=Math.max(lastSequence,latest.sequence);
  const at=iso(latest.at)!;if(!foundEntry||at>lastAt)lastAt=at;foundEntry=true;
 }
 const work=topicWorkValue(context,topic,roots);
 const summary={id:topic.topicId,title:topic.title,aliases:topic.aliases,summary:topic.summary,state:topic.state,setAside:topic.setAside,
  revision:topic.revision,recovered:topic.recovered,createdAt:topic.createdAt,updatedAt:topic.updatedAt,lastEntryAt:lastAt,
  lastEntrySequence:lastSequence,unread:lastSequence>topic.readSequence,roots,
  closedAt:topic.state==='closed'&&topic.closure?.kind!=='merged'?topic.closure?.at??topic.updatedAt:null,
  needsYou:{count:questionCounts.open,oldestAt:needItems[0]?.at??null,items:needItems},
  toRead:{count:questionCounts.reading,oldestAt:readItems[0]?.at??null,items:readItems},
  questions:{open:questionCounts.open,checking:questionCounts.checking,deferred:questionCounts.deferred},requests:requestCounts,work,
  ...(sink&&(questionCounts.open>3||questionCounts.reading>3)?{coverage:{complete:false,code:'topic_attention_preview'}}:{})};
 const replyTargets=replyTargetsValue(context,topic,roots,requests,questions);
 const detail={topic:{...summary,closure:topic.closure,history:topicHistory(context,topicId)},
  requests:sink?[]:requests.map(request=>requestView(context,request)),questions:sink?[]:questions,
  focus:context.focus?.topicId===topicId?context.focus:null,work,replyTargets};
 // Open threads are one list, newest conversation first. Ranking what waits on him above everything
 // else pushed threads he had just spoken into past the first page, because nearly every thread
 // carries something to read (Tejas, 2026-10-08: "A lot of items … are missing … The order seems
 // to be not correct"). What needs him keeps its own filter, count and mark on the row.
 const band=0;
 return {sessionId,topicId,summary,detail,questionCounts,requestCount:requestCounts.open+requestCounts.closed,band,search:[topic.title,topic.summary,...topic.aliases].join(' ').toLowerCase(),
  recency:topic.state==='closed'?String(summary.closedAt??lastAt):String(lastAt)};
}

function latestReturnAndPost(context:TopicContext,roots:string[]){
 const {prepared,generation}=context;
 let found:{sequence:number;at:string;inputId:string}|null=null;
 for(const root of roots){
  const final=prepared.query(`SELECT event_sequence AS sequence,created_at AS at,message_id AS inputId
   FROM presentation_messages WHERE generation=? AND root_input_id=? AND entry_kind='final'
   ORDER BY event_sequence DESC LIMIT 1`).get(generation,root) as {sequence:number;at:string;inputId:string}|null;
  if(!final||iso(final.at)!<relaySince)continue;
  const post=prepared.query(`SELECT event_sequence AS sequence FROM presentation_messages
   WHERE generation=? AND root_input_id=? AND entry_kind='post' ORDER BY event_sequence DESC LIMIT 1`)
   .get(generation,root) as {sequence:number}|null;
  if((post?.sequence??-1)>final.sequence)continue;
  if(!found||final.sequence>found.sequence)found={...final,at:iso(final.at)!};
 }
 return found;
}

function topicWorkValue(context:TopicContext,topic:any,roots:string[]){
 if(context.focus?.topicId===topic.topicId)return {kind:'router_working' as const,text:context.focus.summary??'',
  runId:context.focus.runId,sessionId:`concierge:${topic.sessionId}`};
 const queued=context.queued.find(item=>item.root&&roots.includes(item.root));
 if(queued){const ahead=queued.position-1;
  const text=context.focusTitle
   ?ahead<=0?`Router is with ${context.focusTitle}; yours is next`
    :ahead===1?`Waiting behind ${context.focusTitle} and 1 other reply`
    :`Waiting behind ${context.focusTitle} and ${ahead} others`
   :ahead<=0?'Queued; the router takes it next':`Queued behind ${ahead} ${ahead===1?'reply':'replies'}`;
  return {kind:'router_queued' as const,text,position:queued.position};
 }
 const unrelayed=latestReturnAndPost(context,roots);
 if(unrelayed)return {kind:'result_waiting' as const,text:"An agent's answer came back and has not been relayed to you",
  returnInputId:unrelayed.inputId,since:unrelayed.at};
 const dispatch=context.dispatches.find(item=>item.root&&roots.includes(item.root));
 if(dispatch)return {kind:'worker_working' as const,text:'Handed to another agent',sessionId:dispatch.sessionId};
 return {kind:'idle' as const,text:''};
}

function requestView(context:TopicContext,request:any){
 const {source}=context;
 const dispatches=request.dispatches.map((dispatch:any)=>{
  const local=source.query('SELECT source_input_id,outcome,status,created_at_ms,payload_json FROM session_communication_requests WHERE request_id=?')
   .get(String(dispatch.requestId)) as any;
  const peer=local?null:source.query('SELECT source_input_id,outcome,status,created_at_ms,payload_json,peer,remote_session_id FROM session_peer_requests WHERE request_id=?')
   .get(String(dispatch.requestId)) as any;
  const row=local??peer;if(!row)return dispatch;
  const words=String(parse(row.payload_json,{})?.text??'').replace(/\s+/g,' ').trim();
  return {...dispatch,...(peer?{targetSessionId:peerAddress(peer.peer,peer.remote_session_id)}:{}),outcome:row.outcome??null,
   state:row.status??dispatch.state,...(row.source_input_id?{sourceInputId:row.source_input_id}:{}),
   ...(typeof row.created_at_ms==='number'?{at:new Date(row.created_at_ms).toISOString()}:{}),
   ...(words?{text:words.slice(0,240)}:{})};
 });
 return {id:request.requestId,topicId:request.topicId,title:request.title,brief:request.brief,state:request.state,
  disposition:request.disposition,revision:request.revision,sources:request.sources,dispatches,
  closure:request.closure,createdAt:request.createdAt,updatedAt:request.updatedAt};
}

function replyTargetsValue(context:TopicContext,topic:any,roots:string[],requests:any[],questions:any[]){
 const {source,sessionId}=context,router=`concierge:${sessionId}`;
 const choices=new Map<string,{sessionId:string;title:string|null;why:string;owns:string[]}>();
 const add=(named:string|null|undefined,why:string,owns:string[])=>{
  if(!named||named===router)return;
  const id=named.replace(/^([\w-]+):concierge:([1-9]\d*)$/,'$1:$2');
  const local=/^concierge:([1-9]\d*)$/.exec(id);
  let title:string|null;
  if(local){const row=source.query('SELECT status,native_metadata_json FROM sessions WHERE id=?').get(Number(local[1])) as any;
   if(!row||row.status==='archived'||parse(row.native_metadata_json,{})?.suspended)return;
   title=parse(row.native_metadata_json,{})?.title??null;
  }else{
   const row=source.query("SELECT view_json FROM session_peer_catalogue WHERE json_extract(view_json,'$.id')=?").get(id) as {view_json:string}|null;
   const view=parse(row?.view_json);if(!view||view.archived||view.archivedAt||view.status==='archived')return;
   title=view.title??null;
  }
  const existing=choices.get(id);
  if(existing){existing.owns.push(...owns.filter(item=>!existing.owns.includes(item)));return;}
  choices.set(id,{sessionId:id,title,why,owns:[...new Set(owns)]});
 };
 const stillOpen=(id:string)=>!!source.query('SELECT 1 FROM session_communication_requests WHERE request_id=? AND outcome IS NULL AND stalled_at_ms IS NULL').get(id)
  ||!!source.query('SELECT 1 FROM session_peer_requests WHERE request_id=? AND outcome IS NULL AND stalled_at_ms IS NULL').get(id);
 for(const request of requests)if(request.state==='open')for(const dispatch of request.dispatches)
  if(stillOpen(String(dispatch.requestId)))add(dispatch.targetSessionId,`working on “${request.title}”`,request.sources.map((item:any)=>item.inputId));
 for(const dispatch of context.dispatches)if(dispatch.root&&roots.includes(dispatch.root))add(dispatch.sessionId,'working on this thread now',[dispatch.root]);
 for(const question of questions)if(open(question.state)||question.state==='deferred')
  add(question.owner?.sessionId,question.brief?.decision?`asked you: ${question.brief.decision}`:'asked you a question here',
   [question.id,...question.sources]);
 const list=[...choices.values()];
 return {router,default:list.length===1?list[0]!.sessionId:router,choices:list};
}

function topicHistory(context:TopicContext,topicId:string){
 const rows=context.prepared.query(`SELECT event_sequence AS sequence FROM presentation_topic_events
  WHERE generation=? AND topic_id=? ORDER BY event_sequence DESC LIMIT 20`).all(context.generation,topicId) as {sequence:number}[];
 return rows.map(row=>{
  const event=context.source.query(`SELECT created_at,json_extract(payload_json,'$.change') AS change,
   json_extract(payload_json,'$.by') AS by_json,json_extract(payload_json,'$.reason') AS reason
   FROM session_owner_events WHERE sequence=?`).get(row.sequence) as any;
  if(!event)return null;
  return {change:event.change,at:iso(event.created_at),by:parse(event.by_json),reason:event.reason??null};
 }).filter(Boolean);
}
