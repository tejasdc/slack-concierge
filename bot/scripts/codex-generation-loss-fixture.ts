// Exercises the production client's exact-generation loss against disposable child bridges. It
// proves a captured old generation disconnects, reconnects normally, and cannot cut its successor.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexAppServerClient} from '../src/codex-app-server-client';

const scratch=mkdtempSync(join(tmpdir(),'concierge-codex-generation-loss-'));
const bridge=join(scratch,'bridge.js');
writeFileSync(bridge,`process.stdout.write(JSON.stringify({type:'ready'})+'\\n');process.stdin.resume();`);
const client=new CodexAppServerClient('/unused',process.execPath,{bridgePath:bridge,shutdownGraceMs:50});
try{
  const first=await client.connect();
  assert.equal(client.activeGeneration,first);
  assert.equal(await client.loseConnectionGeneration(first),'observed','the captured bridge exit is observed');
  assert.equal(client.activeGeneration,null,'disconnect clears only its active generation');
  const second=await client.connect();
  assert.ok(second>first,'the reconnect is a new generation');
  assert.equal(await client.loseConnectionGeneration(first),'stale','replayed old generation is refused');
  assert.equal(client.activeGeneration,second,'a stale request cannot cut the replacement');
  console.log('Codex generation-loss fixture: exact bridge generation ended, reconnect worked, and stale generation left its successor alive');
}finally{
  await client.close({immediate:true}).catch(()=>{});
  rmSync(scratch,{recursive:true,force:true});
}
