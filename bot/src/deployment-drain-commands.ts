import {db} from './state-database';
import {isProcessIdentityAlive} from './runtime-identity';

type Identity={pid:number;bootId:string;startTicks:string};
type Gate={token:string;owner_pid:number;owner_boot_id:string;owner_start_ticks:string};
export function deploymentDrainCommand(input:{operation:string;token?:string;identity?:Identity}):{status:string;code:number;claimed?:boolean;token?:string}{
 return db.transaction(()=>{
  const gate=db.query('SELECT * FROM deployment_drain WHERE singleton=1').get() as Gate|null;
  if(input.operation==='claim'){
   if(!/^[a-f0-9-]{36}$/.test(input.token??'')||!input.identity||!isProcessIdentityAlive(input.identity))throw Error('A live exact deployment identity is required.');
   if(gate){
    const matches=gate.token===input.token&&gate.owner_pid===input.identity.pid&&gate.owner_boot_id===input.identity.bootId&&gate.owner_start_ticks===input.identity.startTicks;
    return{status:matches?'claimed':'error',code:matches?0:1,claimed:matches,token:input.token};
   }
   db.query('INSERT INTO deployment_drain(singleton,token,owner_pid,owner_boot_id,owner_start_ticks) VALUES(1,?,?,?,?)')
    .run(input.token,input.identity.pid,input.identity.bootId,input.identity.startTicks);
   return{status:'claimed',code:0,claimed:true,token:input.token};
  }
  if(input.operation==='release'){
   if(!/^[a-f0-9-]{36}$/.test(input.token??''))throw Error('An exact drain token is required.');
   if(!gate||gate.token!==input.token)return{status:'error',code:1};
   db.query('DELETE FROM deployment_drain WHERE singleton=1 AND token=?').run(input.token);
   return{status:'released',code:0,token:input.token};
  }
  if(input.operation==='recover'){
   if(!gate)return{status:'clear',code:0};
   if(isProcessIdentityAlive({pid:gate.owner_pid,bootId:gate.owner_boot_id,startTicks:gate.owner_start_ticks}))return{status:'active',code:10};
   db.query('DELETE FROM deployment_drain WHERE singleton=1 AND token=?').run(gate.token);
   return{status:'recovered',code:0};
  }
  throw Error('Unknown deployment drain operation.');
 }).immediate();
}
