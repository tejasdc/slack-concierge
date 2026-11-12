import type {Database} from 'bun:sqlite';
import {latestWorkerProgress} from './worker-progress';

type Dispatch={sessionId:string|null;title:string;requestId:string};

/** One current contributor per destination, with the newest progress across its open requests. */
export function topicCurrentWorkers(source:Database,dispatches:Dispatch[]){
 const workers=new Map<string,{sessionId:string|null;title:string;progress:{text:string;at:string}|null}>();
 for(const item of dispatches){
  const key=item.sessionId??`request:${item.requestId}`;
  const progress=latestWorkerProgress(source,item.requestId);
  const previous=workers.get(key);
  if(!previous)workers.set(key,{sessionId:item.sessionId,title:item.title,progress});
  else if(progress&&(!previous.progress||progress.at>previous.progress.at))previous.progress=progress;
 }
 return [...workers.values()];
}

/**
 * The sessions through which a target is still at work for whoever asked it: its own live turn,
 * or an open request it sent to an agent that is itself still at work. An agent that ends its
 * turn to wait for a ChatGPT Pro answer or another agent's build has not finished; counting only
 * its own turn showed his thread green while that work ran (bug report ce2b8b10, 2026-11-11).
 * Returns the chain ending at the live turn, or null when nothing down it is running. A peer
 * request counts as live, as a direct peer dispatch already does. Bounded and cycle-safe.
 */
export function workingThrough(source:Database,sessionId:number,seen:Set<number>=new Set()):number[]|null{
 if(seen.has(sessionId)||seen.size>=8)return null;
 seen.add(sessionId);
 if(source.query("SELECT 1 FROM turns WHERE session_id=? AND status IN ('running','delivering','queued')").get(sessionId))return [sessionId];
 for(const row of source.query('SELECT DISTINCT target_session_id AS target FROM session_communication_requests WHERE source_session_id=? AND outcome IS NULL').all(sessionId) as {target:number}[]){
  const chain=workingThrough(source,row.target,seen);
  if(chain)return [sessionId,...chain];
 }
 if(source.query('SELECT 1 FROM session_peer_requests WHERE source_session_id=? AND outcome IS NULL').get(sessionId))return [sessionId];
 return null;
}

/**
 * Dispatches that belong only to the thread's closed requests. Closing a request settles the
 * thread's work on it even when the agent never settled the delivery itself, so that agent being
 * busy on other threads must not make this one look worked on (bug report 42e217cf, 2026-11-11:
 * six threads closed by the Inbox showed "Still being worked on" and pulsed while their agent
 * worked elsewhere).
 */
export function closedRequestDispatches(requests:readonly {state:string;dispatches?:readonly any[]}[]){
 const open=new Set<string>(),closed=new Set<string>();
 for(const request of requests)for(const dispatch of request.dispatches??[]){
  const id=String(dispatch?.requestId??'');if(!id)continue;
  (request.state==='open'?open:closed).add(id);
 }
 for(const id of open)closed.delete(id);
 return closed;
}
