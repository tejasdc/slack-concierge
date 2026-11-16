import {strict as assert} from 'node:assert';
import {chmodSync,existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createCustodyRelayFixture} from './fixtures/custody-relay-harness';

const root=mkdtempSync(join(tmpdir(),'ordinary-relay-independent-'));
try{
  for(const failure of ['python-missing','probe-failed','association-files-missing']){
    const state=join(root,failure);mkdirSync(state);mkdirSync(join(state,'home'));mkdirSync(join(state,'codex'));
    const socket=join(state,'native.sock'),bin=join(state,'bin'),trace=join(state,'probe-trace');mkdirSync(bin);
    if(failure==='probe-failed'){
      const python=join(bin,'python3');writeFileSync(python,`#!/bin/sh\nprintf 'probe\\n' >> '${trace}'\nexit 19\n`);chmodSync(python,0o700);
    }
    let runnerEntry:string|undefined;
    if(failure==='association-files-missing'){
      const scripts=join(state,'control/bot/scripts');mkdirSync(scripts,{recursive:true});
      const built=await Bun.build({entrypoints:[resolve(import.meta.dir,'runner.ts')],outdir:scripts,target:'bun'});
      assert.ok(built.success,built.logs.join('\n'));runnerEntry=join(scripts,'runner.js');
      // Deliberately omit the protected control bridge/helpers. Ordinary runner startup must
      // remain usable while protected association remains unavailable.
    }
    const native=Bun.serve({unix:socket,fetch:(request,server)=>server.upgrade(request)?undefined:new Response('ws only'),websocket:{message(socket,data){
      const frame=JSON.parse(String(data));if(frame.method==='initialize')socket.send(JSON.stringify({id:frame.id,result:{userAgent:'native-substitute'}}));
      else if(frame.id)socket.send(JSON.stringify({id:frame.id,result:{echo:frame.params}}));
    }}});
    let harness:Awaited<ReturnType<typeof createCustodyRelayFixture>>|undefined;
    try{
      harness=await createCustodyRelayFixture(state,socket,{runnerEntry,runnerEnvironment:{PATH:bin,CONCIERGE_NODE_BIN:process.env.CONCIERGE_NODE_BIN||Bun.which('node')||'/usr/bin/node'}});
      const ordinary=harness.client(false);await ordinary.connect();
      assert.deepEqual(await ordinary.request('thread/read',{threadId:'ordinary-survives'}),{echo:{threadId:'ordinary-survives'}});
      assert.equal(ordinary.nativeEndpoint.relayAssociation,undefined);
      assert.equal(readFileSync(`/proc/${harness.runner.pid}/task/${harness.runner.pid}/children`,'utf8').trim(),'',
        'an ordinary relay creates zero runner-owned pair children');
      assert.equal(existsSync(trace),false,'ordinary traffic never invokes the credentials probe');
      const protectedClient=harness.client();await assert.rejects(protectedClient.connect(),'protected setup must refuse its missing association dependency');
      if(failure==='probe-failed')assert.equal(readFileSync(trace,'utf8'),'probe\n','only protected open invokes the failing probe');
      assert.deepEqual(await ordinary.request('thread/read',{threadId:'ordinary-still-survives'}),{echo:{threadId:'ordinary-still-survives'}});
    }finally{await harness?.close();native.stop(true);}
  }
  console.log(JSON.stringify({ok:true,check:'ordinary-relay-independence',failures:['python-missing','probe-failed','association-files-missing'],
    addedOrdinaryPairChildren:0,ordinaryProbeCalls:0,assertions:['ordinary traffic succeeds before and after protected refusal','ordinary startup survives absent association files'],
    substitutes:'native RPC responses and deliberately unavailable/failing Python probe; actual client/bridge/gateway/runner direct ordinary transport'}));
}finally{rmSync(root,{recursive:true,force:true});}
