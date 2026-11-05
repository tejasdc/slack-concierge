/**
 * Proof of the Codex App Server relay (docs/architecture/RUNNERS.md, "Codex App Server on a
 * runner"): the real gateway, the real runner daemon, the real App Server bridge and Concierge's
 * App Server client, with a stand-in App Server on a scratch socket. The owner's client reaches the
 * runner's App Server only through the relay; a run token cannot pose as a runner; an App Server
 * that drops its connection drops the relay, and the client's next request opens a new one.
 * `--real-app-server` points the runner at this machine's real App Server and asks only
 * `model/list` (read-only), proving the relay against Codex itself.
 */
import {strict as assert} from 'node:assert';
import {chmod,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

if(process.env.CONCIERGE_READ_SOCKET&&process.argv.includes('--executor')) {
  const server=Bun.serve({unix:process.env.CONCIERGE_READ_SOCKET,idleTimeout:0,fetch:()=>Response.json({ok:true,pid:process.pid})});
  await chmod(process.env.CONCIERGE_READ_SOCKET,0o600);
  process.on('disconnect',()=>{server.stop(true);process.exit(0);});
  process.on('SIGTERM',()=>{server.stop(true);process.exit(0);});
} else {
  const root=await mkdtemp(join(tmpdir(),'concierge-codex-relay-'));
  const entry=join(root,'executor.ts');
  await Bun.write(entry,`process.argv.push('--executor'); await import(${JSON.stringify(import.meta.path)});`);
  const {agentTokenKey,mintAgentToken}=await import('../src/agent-run-tokens');
  const {startForegroundGateway}=await import('../src/foreground-gateway');
  const {CodexAppServerClient}=await import('../src/codex-app-server-client');
  const seen:string[]=[];
  const ownerSocket=join(root,'request-owner.sock');
  const owner=Bun.serve({unix:ownerSocket,idleTimeout:0,fetch:request=>{seen.push(new URL(request.url).pathname);return Response.json({ok:true,job:null});}});

  // A stand-in App Server: the same WebSocket-on-a-socket protocol the bridge speaks.
  const appSocket=join(root,'app-server-control.sock');
  let appConnections=0;
  const appServer=Bun.serve({unix:appSocket,fetch:(request,server)=>server.upgrade(request)?undefined:new Response('ws only',{status:400}),
    websocket:{open(){appConnections++;},message(socket,message){
      const request=JSON.parse(String(message));
      if(request.method==='initialize')socket.send(JSON.stringify({id:request.id,result:{userAgent:'stand-in'}}));
      else if(request.method==='model/list')socket.send(JSON.stringify({id:request.id,result:{data:[{id:'stand-in-model'}],connection:appConnections}}));
      else if(request.method==='test/drop')socket.close();
    }}});

  const key=agentTokenKey(root);
  const port=20_000+Math.floor(Math.random()*20_000);
  const gateway=await startForegroundGateway({stateDir:root,ownerSocket,readWorkerEntry:entry,peer:null,
    agent:{hostname:'127.0.0.1',port,keyHex:key.toString('hex')}});
  const tokenFile=join(root,'runner.token');
  await writeFile(tokenFile,mintAgentToken(key,{kind:'runner',runner:'ax41'}),{mode:0o600});
  const real=process.argv.includes('--real-app-server');
  const runner=Bun.spawn([process.execPath,'run',resolve(import.meta.dir,'runner.ts')],{stdout:'pipe',stderr:'pipe',
    env:{...process.env,CONCIERGE_OWNER_URL:`http://127.0.0.1:${port}`,CONCIERGE_RUNNER_TOKEN_FILE:tokenFile,CONCIERGE_RUNNER_NAME:'ax41',
      CONCIERGE_RUNNER_STATE:join(root,'runner'),CONCIERGE_RUNNER_KINDS:'codex',...(real?{}:{CONCIERGE_CODEX_APP_SERVER_SOCKET:appSocket})}});
  const client=new CodexAppServerClient(join(root,'requests.sock'),process.env.CONCIERGE_NODE_BIN||Bun.which('node')||'/usr/bin/node',
    {relayRunner:'ax41',bridgePath:resolve(import.meta.dir,'../src/codex-app-server-bridge.mjs')});
  const until=async(test:()=>boolean,what:string)=>{for(let i=0;i<100;i++){if(test())return;await Bun.sleep(100);}throw new Error(`timed out waiting for ${what}`);};
  try {
    // Only a runner token may open a listen channel.
    const run=mintAgentToken(key,{kind:'run',turnId:1,sessionId:1});
    const refused=await fetch(`http://127.0.0.1:${port}/runner/v1/relay/listen`,{headers:{authorization:`Bearer ${run}`,upgrade:'websocket',
      connection:'Upgrade','sec-websocket-key':'dGhlIHNhbXBsZSBub25jZQ==','sec-websocket-version':'13'}});
    assert.equal(refused.status,403,'A run token cannot pose as a runner.');
    assert.equal((await fetch(`http://127.0.0.1:${port}/runner/v1/relay/listen`)).status,401,'No token, no channel.');
    const unknown=await fetch('http://x/runner/v1/relay/connect?runner=other&target=codex-app-server',{unix:join(root,'requests.sock')} as RequestInit);
    assert.equal(unknown.status,503,'A runner with no channel open is refused at once.');

    await until(()=>gateway.relay().listening.includes('ax41'),'the runner to listen');
    if(real){
      const models=await client.request('model/list',{},{requestTimeoutMs:15_000});
      assert.ok(Array.isArray(models.data)&&models.data.length>0,JSON.stringify(models).slice(0,300));
      console.log(`codex relay (real App Server): model/list answered ${models.data.length} models through the runner: ${models.data.slice(0,3).map((m:any)=>m.id).join(', ')}`);
    } else {
    const first=await client.request('model/list',{},{requestTimeoutMs:10_000});
    assert.equal(first.data[0].id,'stand-in-model');
    assert.equal(first.connection,1);

    // The App Server drops its connection: the relay and the client's connection end with it.
    let dropped=false;
    client.onDisconnect(()=>{dropped=true;});
    await client.request('test/drop',{},{requestTimeoutMs:3_000}).catch(()=>null);
    await until(()=>dropped,'the client to see the drop');
    await until(()=>gateway.relay().relays===0,'the relay to end');
    const second=await client.request('model/list',{},{requestTimeoutMs:10_000});
    assert.equal(second.connection,2,'The next request opened a new relay to a new App Server connection.');
    assert.ok(!seen.some(path=>path.includes('/relay')),'Relay traffic never reaches the owner.');
    await client.close();
    await until(()=>gateway.relay().relays===0,'the closed client\'s relay to end');
    // A graceful stop (every owner update) is not held by the runner's open channel or a live relay.
    const held=new CodexAppServerClient(join(root,'requests.sock'),process.env.CONCIERGE_NODE_BIN||Bun.which('node')||'/usr/bin/node',
      {relayRunner:'ax41',bridgePath:resolve(import.meta.dir,'../src/codex-app-server-bridge.mjs')});
    await held.request('model/list',{},{requestTimeoutMs:10_000});
    assert.ok(gateway.relay().listening.includes('ax41')&&gateway.relay().relays===1);
    const stopping=Date.now();
    await gateway.stop(false);
    assert.ok(Date.now()-stopping<5_000,`A graceful stop took ${Date.now()-stopping} ms with a runner listening.`);
    await held.close().catch(()=>{});
    console.log('codex relay: run token refused, unknown runner refused, App Server reached through the runner, drop ended the relay, reconnect opened a new one, graceful stop not held');
    }
  } finally {
    runner.kill();
    await client.close().catch(()=>{});
    await gateway.stop(true);
    owner.stop(true);appServer.stop(true);
    await rm(root,{recursive:true,force:true});
  }
}
