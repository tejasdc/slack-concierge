import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexAppServerClient} from '../src/codex-app-server-client';
import {custodyConnection} from '../src/codex-custody-connection';

const scratch=mkdtempSync(join(tmpdir(),'custody-native-connection-'));
const bridge=join(scratch,'bridge.js');
writeFileSync(bridge,`let buffered='';process.stdin.setEncoding('utf8');
process.stdout.write(JSON.stringify({type:'ready'})+'\\n');
process.stdin.on('data',chunk=>{
 buffered+=chunk;let end;
 while((end=buffered.indexOf('\\n'))>=0){const line=buffered.slice(0,end);buffered=buffered.slice(end+1);
  const call=JSON.parse(line);if(call.type==='close')process.exit(0);
  if(call.type==='request')process.stdout.write(JSON.stringify({type:'response',id:call.id,result:{method:call.method}})+'\\n');
 }
});`);
const raw=new CodexAppServerClient('/disposable',process.execPath,{bridgePath:bridge,manageDaemon:false,shutdownGraceMs:50});
try{
  const protectedClient=custodyConnection(raw),witness=await protectedClient.witness();
  protectedClient.protect(witness);
  assert.equal(custodyConnection(raw),protectedClient);
  assert.equal((await protectedClient.request('thread/start',{})).method,'thread/start');
  await protectedClient.assert(witness);
  assert.equal((await protectedClient.request('turn/interrupt',{threadId:'retained',turnId:'active-turn'})).method,'turn/interrupt',
    'the protected wrapper must forward Stop on the retained connection');
  await raw.loseConnectionGeneration(witness.generation);
  // A strict production request must refuse before creating a replacement connection.
  await assert.rejects(()=>raw.request('turn/start',{}, {expectedConnectionGeneration:witness.generation}),/connection changed/);
  assert.equal(raw.activeGeneration,null);
  const replacement=await raw.connect();
  assert.notEqual(replacement,witness.generation);
  assert.equal((await protectedClient.request('thread/read',{threadId:'retained'})).method,'thread/read',
    'a changed transport may reconcile the same recorded attempt through reads');
  await assert.rejects(()=>protectedClient.request('turn/start',{}),/connection changed/);
  await assert.rejects(()=>protectedClient.request('turn/interrupt',{threadId:'retained',turnId:'active-turn'}),/connection changed/);
  await assert.rejects(()=>protectedClient.assert(witness),/connection changed/);
  const other=new CodexAppServerClient('/disposable',process.execPath,{bridgePath:bridge,manageDaemon:false,shutdownGraceMs:50});
  try{
    const adopted=custodyConnection(other);adopted.protect(witness);
    assert.equal((await adopted.request('thread/read',{threadId:'retained'})).method,'thread/read');
    await assert.rejects(()=>adopted.assert(witness),/another native connection/);
    await assert.rejects(()=>adopted.request('turn/start',{}),/another native connection/);
    await assert.rejects(()=>adopted.request('turn/interrupt',{threadId:'retained',turnId:'active-turn'}),/another native connection/);
  }
  finally{await other.close({immediate:true});}
  console.log('Custody native connection fixture passed: positive same connection, no implicit reconnect on protected send, replacement and other-client refusal. This is association proof only.');
}finally{await raw.close({immediate:true});rmSync(scratch,{recursive:true,force:true});}
