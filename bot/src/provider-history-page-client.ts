import {fork,type ChildProcess} from 'node:child_process';
import {releaseWorkerPath} from './release-worker';
import {readdirSync,readFileSync} from 'node:fs';

function groupHasRunningProcesses(group:number):boolean {
  if(process.platform!=='linux'){
    try{process.kill(-group,0);return true;}catch{return false;}
  }
  return readdirSync('/proc').some(pid=>{
    if(!/^\d+$/.test(pid))return false;
    try{
      const stat=readFileSync(`/proc/${pid}/stat`,'utf8');
      const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
      return Number(fields[2])===group&&fields[0]!=='Z'&&fields[0]!=='X';
    }catch{return false;}
  });
}

type Work={operation:'page'|'delta'|'prepare';sessionId:string;cwd:string;cursor:string|null;limit:number;after:string|null;
  want?:{dialogue:number;untilInput:boolean};thread?:string};
type Reply={id:number;result?:unknown;error?:{message:string;status:number}};

// A window is collected inside the worker under the owner's own four-second budget.
const HISTORY_WINDOW_WAIT_MS=6000;

/** One persistent worker keeps the cold Claude import alive between requests. */
export class ProviderHistoryPageClient {
  constructor(private readonly workerPath=releaseWorkerPath('provider-history-page-worker'),private readonly requestWaitMs?:number){}
  private worker:ChildProcess|null=null;
  private sealed=false;
  private retirement:Promise<void>|null=null;
  private nextId=1;
  private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private ensure(){
    if(this.sealed)throw new Error('HISTORY_PAGE_WORKER_STOPPED');
    if(this.worker)return this.worker;
    const worker=fork(this.workerPath,[],{execPath:process.execPath,execArgv:[],detached:true,stdio:['ignore','ignore','inherit','ipc']});
    worker.unref();
    worker.on('message',(reply:Reply)=>{
      const item=this.pending.get(reply.id);if(!item)return;
      clearTimeout(item.timer);this.pending.delete(reply.id);
      if(reply.error){const error=Object.assign(new Error(reply.error.message),{status:reply.error.status});item.reject(error);}
      else item.resolve(reply.result);
    });
    const failed=(reason:string)=>{
      if(this.worker!==worker)return;
      for(const [id,item] of this.pending){clearTimeout(item.timer);item.reject(new Error(reason));this.pending.delete(id);}
      void this.close();
    };
    worker.on('error',error=>{
      // A failed IPC write does not establish that the child has exited.
      for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(error);}
      this.pending.clear();
      void this.close();
    });
    worker.on('exit',code=>failed(`HISTORY_PAGE_WORKER_EXIT_${code}`));
    this.worker=worker;
    return worker;
  }
  /** Tops up one Codex conversation's kept history window in the background; failures only cost the next open. */
  prepareCodexWindow(sessionId:number,thread:string){
    void this.request({operation:'prepare',sessionId:`concierge:${sessionId}`,cwd:'',cursor:null,limit:1,after:null,thread}).catch(()=>{});
  }
  /** Loads the worker before the first open asks for a page, instead of during it. */
  warm(){if(!this.sealed)this.ensure();}
  request(work:Work):Promise<unknown>{
    if(this.sealed)return Promise.reject(new Error('HISTORY_PAGE_WORKER_STOPPED'));
    let worker:ChildProcess;
    try{worker=this.ensure();}catch(error){return Promise.reject(error);}
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        const item=this.pending.get(id);if(!item)return;
        this.pending.delete(id);
        item.reject(new Error('HISTORY_PAGE_STILL_PREPARING'));
        // An import already under way must finish and warm the worker. Killing it here
        // would make every retry start the same expensive cold read from zero.
      },this.requestWaitMs??(work.want||work.operation==='prepare'?HISTORY_WINDOW_WAIT_MS:5000));
      timer.unref?.();
      this.pending.set(id,{resolve,reject,timer});
      worker.send({id,...work},error=>{
        if(!error)return;const item=this.pending.get(id);if(!item)return;
        clearTimeout(item.timer);this.pending.delete(id);item.reject(error);
      });
    });
  }
  close():Promise<void>{
    if(this.retirement)return this.retirement;
    this.sealed=true;
    const worker=this.worker;
    for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(new Error('HISTORY_PAGE_WORKER_STOPPED'));}
    this.pending.clear();
    this.retirement=(async()=>{
      if(!worker)return;
      const signal=(name:NodeJS.Signals)=>{
        if(!worker.pid)return;
        try{process.kill(-worker.pid,name);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
      };
      const exited=new Promise<void>(resolve=>worker.once('close',()=>resolve()));
      // Terminate the owned process group, including imports still running after a caller timeout.
      signal('SIGTERM');
      const kill=setTimeout(()=>signal('SIGKILL'),2000);
      try{
        await exited;signal('SIGKILL');
        while(worker.pid&&groupHasRunningProcesses(worker.pid))await new Promise(resolve=>setTimeout(resolve,10));
      }finally{clearTimeout(kill);}
      if(this.worker===worker)this.worker=null;
    })();
    return this.retirement;
  }
}
