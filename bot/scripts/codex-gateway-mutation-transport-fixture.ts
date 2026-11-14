import {strict as assert} from 'node:assert';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {forwardCodexMutationGate} from '../src/foreground-forward';

const root=await mkdtemp(join(tmpdir(),'codex-gateway-mutation-'));
const socket=join(root,'owner.sock');
const observed:unknown[]=[];
const server=Bun.serve({unix:socket,async fetch(request){
  assert.equal(new URL(request.url).pathname,'/session-communication/codex-mutation-gate');
  assert.equal(request.method,'POST');
  const body=await request.json() as any;
  observed.push(body);
  if(body.mode==='refuse')return Response.json({allowed:true},{status:503});
  if(body.mode==='malformed')return new Response('{');
  if(body.mode==='oversized')return new Response(' '.repeat(64*1024+1));
  return Response.json({allowed:false,reason:'held',identity:body});
}});
try {
  const identity={phase:'prepare',permitId:'retained-permit',threadId:'exact-thread',paramsDigest:'unchanged',label:'中'};
  assert.deepEqual(await forwardCodexMutationGate(identity,socket),{allowed:false,reason:'held',identity});
  assert.deepEqual(observed,[identity]);
  await assert.rejects(forwardCodexMutationGate({mode:'refuse'},socket),/refused/);
  await assert.rejects(forwardCodexMutationGate({mode:'malformed'},socket));
  await assert.rejects(forwardCodexMutationGate({mode:'oversized'},socket),/exceeded/);
  await assert.rejects(forwardCodexMutationGate(identity,join(root,'missing.sock')));
  assert.equal(observed.length,4,'uncertain/refused authority calls never resubmit');
  console.log('codex-gateway-mutation-transport-fixture: PASS (private transport; exact bytes; bounded/refused/uncertain responses; no retry)');
} finally {await server.stop(true);await rm(root,{recursive:true,force:true});}
