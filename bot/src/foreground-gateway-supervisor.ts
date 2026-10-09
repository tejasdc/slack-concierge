import {releaseWorkerPath} from './release-worker';
import {log} from './log';
import {OWNER_COMMAND_RESPONSE_MS} from './owner-transport-policy';

export type ForegroundPeer={hostname:string;port:number;token:string;onContact?:()=>void};

export async function startForegroundGatewayProcess(stateDir:string,ownerSocket:string,peer?:ForegroundPeer|null) {
  const gatewayEntry=releaseWorkerPath('foreground-gateway-worker');
  const readWorkerEntry=releaseWorkerPath('native-read-worker');
  let stopped=false,child:ReturnType<typeof Bun.spawn>|null=null;
  let restarting:ReturnType<typeof setTimeout>|null=null;
  const launch=()=>new Promise<void>((resolve,reject)=>{
    if(stopped){resolve();return;}
    let settled=false,ready=false;
    let deadline:ReturnType<typeof setTimeout>|undefined;
    let running:ReturnType<typeof Bun.spawn>|null=null;
    const settle=(error?:Error)=>{if(settled)return;settled=true;if(deadline)clearTimeout(deadline);error?reject(error):resolve();};
    const command=[process.execPath,gatewayEntry];
    try {running=Bun.spawn(process.platform==='linux'?['setpriv','--pdeathsig','KILL',...command]:command,{
      env:{...process.env,CONCIERGE_STATE_DIR:stateDir,CONCIERGE_OWNER_INTERNAL_SOCKET:ownerSocket,
        CONCIERGE_READ_WORKER_ENTRY:readWorkerEntry,
        ...(peer?{CONCIERGE_GATEWAY_PEER:JSON.stringify({hostname:peer.hostname,port:peer.port,token:peer.token})}:{})},
      stdin:'ignore',stdout:'inherit',stderr:'inherit',ipc(message:any){
        if(message?.kind==='ready'&&message.pid===running?.pid){ready=true;settle();}
        else if(message?.kind==='failed')settle(new Error(String(message.message)));
        else if(message?.kind==='peer-contact')peer?.onContact?.();
      },
    });}catch(error){settle(error instanceof Error?error:new Error(String(error)));return;}
    deadline=setTimeout(()=>{
      running?.kill('SIGKILL');settle(new Error('The foreground gateway did not become ready.'));
    },45_000);
    child=running;
    void running.exited.then(code=>{
      if(child===running)child=null;
      settle(new Error(`Foreground gateway exited before readiness (${code}).`));
      if(stopped||!ready)return;
      log('error','foreground_gateway_exited',{code});
      restarting=setTimeout(()=>{restarting=null;void launch().catch(error=>log('error','foreground_gateway_restart_failed',{error:String(error)}));},2000);
    });
  });
  const stop=async(force=false)=>{
    stopped=true;if(restarting)clearTimeout(restarting);
    const running=child;if(!running)return;
    running.send({kind:'stop',force});
    const hard=setTimeout(()=>running.kill('SIGKILL'),force?5000:OWNER_COMMAND_RESPONSE_MS+5000);
    await running.exited;clearTimeout(hard);
  };
  try {await launch();return stop;} catch(error){await stop(true);throw error;}
}
