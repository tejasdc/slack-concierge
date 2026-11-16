import {deploymentLedgerMode} from './deployment-launch-authority';
import {deploymentOwnerJson} from './deployment-owner-fetch';
import type {RecoveryLedgerCommand} from './deployment-control-recovery-commands';
export async function controlRecoveryLedgerCommand(input:RecoveryLedgerCommand):Promise<ReturnType<typeof import('./deployment-control-recovery-commands').dispatchControlRecoveryCommand>>{
 if(await deploymentLedgerMode()==='legacy')return (await import('./deployment-control-recovery-commands')).dispatchControlRecoveryCommand(input);
 const {response,body}=await deploymentOwnerJson('/internal/deployment-control-recovery',{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),
 },{replaySafe:true});
 if(!response.ok)throw Error(`Serving owner refused controller recovery command: ${JSON.stringify(body)}`);
 return body;
}
