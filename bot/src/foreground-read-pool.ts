import {join} from 'node:path';
import {forwardPrivateRequest,unavailable} from './foreground-forward';
import {log,errorFields} from './log';
import {OWNER_READ_RESPONSE_MS} from './owner-transport-policy';

// Two is the minimum capacity that leaves an independent reader after one blocks.
const READERS=2;
// This is retained admission metadata, not an unbounded queue of request bodies.
const MAX_WAITING=64;
// Existing owner/peer reads have a 20 second response deadline. Do not multiply it
// by queueing and execution, or retain work after its caller has already left.
type Slot={id:number;socket:string;child:ReturnType<typeof Bun.spawn>|null;ready:boolean;
  active:{id:string;route:string;since:number}|null;restart:ReturnType<typeof setTimeout>|null};
type Waiter={resolve:(slot:Slot|null)=>void;signal:AbortSignal;abort:()=>void};

export class ForegroundReadPool {
  private slots:Slot[];
  private waiting:Waiter[]=[];
  private stopped=false;
  private nextReader=0;
  constructor(private stateDir:string,private ownerSocket:string,private workerEntry:string) {
    this.slots=Array.from({length:READERS},(_,id)=>({id,socket:join(stateDir,`request-read-${id}.sock`),child:null,ready:false,active:null,restart:null}));
  }
  async start() {await Promise.all(this.slots.map(slot=>this.launch(slot)));}
  private async launch(slot:Slot) {
    if(this.stopped)return;
    slot.ready=false;
    const command=[process.execPath,this.workerEntry];
    const child=Bun.spawn(process.platform==='linux'?['setpriv','--pdeathsig','KILL',...command]:command,{
      env:{...process.env,CONCIERGE_READ_WORKER:'1',CONCIERGE_READ_SOCKET:slot.socket,CONCIERGE_OWNER_INTERNAL_SOCKET:this.ownerSocket},
      stdin:'ignore',stdout:'inherit',stderr:'inherit',ipc:()=>{},
    });
    slot.child=child;
    void child.exited.then(code=>{
      if(slot.child!==child)return;
      slot.child=null;slot.ready=false;
      if(this.stopped)return;
      log('error','foreground_reader_exited',{reader:slot.id,code,active:slot.active});
      slot.restart=setTimeout(()=>{slot.restart=null;void this.launch(slot).catch(error=>log('error','foreground_reader_start_failed',errorFields(error)));},2000);
    });
    const until=Date.now()+30_000;
    while(!this.stopped&&slot.child===child&&Date.now()<until) {
      try {
        const response=await fetch('http://localhost/internal/ready',{unix:slot.socket,signal:AbortSignal.timeout(500)});
        const ready=response.ok&&(await response.json() as {pid?:number}).pid===child.pid;
        if(ready){slot.ready=true;this.dispatch();return;}
      } catch {}
      await Bun.sleep(50);
    }
    if(slot.child===child)child.kill('SIGKILL');
    if(!this.stopped)throw new Error(`Read executor ${slot.id} did not become ready.`);
  }
  snapshot() {
    return {ready:this.slots.filter(slot=>slot.ready).length,waiting:this.waiting.length,
      readers:this.slots.map(slot=>({id:slot.id,pid:slot.child?.pid??null,ready:slot.ready,active:slot.active}))};
  }
  async health() {
    return Promise.all(this.slots.map(async slot=>{
      try {
        const response=await fetch('http://localhost/internal/ready',{unix:slot.socket,signal:AbortSignal.timeout(250)});
        const body=await response.json() as {pid?:number;logging?:unknown;requests?:unknown};
        return {id:slot.id,responding:response.ok&&body.pid===slot.child?.pid,pid:body.pid??null,logging:body.logging??null,requests:body.requests??null};
      }catch{return {id:slot.id,responding:false,pid:slot.child?.pid??null,logging:null};}
    }));
  }
  private dispatch() {
    const ordered=Array.from({length:this.slots.length},(_,offset)=>this.slots[(this.nextReader+offset)%this.slots.length]!);
    for(const slot of ordered) {
      if(!slot.ready||slot.active)continue;
      let waiter:Waiter|undefined;
      while((waiter=this.waiting.shift())) {
        waiter.signal.removeEventListener('abort',waiter.abort);
        if(waiter.signal.aborted){waiter.resolve(null);continue;}
        // Reserve synchronously so another arrival cannot claim this same worker.
        slot.active={id:'assigning',route:'assigning',since:performance.now()};
        this.nextReader=(slot.id+1)%this.slots.length;
        waiter.resolve(slot);break;
      }
    }
  }
  private acquire(signal:AbortSignal):Promise<Slot|null> {
    if(signal.aborted||this.stopped||this.waiting.length>=MAX_WAITING)return Promise.resolve(null);
    return new Promise(resolve=>{
      const waiter:Waiter={resolve,signal,abort:()=>{
        const i=this.waiting.indexOf(waiter);if(i>=0)this.waiting.splice(i,1);
        resolve(null);
      }};
      signal.addEventListener('abort',waiter.abort,{once:true});
      this.waiting.push(waiter);this.dispatch();
    });
  }
  async request(request:Request,route:string,id:string) {
    const began=performance.now();
    const timeout=AbortSignal.timeout(OWNER_READ_RESPONSE_MS);
    const admissionSignal=AbortSignal.any([request.signal,timeout]);
    const occupied=this.snapshot().readers.filter(slot=>slot.active);
    const slot=await this.acquire(admissionSignal);
    const waited=performance.now()-began;
    if(!slot) {
      log('warn','foreground_read_unavailable',{request_id:id,route,admission_ms:Math.round(waited),occupied,capacity:this.snapshot()});
      return unavailable('READ_CAPACITY_UNAVAILABLE','Read capacity is unavailable. No command was submitted.');
    }
    slot.active={id,route,since:performance.now()};
    const running=slot.child;
    let released=false;
    const release=()=>{
      if(released)return;released=true;
      timeout.removeEventListener('abort',retire);
      slot.active=null;this.dispatch();
    };
    const retire=()=>{
      if(released)return;
      // Only the executor's deadline retires occupied work. A caller leaving
      // must not destroy warm history state or spend everybody's read capacity.
      if(slot.child===running){slot.ready=false;running?.kill('SIGKILL');}
      release();
    };
    if(admissionSignal.aborted){release();return unavailable('READ_CANCELLED','This read was cancelled before execution.');}
    timeout.addEventListener('abort',retire,{once:true});
    try {
      // Keep the slot until execution finishes even if its original caller left.
      // Cancellation while waiting for a slot is still immediate above.
      const response=await forwardPrivateRequest(request,slot.socket,timeout);
      if(waited>=200||performance.now()-began>=2000)
        log('warn','foreground_read_delayed',{request_id:id,route,reader:slot.id,admission_ms:Math.round(waited),headers_ms:Math.round(performance.now()-began),occupied});
      if(request.signal.aborted){await response.body?.cancel();release();return unavailable('READ_CANCELLED','The caller cancelled this read.');}
      if(!response.body){release();return response;}
      const reader=response.body.getReader();
      const body=new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const part=await reader.read();
            if(part.done){release();controller.close();}else controller.enqueue(part.value);
          } catch(error){release();controller.error(error);}
        },
        async cancel(reason){try {await reader.cancel(reason);}finally{release();}},
      });
      return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
    } catch(error) {
      log('warn','foreground_read_failed',{request_id:id,route,reader:slot.id,admission_ms:Math.round(waited),elapsed_ms:Math.round(performance.now()-began),...errorFields(error)});
      // Only readonly work may be interrupted at its deadline. Canonical command
      // execution is never killed or replayed because an HTTP caller gave up.
      if(timeout.aborted)retire();else release();
      return unavailable('READ_EXECUTOR_UNAVAILABLE','This read did not complete. Other requests can continue.');
    }
  }
  async stop() {
    this.stopped=true;
    for(const waiter of this.waiting.splice(0)){waiter.signal.removeEventListener('abort',waiter.abort);waiter.resolve(null);}
    await Promise.all(this.slots.map(async slot=>{
      if(slot.restart)clearTimeout(slot.restart);
      const child=slot.child;if(!child)return;
      child.kill('SIGTERM');
      const hard=setTimeout(()=>child.kill('SIGKILL'),2000);
      await child.exited;clearTimeout(hard);
    }));
  }
}
