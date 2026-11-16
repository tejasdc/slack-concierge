import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createCustodyRelayFixture} from './fixtures/custody-relay-harness';
import {assertCustodyEndpoint} from '../src/codex-custody-colocation';
import {custodyConnection} from '../src/codex-custody-connection';

const root=mkdtempSync(join(tmpdir(),'protected-codex-relay-'));
const nativeSocket=join(root,'native.sock');
mkdirSync(join(root,'home'));mkdirSync(join(root,'codex'));
// Nothing in this acceptance may discover credentials, configuration or a control socket on HOME.
process.env.HOME=join(root,'home');process.env.CODEX_HOME=join(root,'codex');
process.env.CONCIERGE_CODEX_APP_SERVER_SOCKET=nativeSocket;
process.env.CONCIERGE_STATE_DIR=root;
const binary=realpathSync(process.env.CONCIERGE_FIXTURE_CODEX_BINARY||'/root/.codex/packages/standalone/current/codex');
const binaryDigest=createHash('sha256').update(readFileSync(binary)).digest('hex');
const version=Bun.spawnSync([binary,'--version'],{env:{HOME:process.env.HOME,CODEX_HOME:process.env.CODEX_HOME,PATH:'/usr/bin:/bin'}}).stdout.toString().trim();
const native=Bun.spawn([binary,'app-server','--listen',`unix://${nativeSocket}`],{
  env:{HOME:process.env.HOME,CODEX_HOME:process.env.CODEX_HOME,PATH:'/usr/bin:/bin'},stdout:'pipe',stderr:'pipe'});
let harness:Awaited<ReturnType<typeof createCustodyRelayFixture>>|undefined;
try {
  const deadline=Date.now()+10_000;
  while(!existsSync(nativeSocket)){if(native.exitCode!==null)throw new Error(await new Response(native.stderr).text());if(Date.now()>deadline)throw new Error('isolated native socket unavailable');await Bun.sleep(20);}
  let runnerEntry:string|undefined;
  if(process.argv.includes('--sealed')){
    const botDir=join(root,'sealed/control/bot');mkdirSync(join(botDir,'scripts'),{recursive:true});mkdirSync(join(botDir,'src'),{recursive:true});
    for(const name of ['runner','router-sessions','router-request-client']){
      const result=await Bun.build({entrypoints:[resolve(import.meta.dir,`${name}.ts`)],outdir:join(botDir,'scripts'),target:'bun'});
      if(!result.success)throw new Error(`sealed runner fixture build failed: ${result.logs.join('\n')}`);
    }
    const result=await Bun.build({entrypoints:[resolve(import.meta.dir,'../src/codex-app-server-bridge.mjs')],outdir:join(botDir,'..'),target:'node',format:'esm',naming:'[name].mjs'});
    if(!result.success)throw new Error(`sealed native transport build failed: ${result.logs.join('\n')}`);
    const selectedControl=join(root,'selected-control');symlinkSync(join(botDir,'..'),selectedControl,'dir');
    runnerEntry=join(selectedControl,'bot/scripts/runner.js');
  }
  harness=await createCustodyRelayFixture(root,nativeSocket,{runnerEntry});
  const old=harness.client();await old.connect();
  assertCustodyEndpoint(old.nativeEndpoint,false);
  assert.equal(old.nativeEndpoint.relayAssociation?.nativePeer.pid,native.pid,'peer must be the actual isolated native process');
  const client=harness.client();const bound=custodyConnection(client);
  const witness=await bound.witness();bound.protect(witness);await bound.assert(witness);
  assertCustodyEndpoint(witness.endpoint);
  assert.equal(witness.endpoint?.relayAssociation?.nativePeer.pid,native.pid);
  assert.equal(witness.endpoint?.relayAssociation?.nativePeer.socketPath,nativeSocket);
  assert.notEqual(witness.endpoint?.relayAssociation?.pairId,old.nativeEndpoint.relayAssociation?.pairId);
  assert.equal(witness.endpoint?.relayAssociation?.runnerIdentity.pid,harness.runner.pid);
  if(runnerEntry)assert.equal(witness.endpoint?.relayAssociation?.preparation.machine.botDir,realpathSync(join(root,'selected-control/bot')),
    'loaded helper release must be the concrete immutable release, not its moving selection symlink');
  const listed=await bound.request('thread/list',{limit:1});
  assert.deepEqual(listed.data,[],'fixture stock native has no host conversation history');
  // Replacing only the listener must leave established pairs with their ORIGINAL serving process.
  const replacement=harness.spawnRunner();
  const replacementClient=harness.client();
  let replacementWitness;
  const replacementDeadline=Date.now()+10_000;
  while(Date.now()<replacementDeadline){
    await replacementClient.loseConnectionGeneration(replacementClient.activeGeneration??0);
    try{await replacementClient.connect();if(replacementClient.nativeEndpoint.relayAssociation?.runnerIdentity.pid===replacement.pid){replacementWitness=replacementClient.nativeEndpoint;break;}}catch{}
    await Bun.sleep(20);
  }
  assert.equal(replacementWitness?.relayAssociation?.runnerIdentity.pid,replacement.pid);
  assert.equal(client.nativeEndpoint.relayAssociation?.runnerIdentity.pid,harness.runner.pid);
  assert.notEqual(replacementWitness?.relayAssociation?.pairId,client.nativeEndpoint.relayAssociation?.pairId);
  await bound.assert(witness);assert.deepEqual((await bound.request('thread/list',{limit:1})).data,[]);
  const generation=await client.connect();await client.loseConnectionGeneration(generation);await assert.rejects(bound.assert(witness),/connection changed/);
  console.log(JSON.stringify({ok:true,kind:'stock-native-transport',sealed:!!runnerEntry,version,binary,binaryDigest,nativePid:native.pid,
    assertions:['actual connected native peer via duplicated FD SO_PEERCRED','boot/start/namespaces corroborated locally','protected association before native initialization',
      'explicit protected predecessor association','listener replacement cannot reassign old pair','reconnect invalidates custody witness','isolated thread/list read'],
    nativeEffectSubstitutes:'none: transport/read only; no provider execution or custody construction/admission asserted'}));
}finally{await harness?.close();native.kill();await native.exited;rmSync(root,{recursive:true,force:true});}
