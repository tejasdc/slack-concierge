import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {agentTokenKey,mintAgentToken} from '../../src/agent-run-tokens';
import {startForegroundGateway} from '../../src/foreground-gateway';
import {CodexAppServerClient} from '../../src/codex-app-server-client';

/** Production client -> bridge -> foreground gateway -> runner.ts -> actual native socket.
 * Native/provider semantics belong to the caller's isolated server, never to this harness. */
export async function createCustodyRelayFixture(root:string,nativeSocket:string,options:{runnerEntry?:string;runnerEnvironment?:Record<string,string>}={}) {
  if(!nativeSocket.startsWith(root+'/'))throw new Error('fixture native socket must belong to fixture root');
  delete process.env.THINKERING_CAPABILITY_URL;
  const entry=join(root,'fixture-read-worker.ts');
  writeFileSync(entry,`const server=Bun.serve({unix:process.env.CONCIERGE_READ_SOCKET,fetch:()=>Response.json({ok:true,pid:process.pid})}); process.on('disconnect',()=>{server.stop(true);process.exit(0);});`);
  const ownerSocket=join(root,'fixture-owner.sock');
  const owner=Bun.serve({unix:ownerSocket,fetch:()=>Response.json({ok:true,job:null})});
  const key=agentTokenKey(root);
  // Allocate before choosing the actual foreground gateway's port.
  const allocation=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
  const port=allocation.port!;await allocation.stop(true);
  const gateway=await startForegroundGateway({stateDir:root,ownerSocket,readWorkerEntry:entry,peer:null,agent:{hostname:'127.0.0.1',port,keyHex:key.toString('hex')}});
  const tokenFile=join(root,'fixture-runner.token');
  writeFileSync(tokenFile,mintAgentToken(key,{kind:'runner',runner:'ax41'}),{mode:0o600});
  const runnerState=join(root,'runner');mkdirSync(runnerState,{recursive:true});
  const environment={...process.env,HOME:join(root,'home'),CODEX_HOME:join(root,'codex'),CONCIERGE_OWNER_URL:`http://127.0.0.1:${port}`,
    CONCIERGE_RUNNER_TOKEN_FILE:tokenFile,CONCIERGE_RUNNER_NAME:'ax41',CONCIERGE_RUNNER_STATE:runnerState,
    CONCIERGE_RUNNER_KINDS:'codex',CONCIERGE_NODE_BIN:process.env.CONCIERGE_NODE_BIN||Bun.which('node')||'/usr/bin/node',CONCIERGE_CODEX_APP_SERVER_SOCKET:nativeSocket,...options.runnerEnvironment};
  const runners:ReturnType<typeof Bun.spawn>[]=[];
  const spawnRunner=()=>{
    const runner=Bun.spawn([process.execPath,'run',options.runnerEntry??resolve(import.meta.dir,'../runner.ts')],{stdout:'pipe',stderr:'pipe',env:environment});
    runners.push(runner);return runner;
  };
  const runner=spawnRunner();
  const deadline=Date.now()+10_000;
  while(!gateway.relay().listening.includes('ax41')){
    if(runner.exitCode!==null)throw new Error(`fixture runner exited: ${await new Response(runner.stderr).text()}`);
    if(Date.now()>deadline)throw new Error('fixture runner did not listen');
    await Bun.sleep(20);
  }
  const clients:CodexAppServerClient[]=[];
  const client=(protectedRelay=true)=>{
    const client=new CodexAppServerClient(join(root,'requests.sock'),process.env.CONCIERGE_NODE_BIN||Bun.which('node')||'/usr/bin/node',
      {relayRunner:'ax41',protectedRelay,manageDaemon:false,bridgePath:resolve(import.meta.dir,'../../src/codex-app-server-bridge.mjs')});
    clients.push(client);return client;
  };
  return {gateway,runner,runnerState,client,spawnRunner,port,tokenFile,async close(){
    await Promise.all(clients.map(client=>client.close().catch(()=>{})));
    for(const runner of runners)runner.kill();
    await Promise.all(runners.map(runner=>runner.exited));
    await gateway.stop(true);owner.stop(true);
  }};
}
