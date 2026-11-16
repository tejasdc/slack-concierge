import {strict as assert} from 'node:assert';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {RunnerRelay} from '../src/runner-relay';
import {CodexAppServerClient} from '../src/codex-app-server-client';

// Call the real gateway handlers synchronously so only THEIR JSON.parse calls are counted.
// Sockets are explicit transport substitutes; the bridge cases below use real Unix WebSockets.
for(const protectedMode of [false,true]){
  const relay=new RunnerRelay(),handlers=relay.handlers as any;
  const socket=(data:any)=>({data,sent:[] as any[],closed:[] as any[],send(message:any){this.sent.push(message);return 1;},close(...args:any[]){this.closed.push(args);}});
  const listener=socket({role:'listen',runner:'fixture'});handlers.open(listener);
  const local=socket({role:'local',runner:'fixture',id:'pair-fixture',challenge:'challenge-fixture',target:protectedMode?'codex-app-server-protected-v1':'codex-app-server'});handlers.open(local);
  const remote=socket({role:'accept',runner:'fixture',id:'pair-fixture'});handlers.open(remote);
  const receipt={conciergeRelay:'association-v1',association:{version:1,pairId:'pair-fixture',challenge:'challenge-fixture',runner:'fixture',protected:true}};
  const parse=JSON.parse;let calls=0;
  JSON.parse=((...args:Parameters<typeof JSON.parse>)=>{calls++;return parse(...args);}) as typeof JSON.parse;
  try{
    if(protectedMode)handlers.message(remote,JSON.stringify(receipt));
    const expected=protectedMode?1:0;
    assert.equal(calls,expected);
    const payload='{"method":"thread/read","result":"'+'z'.repeat(2*1024*1024)+'"}';
    const binary=Buffer.from('binary native frame without JSON');
    handlers.message(remote,payload);handlers.message(remote,binary);
    assert.equal(calls,expected,'gateway must parse zero native-stream frames after its first protected control frame');
    assert.equal(local.sent.at(-2),payload);assert.equal(local.sent.at(-1),binary,'binary stream object passes unchanged');
    handlers.message(remote,JSON.stringify(receipt));
    assert.equal(calls,expected,'late canonical receipt rejection must inspect only the reserved prefix');
    assert.ok(local.closed.length>0,'late canonical receipt closes the pair');
    if(protectedMode){
      const missingLocal=socket({role:'local',runner:'fixture',id:'missing-first',challenge:'missing-challenge',target:'codex-app-server-protected-v1'});handlers.open(missingLocal);
      const missingRemote=socket({role:'accept',runner:'fixture',id:'missing-first'});handlers.open(missingRemote);
      handlers.message(missingRemote,'{"method":"native-before-association"}');
      assert.equal(calls,expected,'a non-control first frame is refused by prefix without parsing');
      assert.ok(missingLocal.closed.length>0);assert.equal(missingLocal.sent.length,0);
    }
  }finally{JSON.parse=parse;relay.closeAll();}
}

const root=mkdtempSync(join(tmpdir(),'relay-one-shot-'));
const clients:CodexAppServerClient[]=[];
try{
  for(const mode of ['ordinary','protected','protected-missing-first']){
    const protectedMode=mode!=='ordinary';
    const path=join(root,mode+'.sock');let accepted:any;let initial:any;
    const server=Bun.serve<{challenge:string}>({unix:path,fetch(request,server){const url=new URL(request.url);return server.upgrade(request,{data:{challenge:url.searchParams.get('challenge')??''}})?undefined:new Response('ws only');},websocket:{
      open(socket){accepted=socket;initial={version:1,pairId:'bridge-fixture',challenge:socket.data.challenge,runner:'fixture',protected:true};
        if(mode==='protected-missing-first')socket.send(JSON.stringify({method:'native-before-association'}));
        else if(protectedMode)socket.send(JSON.stringify({conciergeRelay:'association-v1',association:initial}));},
      message(socket,data){const frame=JSON.parse(String(data));if(frame.method==='initialize')socket.send(JSON.stringify({id:frame.id,result:{userAgent:'native-response-substitute'}}));}
    }});
    const client=new CodexAppServerClient(path,process.env.CONCIERGE_NODE_BIN||Bun.which('node')||'/usr/bin/node',{relayRunner:'fixture',protectedRelay:protectedMode,manageDaemon:false,bridgePath:resolve(import.meta.dir,'../src/codex-app-server-bridge.mjs')});clients.push(client);
    try{
      if(mode==='protected-missing-first'){await assert.rejects(client.connect(),/association mismatch/i);continue;}
      await client.connect();const retained=client.nativeEndpoint.relayAssociation;
      let ended!:()=>void;const disconnected=new Promise<void>(resolve=>{ended=resolve;});client.onDisconnect(()=>ended());
      // Reordered keys evade the canonical gateway prefix, but the bridge's one-shot check
      // must still reject this rather than installing or replacing the generation receipt.
      accepted.send(JSON.stringify({association:{...initial,pairId:'late-replacement'},conciergeRelay:'association-v1'}));
      await disconnected;
      assert.equal(retained?.pairId,protectedMode?'bridge-fixture':undefined);
      assert.equal(client.activeGeneration,null,'late receipt must revoke connection authority');
    }finally{await client.close();server.stop(true);}
  }
  console.log(JSON.stringify({ok:true,check:'relay-protocol',gatewayParseCalls:{ordinary:0,protectedFirstFrame:1,afterFirst:0},
    assertions:['ordinary and post-receipt payloads forwarded unchanged','late canonical receipt refused without parsing','gateway and bridge require first protected frame association','bridge refuses reordered late receipt on ordinary and protected connections'],
    substitutes:'gateway socket objects for parse instrumentation; native initialization response for real Unix WebSocket bridge cases'}));
}finally{await Promise.all(clients.map(client=>client.close()));rmSync(root,{recursive:true,force:true});}
