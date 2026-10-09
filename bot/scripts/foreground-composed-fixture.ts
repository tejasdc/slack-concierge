/** Private, authorized composition proof. No production listener, state, account home or provider is used. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {existsSync,writeFileSync} from 'node:fs';
import {chmod,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Database} from 'bun:sqlite';

const AUTH='foreground-isolation-5804d389';
const wait=async(check:()=>Promise<boolean>|boolean,ms=20_000)=>{
  const deadline=Date.now()+ms;
  while(Date.now()<deadline){if(await check())return;await Bun.sleep(100);}
  throw new Error('Composed fixture did not reach its expected state.');
};
const hold=(entered:string,release:string)=>{
  writeFileSync(entered,String(process.pid),{mode:0o600});
  const deadline=Date.now()+35_000;
  while(!existsSync(release)&&Date.now()<deadline)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
};
const socketFetch=(socket:string,path:string,init?:RequestInit)=>fetch('http://fixture'+path,{...init,unix:socket} as RequestInit);
const json=async(response:Response)=>({status:response.status,body:await response.json().catch(()=>null) as any});

async function ownerMode(root:string){
  const workspace=join(root,'workspace');
  const [{SessionOwner},{createNativeSession},{requestApiHandler},{startPresentationWorker}]=await Promise.all([
    import('../src/session-owner'),import('../src/session-inputs'),import('../src/routed-request-api'),
    import('../src/presentation-worker-supervisor')]);
  const session=createNativeSession('claude-code',{title:'Composed foreground fixture',cwd:workspace});
  const ephemera=()=>({observedAtMs:Date.now(),checking:false,usageRefreshing:false,
    codexSignIn:'unknown' as const,accountFallback:{codex:null,'claude-code':null},
    codexPending:false,claudePending:false,claudePendingFor:null,claudePendingUrl:null,
    lastSignIn:{codex:null,'claude-code':null}});
  const owner=new SessionOwner({available:()=>true,wake:()=>{},steer:()=>false,stop:async()=>false,
    auth:{ephemera,refreshEphemera:async()=>ephemera(),status:async()=>[] as any,
      start:async()=>({} as any),complete:async()=>({} as any),saveProfile:()=>[],switchProfile:()=>({} as any),
      useResetCredit:()=>({} as any)}},workspace);
  owner.inbox();
  const capture=owner.acceptInboxCapture({source:{kind:'thinkering',id:'foreground-fixture-root',recordedAt:'2026-10-09T00:00:00Z'},
    text:'Fixture Threads root with retained history',importOnly:true});
  const created=await owner.handle(new Request('http://fixture/sessions/v1/inbox/topics',{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify({clientActionId:'foreground-fixture-topic',
      title:'Composed fixture thread',roots:[capture.operation.id]})}));
  if(!created?.ok)throw new Error(`Fixture topic creation failed: ${await created?.text()}`);
  const topic=(await created!.json() as any).topic.topicId as string;
  const uploaded=await owner.handle(new Request('http://fixture/sessions/v1/attachments',{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify({clientActionId:'foreground-fixture-file',
      name:'fixture.txt',contentType:'text/plain',base64:Buffer.from('retained fixture attachment').toString('base64')})}));
  if(!uploaded?.ok)throw new Error(`Fixture attachment upload failed: ${await uploaded?.text()}`);
  const attachment=(await uploaded!.json() as any).attachment.id as string;
  const route=requestApiHandler(null,null,undefined,owner);
  const ownerSocket=join(root,'request-owner.sock');
  const server=Bun.serve({unix:ownerSocket,idleTimeout:0,fetch:request=>{
    const path=new URL(request.url).pathname;
    if(path==='/fixture/hold'){
      hold(join(root,'owner.entered'),join(root,'owner.release'));
      return Response.json({released:true});
    }
    if(path==='/supervisor/ping')return Response.json({ok:true,pid:process.pid,logging:{dropped:0}});
    if(path==='/internal/auth-ephemera')return Response.json(owner.authEphemera());
    if(path==='/internal/auth-refresh')return owner.refreshAuthEphemera().then(value=>Response.json(value));
    return route(request);
  }});
  await chmod(ownerSocket,0o600);
  const stopPresentation=startPresentationWorker();
  await writeFile(join(root,'owner-ready.json'),JSON.stringify({sessionId:`concierge:${session.id}`,topicId:topic,
    attachmentId:attachment,captureId:capture.operation.id,pid:process.pid}),{mode:0o600});
  process.on('SIGTERM',()=>{void Promise.all([server.stop(true),stopPresentation()]).finally(()=>process.exit(0));});
  await new Promise(()=>{});
}

async function gatewayMode(root:string){
  const gatewayModule=process.env.CONCIERGE_FIXTURE_GATEWAY_MODULE??resolve(import.meta.dir,'../src/foreground-gateway.ts');
  const {startForegroundGateway}=await import(gatewayModule);
  const peerPort=Number(process.env.CONCIERGE_FIXTURE_PEER_PORT);
  const peerToken=process.env.CONCIERGE_FIXTURE_PEER_TOKEN!;
  const gateway=await startForegroundGateway({stateDir:root,ownerSocket:join(root,'request-owner.sock'),
    readWorkerEntry:join(root,'read-wrapper.ts'),peer:{hostname:'127.0.0.1',port:peerPort,token:peerToken}});
  await writeFile(join(root,'gateway-ready'),String(process.pid),{mode:0o600});
  process.on('SIGTERM',()=>{void gateway.stop(true).finally(()=>process.exit(0));});
  await new Promise(()=>{});
}

async function main(){
  const root=await mkdtemp(join(tmpdir(),'concierge-foreground-composed-'));
  await chmod(root,0o700);
  const workspace=join(root,'workspace'),home=join(root,'home');
  await mkdir(join(workspace,'slack-inbox','.git'),{recursive:true});await mkdir(home);
  await writeFile(join(workspace,'slack-inbox','AGENTS.md'),'Scratch fixture project; no provider work.');
  await writeFile(join(workspace,'fixture.txt'),'Independent file read under owner stall.');
  const captureToken=randomUUID()+randomUUID(),peerToken=randomUUID()+randomUUID();
  const captureTokenFile=join(root,'capture-token');await writeFile(captureTokenFile,captureToken,{mode:0o600});
  const nativeWorker=resolve(import.meta.dir,'../src/native-read-worker.ts');
  await writeFile(join(root,'read-wrapper.ts'),`import {writeFileSync,existsSync} from 'node:fs';\n`+
    `process.on('SIGUSR2',()=>{const root=${JSON.stringify(root)};const entered=root+'/reader-'+process.pid+'.entered';`+
    `const release=root+'/reader-'+process.pid+'.release';writeFileSync(entered,'entered',{mode:0o600});`+
    `const until=Date.now()+35000;while(!existsSync(release)&&Date.now()<until)`+
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);});\n`+
    `await import(${JSON.stringify(nativeWorker)});\n`,{mode:0o600});
  const fixtureEnv={...process.env,HOME:home,CONCIERGE_STATE_DIR:root,CONCIERGE_CAPTURE_STATE_DIR:join(root,'capture'),
    CONCIERGE_WORKSPACE_ROOT:workspace,CONCIERGE_TEST_MODE:'1',CONCIERGE_TEST_AUTHORIZATION:AUTH};
  process.env.CONCIERGE_CAPTURE_STATE_DIR=join(root,'capture');
  process.env.CONCIERGE_TEST_MODE='1';
  process.env.CONCIERGE_TEST_AUTHORIZATION=AUTH;
  const children:Array<ReturnType<typeof Bun.spawn>>=[];
  const spawn=(mode:string,extra:Record<string,string>={})=>{
    const child=Bun.spawn([process.execPath,import.meta.path,mode,root],{env:{...fixtureEnv,...extra},
      stdin:'ignore',stdout:'inherit',stderr:'inherit'});
    children.push(child);return child;
  };
  let queue:ReturnType<typeof Bun.serve>|null=null;
  let worker:{stop:()=>Promise<void>}|null=null;
  let serveResolve:(value:unknown)=>void=()=>{};
  let serveReject:(reason:unknown)=>void=()=>{};
  const serveDone=new Promise((resolve,reject)=>{serveResolve=resolve;serveReject=reject;});
  try{
    const owner=spawn('--owner');
    await wait(()=>existsSync(join(root,'owner-ready.json'))&&owner.exitCode===null,30_000);
    const seeded=JSON.parse(await readFile(join(root,'owner-ready.json'),'utf8')) as any;
    const held=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('reserved')});
    const peerPort=held.port;await held.stop(true);
    const gateway=spawn('--gateway',{CONCIERGE_FIXTURE_PEER_PORT:String(peerPort),
      CONCIERGE_FIXTURE_PEER_TOKEN:peerToken});
    await wait(()=>existsSync(join(root,'gateway-ready'))&&gateway.exitCode===null,30_000);
    const socket=join(root,'requests.sock');
    const read=async(path:string)=>json(await socketFetch(socket,path));
    await wait(async()=>{const page=await read('/sessions/v1/presentation/topics');
      return page.status===200&&page.body?.coverage?.complete&&page.body.topics?.some((item:any)=>item.id===seeded.topicId);},25_000);
    const {createCaptureQueueRequestHandler}=await import('../src/capture-queue-api');
    queue=Bun.serve({hostname:'127.0.0.1',port:0,
      fetch:createCaptureQueueRequestHandler({host:'127.0.0.1',port:0,token:captureToken})});
    const captureUrl=`http://127.0.0.1:${queue.port}`;
    const {HumanCommandWorker}=await import('../src/human-command-worker');
    worker=new HumanCommandWorker({queueUrl:captureUrl,queueToken:captureToken,
      prepare:async command=>({status:200,value:{primaryBody:command.body}}),
      deliver:async(command,prepared:any)=>{
        const response=await socketFetch(socket,command.path,{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify(prepared.primaryBody),signal:AbortSignal.timeout(22_000)});
        return {status:response.status,value:await response.json()};
      }});
    worker.start();
    const control=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async request=>{
      const path=new URL(request.url).pathname;
      if(request.headers.get('authorization')!==`Bearer ${captureToken}`)return new Response('Unauthorized',{status:401});
      if(path==='/hold-owner'){
        void socketFetch(join(root,'request-owner.sock'),'/fixture/hold').catch(()=>{});
        await wait(()=>existsSync(join(root,'owner.entered')),2000);return Response.json({held:true});
      }
      if(path==='/release-owner'){await writeFile(join(root,'owner.release'),'release');return Response.json({released:true});}
      if(path==='/hold-reader'){
        const ping=await read('/supervisor/ping');assert.equal(ping.status,200);
        const pid=ping.body.readCapacity.readers[0].pid as number;
        process.kill(pid,'SIGUSR2');await wait(()=>existsSync(join(root,`reader-${pid}.entered`)),2000);
        return Response.json({held:true,pid});
      }
      if(path==='/release-reader'){
        const ping=await read('/supervisor/ping');const pid=ping.body.readCapacity.readers[0].pid as number;
        await writeFile(join(root,`reader-${pid}.release`),'release');return Response.json({released:true,pid});
      }
      return new Response('Unknown control',{status:404});
    }});
    const configPath=join(root,'fixture-config.json');
    await writeFile(configPath,JSON.stringify({ownerSocket:socket,captureUrl,captureTokenFile,
      sessionId:seeded.sessionId,topicId:seeded.topicId,attachmentId:seeded.attachmentId,
      threadsRoute:'/sessions/v1/presentation/topics',historyRoute:`/sessions/v1/sessions/${encodeURIComponent(seeded.sessionId)}/history`,
      controlUrl:`http://127.0.0.1:${control.port}`,controlTokenFile:captureTokenFile,peerPort}),{mode:0o600});
    console.log(JSON.stringify({fixture:'foreground-composed',phase:'ready',configPath,pid:process.pid}));
    if(process.argv.includes('--serve')){
      process.on('SIGTERM',()=>serveResolve(null));await serveDone;
    } else {
      const measured=[] as Array<{route:string;ms:number;status:number}>;
      const check=async(route:string,expected=200)=>{const started=performance.now();const response=await read(route);
        measured.push({route:route.split('?')[0],ms:Math.round(performance.now()-started),status:response.status});
        assert.equal(response.status,expected,JSON.stringify(response.body));return response.body;};
      const topic=await check('/sessions/v1/presentation/topics');
      assert.ok(topic.topics.some((item:any)=>item.id===seeded.topicId));
      const attachment=await check(`/sessions/v1/attachments/${encodeURIComponent(seeded.attachmentId)}`);
      assert.equal(Buffer.from(attachment.base64,'base64').toString(),'retained fixture attachment');
      await check(`/sessions/v1/sessions/${encodeURIComponent(seeded.sessionId)}/history`);
      await check('/sessions/v1/presentation/sessions/window?space=everyday');
      const peerWrong=await fetch(`http://127.0.0.1:${peerPort}/sessions/v1/models`,{headers:{authorization:'Bearer invalid'}});
      assert.equal(peerWrong.status,401);
      const peerRight=await fetch(`http://127.0.0.1:${peerPort}/sessions/v1/models`,{headers:{authorization:`Bearer ${peerToken}`}});
      assert.equal(peerRight.status,200);
      const auth=await check('/sessions/v1/auth/providers?machine=cloud');
      assert.equal(auth.providers.length,2);
      const writeProbe=Bun.spawn([process.execPath,'-e',
        `import {db} from ${JSON.stringify(resolve(import.meta.dir,'../src/state-database.ts'))};`+
        `try{db.exec('CREATE TABLE fixture_forbidden_write (id INTEGER)');process.exit(1)}`+
        `catch(error){if(!/readonly|read-only/i.test(String(error)))process.exit(2);console.log('readonly-refused')}`],
        {env:{...fixtureEnv,CONCIERGE_READ_WORKER:'1'},stdin:'ignore',stdout:'pipe',stderr:'pipe'});
      const writeEvidence=await new Response(writeProbe.stdout).text();
      assert.equal(await writeProbe.exited,0,'Read-worker SQLite connection accepted a write.');
      assert.ok(writeEvidence.includes('readonly-refused'));
      const ownerHoldStarted=performance.now();
      const ownerHold=socketFetch(join(root,'request-owner.sock'),'/fixture/hold');
      await wait(()=>existsSync(join(root,'owner.entered')),2000);
      const actionId='foreground-fixture-command';
      const command={version:1,clientId:'foreground-fixture-client',sessionId:seeded.sessionId,sequence:1,
        actionId,door:'web',method:'POST',path:`/sessions/v1/sessions/${encodeURIComponent(seeded.sessionId)}/inputs`,
        body:{clientActionId:actionId,text:'Retained exactly once during owner stall',delivery:'queue',door:'web'}};
      const capture=(path:string,init?:RequestInit)=>fetch(captureUrl+path,{...init,
        headers:{authorization:`Bearer ${captureToken}`,...init?.headers}});
      const retained=await capture('/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(command)});
      assert.equal(retained.status,202);
      assert.ok(['pending','delivering'].includes((await retained.json() as any).status));
      const duplicate=await capture('/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(command)});
      assert.equal(duplicate.status,202);
      assert.equal((await duplicate.json() as any).actionId,actionId);
      const ownerReads=await Promise.all(['/sessions/v1/presentation/topics',
        `/sessions/v1/attachments/${encodeURIComponent(seeded.attachmentId)}`,
        `/sessions/v1/sessions/${encodeURIComponent(seeded.sessionId)}/history`,
        '/sessions/v1/presentation/sessions/window?space=everyday'].map(path=>check(path)));
      assert.equal(ownerReads.length,4);
      const unavailableAuth=await check('/sessions/v1/auth/providers?machine=cloud',503);
      assert.equal(unavailableAuth.error?.code,'AUTH_EPHEMERA_UNAVAILABLE');
      const unhealthy=await check('/supervisor/ping',503);assert.ok(unhealthy);
      const stillRetained=await capture(`/commands/${actionId}`);
      assert.ok(['pending','delivering'].includes((await stillRetained.json() as any).status));
      await ownerHold;
      const ownerStallMs=Math.round(performance.now()-ownerHoldStarted);
      assert.ok(ownerStallMs>=34_000,`Canonical synchronous stall lasted only ${ownerStallMs}ms`);
      let custody:any;
      await wait(async()=>{const answer=await capture(`/commands/${actionId}`);custody=await answer.json();
        return custody.status==='delivered';},20_000);
      const state=new Database(join(root,'state.db'),{readonly:true});
      try{
        const count=state.query("SELECT COUNT(*) AS n FROM session_inputs WHERE scope='surface:thinkering' AND action_id=?")
          .get(actionId) as {n:number};
        assert.equal(count.n,1,'Retry after the owner stall must commit one exact input.');
      }finally{state.close();}
      assert.ok(custody.ownerStatus>=200&&custody.ownerStatus<300,JSON.stringify(custody));
      const healthy=await check('/supervisor/ping');assert.equal(healthy.ok,true);
      const readerPid=healthy.readCapacity.readers[0].pid as number;
      process.kill(readerPid,'SIGUSR2');await wait(()=>existsSync(join(root,`reader-${readerPid}.entered`)),2000);
      const readerBatchStarted=performance.now();
      const readerBatch=await Promise.all(Array.from({length:8},async()=>{
        const started=performance.now();
        try {const response=await socketFetch(socket,'/sessions/v1/presentation/topics',
          {signal:AbortSignal.timeout(1500)});
          return {status:response.status,ms:Math.round(performance.now()-started),body:await response.json() as any};}
        catch{return {status:0,ms:Math.round(performance.now()-started),body:null};}
      }));
      const independent=readerBatch.filter(item=>item.status===200&&item.body?.topics?.length>0);
      assert.ok(independent.length>=7,`One blocked reader held unrelated reads: ${JSON.stringify(readerBatch)}`);
      assert.ok(Math.max(...independent.map(item=>item.ms))<1400,JSON.stringify(readerBatch));
      assert.ok(performance.now()-readerBatchStarted<2000,'Other reader waited for the synchronous stall.');
      await wait(async()=>{const value=await read('/supervisor/ping');return value.status===200&&
        value.body.readCapacity.readers[0].pid!==readerPid;},25_000);
      const readyAgain=await check('/sessions/v1/presentation/topics');assert.ok(readyAgain.topics.length);
      const beforeExit=await check('/supervisor/ping');
      const childPid=beforeExit.readCapacity.readers[1].pid as number;
      process.kill(childPid,'SIGKILL');
      await wait(async()=>{const value=await read('/supervisor/ping');return value.status===200&&
        value.body.readCapacity.readers[1].pid!==childPid;},10_000);
      const afterExit=await check('/sessions/v1/presentation/topics');
      assert.ok(afterExit.topics.length,'An independent reader must survive sibling exit.');
      await wait(async()=>{const value=await read('/supervisor/ping');return value.status===200&&
        value.body.readCapacity.readers[1].pid!==childPid&&value.body.readCapacity.ready===2;},10_000);
      console.log(JSON.stringify({fixture:'foreground-composed',status:'passed',measured,peerUnauthorized:peerWrong.status,
        readerRetired:readerPid,canonicalStallMs:ownerStallMs,independentReaderReads:independent.length,
        independentReaderMaxMs:Math.max(...independent.map(item=>item.ms)),
        custody:{status:custody.status,ownerStatus:custody.ownerStatus,actionId:custody.actionId},
        readonlyWriteRefused:true,authDuringOwnerStall:unavailableAuth.error.code,readerExitRecovered:childPid}));
    }
    await control.stop(true);
  }catch(error){serveReject(error);throw error;}
  finally{
    await worker?.stop().catch(()=>{});await queue?.stop(true);
    for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');
    await Promise.all(children.map(child=>child.exited.catch(()=>{})));
    if(!process.argv.includes('--keep'))await rm(root,{recursive:true,force:true});
  }
}

if(process.argv[2]==='--owner')await ownerMode(process.argv[3]!);
else if(process.argv[2]==='--gateway')await gatewayMode(process.argv[3]!);
else await main();
