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
