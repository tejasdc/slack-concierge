import {randomUUID} from 'node:crypto';
import type {Server,ServerWebSocket,WebSocketHandler} from 'bun';
import {log} from './log';

/**
 * Live connections to a service that runs on a runner, piped through the owner's front door
 * (docs/architecture/RUNNERS.md, "Codex App Server on a runner"). Runners open no port, so:
 *
 * 1. A runner keeps one outbound WebSocket open to the agents' entrance: `/runner/v1/relay/listen`.
 * 2. Something on the owner's machine (the Codex App Server bridge) opens a WebSocket on the local
 *    socket: `/runner/v1/relay/connect?runner=<name>&target=<service>`.
 * 3. The gateway asks that runner, over its listen channel, to open `/runner/v1/relay/accept?id=`;
 *    when it does, the two WebSockets are paired and every message passes through unchanged, in
 *    order, both ways. Messages sent before the pair forms wait here (bounded).
 * 4. Either side closing closes the other. Nothing is stored: a relay is a connection, and its
 *    users already treat a dropped connection as ambiguous and reconnect (a new relay).
 *
 * Only a runner token may listen or accept, and only for its own name; only the root-private local
 * socket may connect. No owner state or ledger is touched, so this runs inside the gateway.
 */
/** `runner-machine` is the owner's call channel to the runner itself (runner-machine-calls.ts). */
export const RELAY_TARGETS=new Set(['codex-app-server','runner-machine']);
const ACCEPT_DEADLINE_MS=15_000;
const BUFFER_LIMIT=16*1024*1024;

type Message=string|Buffer;
export type RelaySocketData=
  |{role:'listen';runner:string}
  |{role:'local';runner:string;id:string;target:string}
  |{role:'accept';runner:string;id:string};
type Pair={id:string;runner:string;target:string;local:ServerWebSocket<RelaySocketData>;remote:ServerWebSocket<RelaySocketData>|null;
  waiting:Message[];waitingBytes:number;timer:ReturnType<typeof setTimeout>|null};

export class RunnerRelay {
  private readonly listeners=new Map<string,ServerWebSocket<RelaySocketData>>();
  private readonly pairs=new Map<string,Pair>();

  /** The local socket's `connect`: refused before upgrade when the runner is not listening. */
  upgradeLocal(request:Request,server:Server):Response|undefined {
    const url=new URL(request.url);
    const runner=url.searchParams.get('runner')??'',target=url.searchParams.get('target')??'';
    if(!RELAY_TARGETS.has(target))return Response.json({ok:false,error:'UNKNOWN_RELAY_TARGET'},{status:404});
    if(!this.listeners.has(runner))return Response.json({ok:false,error:'RUNNER_NOT_LISTENING',detail:`runner ${runner} has no relay channel open`},{status:503});
    if(server.upgrade(request,{data:{role:'local',runner,id:randomUUID(),target}}))return undefined;
    return Response.json({ok:false,error:'WEBSOCKET_REQUIRED'},{status:426});
  }

  /** The agents' entrance: `listen` and `accept`, for a verified runner principal only. */
  upgradeRunner(request:Request,server:Server,principal:string):Response|undefined {
    if(!principal.startsWith('runner:'))return Response.json({ok:false,error:'RUNNER_TOKEN_REQUIRED'},{status:403});
    const runner=principal.slice('runner:'.length);
    const url=new URL(request.url);
    let data:RelaySocketData;
    if(url.pathname==='/runner/v1/relay/listen')data={role:'listen',runner};
    else {
      const id=url.searchParams.get('id')??'';
      const pair=this.pairs.get(id);
      if(!pair||pair.runner!==runner||pair.remote)return Response.json({ok:false,error:'UNKNOWN_RELAY'},{status:404});
      data={role:'accept',runner,id};
    }
    if(server.upgrade(request,{data}))return undefined;
    return Response.json({ok:false,error:'WEBSOCKET_REQUIRED'},{status:426});
  }

  readonly handlers:WebSocketHandler<RelaySocketData>={
    perMessageDeflate:false,
    // One message may be as large as the backpressure limit below, never larger: a bigger one could
    // never be passed on and would end the relay every time it was asked again. Concierge's resumes
    // exclude turns and history is read in pages, so answers stay far below this.
    maxPayloadLength:64*1024*1024,
    // A peer that stops reading past this is disconnected rather than having messages dropped:
    // a dropped JSON-RPC answer would look like a stalled turn, a disconnect is handled as ambiguous.
    backpressureLimit:64*1024*1024,closeOnBackpressureLimit:true,
    // Pings every idle minute: a runner whose network went away is noticed and its channel dropped,
    // instead of leaving a dead listener that every connect would wait on.
    idleTimeout:60,sendPings:true,
    open:socket=>{
      const data=socket.data;
      if(data.role==='listen'){
        const previous=this.listeners.get(data.runner);
        this.listeners.set(data.runner,socket);
        // The newest channel is the runner's current process; an older one is a dead copy.
        if(previous&&previous!==socket)previous.close(4000,'replaced by a newer listen channel');
        log('info','runner_relay_listening',{runner:data.runner});
        return;
      }
      if(data.role==='local'){
        const listener=this.listeners.get(data.runner);
        if(!listener){socket.close(1013,'runner not listening');return;}
        const pair:Pair={id:data.id,runner:data.runner,target:data.target,local:socket,remote:null,waiting:[],waitingBytes:0,
          timer:setTimeout(()=>this.end(pair,'the runner did not accept the relay in time'),ACCEPT_DEADLINE_MS)};
        this.pairs.set(data.id,pair);
        listener.send(JSON.stringify({op:'open',id:data.id,target:data.target}));
        return;
      }
      const pair=this.pairs.get(data.id);
      if(!pair||pair.remote||pair.runner!==data.runner){socket.close(1008,'unknown relay');return;}
      pair.remote=socket;
      if(pair.timer)clearTimeout(pair.timer);pair.timer=null;
      for(const message of pair.waiting)if(!this.forward(pair,socket,message))return;
      pair.waiting=[];pair.waitingBytes=0;
      log('info','runner_relay_paired',{runner:pair.runner,target:pair.target,relay:pair.id});
    },
    message:(socket,message)=>{
      const data=socket.data;
      if(data.role==='listen')return; // the runner's channel carries nothing to the owner
      const pair=this.pairs.get(data.id);
      if(!pair)return;
      if(data.role==='accept'){this.forward(pair,pair.local,message);return;}
      if(pair.remote){this.forward(pair,pair.remote,message);return;}
      pair.waitingBytes+=typeof message==='string'?Buffer.byteLength(message):message.length;
      if(pair.waitingBytes>BUFFER_LIMIT){this.end(pair,'too much waited for the runner');return;}
      pair.waiting.push(message);
    },
    close:(socket,code,reason)=>{
      const data=socket.data;
      if(data.role==='listen'){
        if(this.listeners.get(data.runner)===socket)this.listeners.delete(data.runner);
        log('info','runner_relay_listen_closed',{runner:data.runner,code,reason});
        return;
      }
      const pair=this.pairs.get(data.id);
      if(pair)this.end(pair,`${data.role==='local'?'owner':'runner'} side closed (${code}${reason?` ${reason}`:''})`);
    },
  };

  /** Bun's send answers 0 when it dropped the message: the relay ends instead of losing it silently. */
  private forward(pair:Pair,to:ServerWebSocket<RelaySocketData>,message:Message):boolean {
    if(to.send(message)!==0)return true;
    this.end(pair,'a message could not be passed on');
    return false;
  }

  /** Before the gateway stops: open WebSockets would otherwise hold a graceful stop until it is killed. */
  closeAll(why='the owner is stopping') {
    for(const pair of [...this.pairs.values()])this.end(pair,why);
    for(const listener of [...this.listeners.values()])try{listener.close(1001,why);}catch{}
    this.listeners.clear();
  }

  private end(pair:Pair,why:string) {
    if(!this.pairs.delete(pair.id))return;
    if(pair.timer)clearTimeout(pair.timer);
    log('info','runner_relay_closed',{runner:pair.runner,target:pair.target,relay:pair.id,why});
    // 1011 tells each side the relay, not the service, ended it.
    for(const socket of [pair.local,pair.remote])try{socket?.close(1011,why.slice(0,120));}catch{}
  }

  snapshot(){return {listening:[...this.listeners.keys()],relays:this.pairs.size};}
}
