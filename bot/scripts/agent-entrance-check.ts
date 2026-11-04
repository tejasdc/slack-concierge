/**
 * Proof of the agents' network entrance (docs/architecture/RUNNERS.md): the real gateway, a
 * synthetic owner socket and synthetic read executors. A forged, expired or missing token is
 * refused before the owner sees it; a run token reaches the owner naming its run, and the
 * agents' own client takes the network path when its run carries an owner address.
 */
import {strict as assert} from 'node:assert';
import {chmod,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

if(process.env.CONCIERGE_READ_SOCKET&&process.argv.includes('--executor')) {
  const server=Bun.serve({unix:process.env.CONCIERGE_READ_SOCKET,idleTimeout:0,fetch:()=>Response.json({ok:true,pid:process.pid})});
  await chmod(process.env.CONCIERGE_READ_SOCKET,0o600);
  process.on('disconnect',()=>{server.stop(true);process.exit(0);});
  process.on('SIGTERM',()=>{server.stop(true);process.exit(0);});
} else {
  const root=await mkdtemp(join(tmpdir(),'concierge-agent-entrance-'));
  const entry=join(root,'executor.ts');
  await Bun.write(entry,`process.argv.push('--executor'); await import(${JSON.stringify(import.meta.path)});`);
  const {agentTokenKey,mintAgentToken,verifyAgentToken,agentRunEnvironment}=await import('../src/agent-run-tokens');
  const {startForegroundGateway}=await import('../src/foreground-gateway');
  const seen:{path:string;principal:string|null;authorization:string|null}[]=[];
  const ownerSocket=join(root,'request-owner.sock');
  const owner=Bun.serve({unix:ownerSocket,idleTimeout:0,fetch:async request=>{
    seen.push({path:new URL(request.url).pathname,principal:request.headers.get('x-concierge-agent-principal'),
      authorization:request.headers.get('authorization')});
    return Response.json({ok:true,body:request.method==='POST'?await request.json():null});
  }});
  const key=agentTokenKey(root);
  assert.equal(agentTokenKey(root).toString('hex'),key.toString('hex'),'The key is stable once created.');
  const port=20_000+Math.floor(Math.random()*20_000);
  const gateway=await startForegroundGateway({stateDir:root,ownerSocket,readWorkerEntry:entry,peer:null,
    agent:{hostname:'127.0.0.1',port,keyHex:key.toString('hex')}});
  const call=(token:string|null,body?:unknown)=>fetch(`http://127.0.0.1:${port}/session-communication/check`,{
    method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body??{})});
  try {
    const run=mintAgentToken(key,{kind:'run',turnId:42,sessionId:7});
    assert.deepEqual({...verifyAgentToken(key,run),expiresAtMs:0},{kind:'run',turnId:42,sessionId:7,expiresAtMs:0});
    assert.equal(verifyAgentToken(key,run,Date.now()+9*24*3600_000),null,'A run token ends after its lifetime.');
    const forged=run.slice(0,-4)+(run.endsWith('AAAA')?'BBBB':'AAAA');
    const otherKey=mintAgentToken(Buffer.alloc(32,1),{kind:'run',turnId:42,sessionId:7});
    for(const token of [null,'nonsense',forged,otherKey]) {
      const refused=await call(token);
      assert.equal(refused.status,401,`Refused token ${token}`);
    }
    assert.equal(seen.length,0,'A refused call never reaches the owner.');
    const accepted=await call(run,{action_id:'a1'});
    assert.equal(accepted.status,200);
    assert.deepEqual(seen.at(-1),{path:'/session-communication/check',principal:'run:7:42',authorization:null});
    const spoofed=await fetch(`http://127.0.0.1:${port}/session-communication/check`,{method:'POST',
      headers:{authorization:`Bearer ${mintAgentToken(key,{kind:'runner',runner:'ax41'})}`,'x-concierge-agent-principal':'run:1:1'},body:'{}'});
    assert.equal(spoofed.status,200);
    assert.equal(seen.at(-1)!.principal,'runner:ax41','A caller cannot name its own principal.');
    assert.equal((await fetch(`http://127.0.0.1:${port}/internal/auth-ephemera`,{headers:{authorization:`Bearer ${run}`}})).status,404,
      'Process control stays unreachable from the network.');

    // The agents' client: a run whose owner names a network address uses it with its own token.
    const environment=agentRunEnvironment({turnId:43,sessionId:7},{CONCIERGE_STATE_DIR:root,CONCIERGE_AGENT_API_URL:`http://127.0.0.1:${port}`});
    assert.equal(verifyAgentToken(key,environment.CONCIERGE_AGENT_TOKEN!)?.kind,'run');
    Object.assign(process.env,environment,{CONCIERGE_STATE_DIR:join(root,'no-local-owner'),CONCIERGE_STATE_DB:join(root,'no-local-owner','state.db')});
    const {requestApiResponse}=await import('./router-request-client');
    const response=await requestApiResponse('/session-communication/check',{action_id:'a2'});
    assert.equal(response.status,200,JSON.stringify(response));
    assert.equal(seen.at(-1)!.principal,'run:7:43');
    assert.deepEqual(agentRunEnvironment({turnId:1,sessionId:1},{}),{},'Without a state directory nothing is minted.');
    assert.equal(agentRunEnvironment({turnId:1,sessionId:1},{CONCIERGE_STATE_DIR:root}).CONCIERGE_OWNER_URL,undefined,
      'Without a network address runs keep the local socket.');
    console.log('agent entrance: refused 4 bad tokens, forwarded run and runner principals, client used the network entrance');
  } finally {
    await gateway.stop(true);
    owner.stop(true);
    await rm(root,{recursive:true,force:true});
  }
}
