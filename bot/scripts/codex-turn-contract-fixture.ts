import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const scratch=mkdtempSync(join(tmpdir(),'concierge-codex-turn-contract-'));
process.env.CONCIERGE_STATE_DIR=scratch;
const {runCodexTurn}=await import('../src/codex');
const {ProviderDispatchError}=await import('../src/provider-failures');
function fixture(acknowledge:boolean){
  const listeners=new Set<(event:any)=>void>();
  const calls:Array<{method:string;params:any}>=[];
  const client={
    async connect(){return 1;},
    async request(method:string,params:any){
      calls.push({method,params});
      if(method==='thread/resume')return {thread:{id:params.threadId},model:'gpt-6-astra'};
      if(method==='turn/start'){
        queueMicrotask(()=>{for(const listener of listeners)listener({method:'turn/completed',params:{threadId:params.threadId,
          turn:{id:'native-turn',status:'completed',error:null,items:acknowledge?[{type:'userMessage',clientId:params.clientUserMessageId}]:[]}}});});
        return {turn:{id:'native-turn'}};
      }
      throw new Error(`unexpected App Server call ${method}`);
    },
    async notify(){},
    onNotification(listener:(event:any)=>void){listeners.add(listener);return ()=>listeners.delete(listener);},
    onDisconnect(){return ()=>true;},waitForDisconnect(){return new Promise<void>(()=>{});},
  };
  return {client,calls};
}
try{
  const accepted=fixture(true);
  await runCodexTurn({prompt:'preserved accepted input',cwd:scratch,additionalDirs:[],sessionUUID:'thread-exact',
    appServerClient:accepted.client as any,reasoning_effort:'xhigh',clientUserMessageId:'slack-concierge:turn:30033:attempt:1'});
  const resume=accepted.calls.find(call=>call.method==='thread/resume')!.params;
  const start=accepted.calls.find(call=>call.method==='turn/start')!.params;
  assert.equal('reasoningEffort' in resume,false,'thread/resume does not receive an unsupported effort field');
  assert.equal(start.effort,'xhigh','the selected effort is sent to the actual native turn');

  const blocked=fixture(false);
  const failure=await runCodexTurn({prompt:'retained input',cwd:scratch,additionalDirs:[],sessionUUID:'thread-exact',
    appServerClient:blocked.client as any,reasoning_effort:'xhigh',clientUserMessageId:'slack-concierge:turn:30033:attempt:2'})
    .then(()=>null,error=>error);
  assert.ok(failure instanceof ProviderDispatchError);
  assert.equal(failure.failureClass,'parked_terminal');
  assert.equal(failure.terminalConfirmed,true);
  assert.equal(failure.providerSessionId,'thread-exact');
  assert.equal(failure.providerTurnId,'native-turn');
  assert.match(failure.message,/CODEX_INPUT_NOT_ACKNOWLEDGED/);
  assert.match(failure.message,/original input is preserved/);
  console.log('Codex turn contract: xhigh reaches turn/start; empty unacknowledged terminal turns surface recoverable failure');
}finally{rmSync(scratch,{recursive:true,force:true});}
