import {existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {Worker} from 'node:worker_threads';

type Work={operation:'page'|'delta';sessionId:string;cwd:string;cursor:string|null;limit:number;after:string|null};
type Reply={id:number;result?:unknown;error?:{message:string;status:number}};

function workerPath(){
  const adjacent=join(dirname(process.argv[1]||''),'provider-history-page-worker.js');
  if(existsSync(adjacent))return adjacent;
  const source=join(import.meta.dir,'provider-history-page-worker.ts');
  if(existsSync(source))return source;
  throw new Error('HISTORY_PAGE_WORKER_UNAVAILABLE');
}

/** One persistent worker keeps the cold Claude import alive between requests. */
export class ProviderHistoryPageClient {
  private worker:Worker|null=null;
  private nextId=1;
  private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private ensure(){
    if(this.worker)return this.worker;
    const worker=new Worker(workerPath());
    worker.unref();
    worker.on('message',(reply:Reply)=>{
      const item=this.pending.get(reply.id);if(!item)return;
      clearTimeout(item.timer);this.pending.delete(reply.id);
      if(reply.error){const error=Object.assign(new Error(reply.error.message),{status:reply.error.status});item.reject(error);}
      else item.resolve(reply.result);
    });
    const failed=(reason:string)=>{
      if(this.worker!==worker)return;
      this.worker=null;
      for(const [id,item] of this.pending){clearTimeout(item.timer);item.reject(new Error(reason));this.pending.delete(id);}
    };
    worker.on('error',error=>failed(error.message));
    worker.on('exit',code=>failed(`HISTORY_PAGE_WORKER_EXIT_${code}`));
    this.worker=worker;
    return worker;
  }
  request(work:Work):Promise<unknown>{
    const worker=this.ensure(),id=this.nextId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        if(this.worker===worker)this.worker=null;
        for(const [pendingId,item] of this.pending){clearTimeout(item.timer);
          item.reject(new Error(pendingId===id?'HISTORY_PAGE_BUDGET_EXCEEDED':'HISTORY_PAGE_WORKER_RESTARTED'));
          this.pending.delete(pendingId);}
        worker.terminate().catch(()=>{});
      },5000);
      timer.unref?.();
      this.pending.set(id,{resolve,reject,timer});
      worker.postMessage({id,...work});
    });
  }
  async close(){
    const worker=this.worker;this.worker=null;
    for(const [id,item] of this.pending){clearTimeout(item.timer);item.reject(new Error('HISTORY_PAGE_WORKER_STOPPED'));this.pending.delete(id);}
    if(worker)await worker.terminate();
  }
}
