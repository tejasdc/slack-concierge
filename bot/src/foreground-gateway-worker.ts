import {startForegroundGateway} from './foreground-gateway';
import {log,errorFields} from './log';

let gateway:Awaited<ReturnType<typeof startForegroundGateway>>|null=null;
let stopping=false;
async function stop(force=true) {
  if(stopping)return;stopping=true;
  await gateway?.stop(force);
  process.exit(0);
}
process.on('disconnect',()=>void stop());
process.on('SIGTERM',()=>void stop());
process.on('SIGINT',()=>void stop());
process.on('message',(message:any)=>{if(message?.kind==='stop')void stop(message.force===true);});
try {
  const stateDir=process.env.CONCIERGE_STATE_DIR;
  const ownerSocket=process.env.CONCIERGE_OWNER_INTERNAL_SOCKET;
  const readWorkerEntry=process.env.CONCIERGE_READ_WORKER_ENTRY;
  if(!stateDir||!ownerSocket||!readWorkerEntry)throw new Error('The foreground gateway requires its private owner endpoint and sealed read executor.');
  // Configuration crosses the inherited private environment, never a command line.
  const peer=process.env.CONCIERGE_GATEWAY_PEER?JSON.parse(process.env.CONCIERGE_GATEWAY_PEER):null;
  delete process.env.CONCIERGE_GATEWAY_PEER;
  gateway=await startForegroundGateway({stateDir,ownerSocket,readWorkerEntry,peer,onContact:()=>process.send?.({kind:'peer-contact'})});
  if(stopping){await gateway.stop(true);process.exit(0);}
  process.send?.({kind:'ready',pid:process.pid});
} catch(error) {
  log('error','foreground_gateway_start_failed',errorFields(error));
  process.send?.({kind:'failed',message:error instanceof Error?error.message:'Gateway startup failed.'});
  process.exit(1);
}
