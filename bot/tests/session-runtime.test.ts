import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('actual Slack-free runtime starts, retains authenticated owner operations and restarts without any Slack configuration',async()=>{
  const root=mkdtempSync(join(tmpdir(),'concierge-native-runtime-'));
  const state=join(root,'state'),ready=join(state,'ready.json'),socket=join(state,'requests.sock');
  mkdirSync(state,{recursive:true});
  const environment={...process.env,CONCIERGE_RUNTIME_PROFILE:'sandbox',CONCIERGE_TEST_MODE:'1',CONCIERGE_SLACK_ENABLED:'0',
    CONCIERGE_STATE_DIR:state,CONCIERGE_WORKSPACE_ROOT:join(root,'workspace'),CONCIERGE_SANDBOX_RUN_ID:'native-runtime-test',
    CONCIERGE_SANDBOX_LANE:'1',CONCIERGE_SANDBOX_READY_FILE:ready};
  for(const key of Object.keys(environment))if(key.includes('SLACK')&&key!=='CONCIERGE_SLACK_ENABLED'||key==='CONCIERGE_CONFIG_PATH'||key==='CONCIERGE_SESSION_CAPABILITY_SOCKET'||key.startsWith('CONCIERGE_CAPTURE_')||key.startsWith('CONCIERGE_SANDBOX_EXPECTED_'))delete environment[key];
  let child:ReturnType<typeof Bun.spawn>|null=null,output:Promise<string>|null=null;
  const start=async()=>{
    child=Bun.spawn([process.execPath,'src/index.ts'],{cwd:join(import.meta.dir,'..'),env:environment,stdout:'pipe',stderr:'pipe'});
    output=Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]).then(parts=>parts.join('\n'));
    const until=Date.now()+10000;
    while(!existsSync(ready)||JSON.parse(readFileSync(ready,'utf8')).pid!==child.pid){if(child.exitCode!==null)throw new Error(await output);if(Date.now()>until)throw new Error('Native readiness was not emitted');await Bun.sleep(10);}
    const proof=JSON.parse(readFileSync(ready,'utf8'));
    expect(proof).toMatchObject({pid:child.pid,run_id:'native-runtime-test',slack_enabled:false,owner_socket:socket});
    expect(proof.team_id).toBeUndefined();
  };
  const stop=async()=>{if(!child)return;child.kill('SIGTERM');const code=await child.exited;const log=await output;child=null;expect(code,log??undefined).toBe(0);expect(existsSync(ready)).toBeFalse();};
  const call=async(path:string,body?:any)=>{const response=await fetch('http://owner/sessions/v1/'+path,{unix:socket,...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};};
  try {
    await start();
    const created=await call('sessions',{clientActionId:'create-native',provider:'codex',purpose:'chat',title:'No Slack surface'});
    expect(created.status).toBe(202);
    const id=created.body.session.id;
    const archived=await call('sessions/'+id+'/actions',{clientActionId:'archive',action:{kind:'archive'}});
    expect(archived.body.session.archived).toBeTrue();
    const held=await call('sessions/'+id+'/inputs',{clientActionId:'held-human',text:'Retained without dispatch'});
    expect(held.body.operation.state).toBe('waiting');
    const canceled=await call('operations/'+held.body.operation.operationId+'/cancel',{clientActionId:'cancel-held'});
    expect(canceled.body.operation.state).toBe('canceled');
    const unavailable=await call('sessions',{clientActionId:'unavailable-chatgpt',provider:'chatgpt',purpose:'chat',firstInput:{text:'Do not substitute a provider'}});
    expect(unavailable.body.operation).toMatchObject({state:'failed'});
    expect(unavailable.body.session.provider).toBe('chatgpt');
    await stop();await start();
    child!.kill('SIGKILL');
    expect(await child!.exited).not.toBe(0);
    await output;
    child=null;
    expect(lstatSync(socket).isSocket()).toBeTrue();
    await start();
    const retained=await call('sessions/'+id);
    expect(retained.body.session).toMatchObject({id,archived:true,title:'No Slack surface'});
    expect(retained.body.operations.some((operation:any)=>operation.operationId===held.body.operation.operationId&&operation.state==='canceled')).toBeTrue();
    const store=new Database(join(state,'state.db'),{readonly:true});
    try {
      expect(store.query('SELECT count(*) AS n FROM turns').get()).toEqual({n:0});
      expect(store.query('SELECT count(*) AS n FROM slack_user_input_claims').get()).toEqual({n:0});
      expect(store.query('SELECT count(*) AS n FROM session_communication_requests').get()).toEqual({n:0});
    }finally{store.close();}
    await stop();
  }finally{
    if(child){child.kill('SIGTERM');await child.exited;await output;}
    rmSync(root,{recursive:true,force:true});
  }
},30000);
