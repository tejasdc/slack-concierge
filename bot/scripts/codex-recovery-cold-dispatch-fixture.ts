// Actual provider adapter with a disposable client; no native process or model.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const scratch=mkdtempSync(join(tmpdir(),'concierge-cold-dispatch-'));
process.env.CONCIERGE_STATE_DIR=scratch;
const {runCodexTurn}=await import('../src/codex');
const {CodexAppServerClientError}=await import('../src/codex-app-server-client');
try{
  for(const mode of ['accepted','cold-refused','construction-refused','ambiguous'] as const){
    const events:string[]=[],listeners=new Set<(event:any)=>void>();
    let boundParams:any;
    const response={thread:{id:'fixture-thread'},model:'gpt-6-astra',reasoningEffort:'medium'};
    const client={async connect(){return 1;},async request(method:string,params:any){
      events.push(method);
      if(method==='config/read')return {config:{}};
      if(method==='thread/resume'){
        const {__conciergeRecovery:authorization,...native}=params;
        assert.deepEqual(native,boundParams,'actual forwarded resume uses inspected parameters');
        assert.equal(authorization.authorizationId,'fixture-auth');
        if(mode==='ambiguous')throw new CodexAppServerClientError('lost resume reply','ambiguous');
        return response;
      }
      if(method==='turn/start'){
        assert.equal(params.model,'gpt-6-astra');assert.equal(params.effort,'medium');
        assert.ok(events.indexOf('constructed')<events.indexOf('turn/start'));
        queueMicrotask(()=>{for(const listener of listeners){
          listener({method:'item/started',params:{threadId:'fixture-thread',turnId:'fixture-turn',item:{type:'userMessage',clientId:params.clientUserMessageId}}});
          listener({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'fixture-turn',status:'completed',items:[]}}});
        }});
        return {turn:{id:'fixture-turn'}};
      }
      throw new Error(`unexpected ${method}`);
    },async notify(){},onNotification(listener:any){listeners.add(listener);return()=>listeners.delete(listener);},
    onDisconnect(){return()=>true;},waitForDisconnect(){return new Promise<void>(()=>{});}};
    const result=await runCodexTurn({prompt:'retained fixture input',cwd:scratch,additionalDirs:[],sessionUUID:'fixture-thread',
      model:'gpt-6-astra',reasoning_effort:'medium',appServerClient:client as any,
      clientUserMessageId:'slack-concierge:turn:9001:attempt:2',codexRecovery:{authorizationId:'fixture-auth',
        model:'gpt-6-astra',effort:'medium',beforeResume:async params=>{
          events.push('cold-inputs');boundParams=structuredClone(params);
          assert.deepEqual(params.config.features,{hooks:true});assert.equal(params.config.model_reasoning_effort,'medium');
          if(mode==='cold-refused')throw new Error('fixture cold refusal');
        },beforeStart:async actual=>{
          events.push('constructed');assert.deepEqual(actual.params,boundParams);assert.equal(actual.responseResult,response);
          if(mode==='construction-refused')throw new Error('fixture construction refusal');
        }}}).then(()=>null,error=>error);
    assert.equal(events.filter(e=>e==='thread/resume').length,mode==='cold-refused'?0:1);
    assert.equal(events.filter(e=>e==='turn/start').length,mode==='accepted'?1:0);
    assert.equal(result===null,mode==='accepted');
  }
  console.log('codex-recovery-cold-dispatch-fixture: PASS (actual resume/start adapter, exact Medium inputs/result, refusal and ambiguous no retry)');
}finally{rmSync(scratch,{recursive:true,force:true});}
process.exit(0);
