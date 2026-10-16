import {db} from './state';

/** A request is the event: its source message, current Inbox thread and receiving session. */
export type Mutual = Readonly<{topicId:string; title:string; messages:number; lastAt:string; strength:number}>;
type Event = {session_id:number;topic_id:string;title:string;source_input_id:string|null;created_at_ms:number};
const HALF_LIFE_MS=30*86_400_000;

/** Derive associations from durable receipts, so moving a message to another thread takes effect immediately. */
export function sessionMutuals(sessionIds:readonly number[],now=Date.now()):Map<number,Mutual[]> {
 const output=new Map<number,Mutual[]>();
 if(!sessionIds.length)return output;
 const placeholders=sessionIds.map(()=>'?').join(',');
 const events=db.query(`SELECT r.target_session_id AS session_id, t.topic_id, coalesce(i.title,t.topic_id) AS title,
   r.source_input_id, r.created_at_ms
   FROM session_communication_requests r
   JOIN inbox_topic_roots t ON t.root_input_id=coalesce(nullif(r.topic_root_input_id,''),r.thread_root_input_id)
   LEFT JOIN inbox_topics i ON i.topic_id=t.topic_id
   WHERE r.target_session_id IN (${placeholders}) AND coalesce(r.outcome,'')<>'failed'
   ORDER BY r.created_at_ms DESC LIMIT 5000`).all(...sessionIds) as Event[];
 const grouped=new Map<string,{session:number;topic:string;title:string;messages:Set<string>;lastAt:number;strength:number}>();
 for(const event of events){
  const key=`${event.session_id}:${event.topic_id}`;
  let item=grouped.get(key);
  if(!item){item={session:event.session_id,topic:event.topic_id,title:event.title,messages:new Set(),lastAt:0,strength:0};grouped.set(key,item);}
  const message=event.source_input_id??`request:${event.session_id}:${event.created_at_ms}`;
  if(item.messages.has(message))continue;
  item.messages.add(message);
  item.lastAt=Math.max(item.lastAt,event.created_at_ms);
  item.strength+=Math.pow(0.5,Math.max(0,now-event.created_at_ms)/HALF_LIFE_MS);
 }
 for(const item of grouped.values()){
  const list=output.get(item.session)??[];
  list.push({topicId:item.topic,title:item.title,messages:item.messages.size,lastAt:new Date(item.lastAt).toISOString(),strength:Math.min(4,item.strength)});
  output.set(item.session,list);
 }
 for(const list of output.values())list.sort((a,b)=>b.strength-a.strength||a.topicId.localeCompare(b.topicId));
 return output;
}

/** Only matching sessions can move; a shared thread is evidence of proximity, not a search hit. */
export function mutualLift(sessionId:number,anchors:readonly number[],mutuals:Map<number,Mutual[]>):number{
 const own=mutuals.get(sessionId)??[];
 if(!own.length)return 0;
 let strength=0;
 for(const [rank,anchor] of anchors.entries()){
  if(anchor===sessionId)continue;
  const theirs=mutuals.get(anchor)??[];
  for(const edge of own){const match=theirs.find(item=>item.topicId===edge.topicId);
   if(match)strength+=Math.min(edge.strength,match.strength)/(1+rank);
  }
 }
 return Math.min(0.001,strength*0.00025);
}
