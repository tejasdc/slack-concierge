#!/usr/bin/env bun
import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {historyContent,historyDetailPart,previewHistoryMessage} from '../src/history-message-preview';
import {HistoryDetailCache} from '../src/history-detail-cache';
import {ProviderHistoryPageClient} from '../src/provider-history-page-client';
import type {ProviderHistoryMessage} from '../src/provider-history';

for(const count of [100,1000,10_000]) {
  const requested:Array<ProviderHistoryMessage&{source?:any}>=[];
  for(let index=0;index<20;index++)requested.push({id:`message-${count}-${index}`,role:'assistant',
    content:index===19?'🧠'.repeat(2*1024*1024):'A normal answer.',tool:null,phase:null,
    ...(index===19?{richContent:{version:1,parts:[{kind:'markdown',text:'z'.repeat(512*1024)}]},
      source:{sourceId:'imported',sourceVersion:'a'.repeat(64),eventId:`message-${count}-${index}`,
        textHash:'b'.repeat(64),text:'🧠'.repeat(2*1024*1024)}}:{})});
  const page=requested.map(previewHistoryMessage);
  assert.ok(Buffer.byteLength(JSON.stringify({messages:page,nextCursor:'older'}))<200_000,
    'history page bytes must not grow with one 8 MB answer or duplicated source text');
  assert.deepEqual(page.map(message=>message.id),requested.map(message=>message.id));
  const large=page.at(-1)!;
  assert.ok(large.contentDetail&&large.contentDetail.bytes>8*1024*1024);
  assert.equal((large as any).source?.text,undefined,'imported evidence must not duplicate its full body');
  const full=historyContent(requested.at(-1)!);
  assert.equal(createHash('sha256').update(full).digest('hex'),large.contentDetail.digest);
  const first=historyDetailPart(full,0),last=historyDetailPart(full,large.contentDetail.parts-1);
  assert.equal(first.digest,large.contentDetail.digest);
  assert.equal(last.nextPart,null);
  assert.ok(Buffer.byteLength(first.content)<=4096&&Buffer.byteLength(last.content)<=4096);
  assert.ok(first.content.startsWith('{"content":"'));
}

const unicode=historyContent({content:'🧠'.repeat(30_000),richContent:{parts:[{kind:'markdown',text:'ok'}]}});
const precomputed={digest:createHash('sha256').update(unicode).digest('hex'),bytes:Buffer.byteLength(unicode),parts:30};
const sourcePreview=previewHistoryMessage({id:'source-preview',role:'assistant',content:'🧠'.repeat(1024),
  tool:null,phase:null,contentDetail:precomputed} as ProviderHistoryMessage&{contentDetail:typeof precomputed});
assert.deepEqual(sourcePreview.contentDetail,precomputed,'an imported source preview must preserve the source full-body version');
const parts=previewHistoryMessage({id:'unicode',role:'assistant',content:'🧠'.repeat(30_000),
  richContent:{parts:[{kind:'markdown',text:'ok'}]},tool:null,phase:null}).contentDetail!.parts;
const rejoined=Array.from({length:parts},(_,part)=>historyDetailPart(unicode,part).content).join('');
assert.equal(rejoined,unicode,'UTF-8 chunks must join into exact structured content');
const selected=new HistoryDetailCache();let selectedLoads=0;
const selectedDigest=createHash('sha256').update(unicode).digest('hex');
for(const part of [0,1,2,3])await selected.part('same-exact-version',selectedDigest,part,async()=>{selectedLoads++;return unicode;});
assert.equal(selectedLoads,1,'consecutive selected-detail parts must not reconstruct the source repeatedly');
assert.equal((await selected.body('same-exact-version',selectedDigest,async()=>{selectedLoads++;return unicode;})).toString('utf8'),unicode);
assert.equal(selectedLoads,1,'single-body detail must use the same exact prepared version');
const versionA=historyContent({content:'version A'}),versionB=historyContent({content:'version B'});
const digestA=createHash('sha256').update(versionA).digest('hex');
const digestB=createHash('sha256').update(versionB).digest('hex');
const [resolvedA,resolvedB]=await Promise.all([
  selected.body('session-1:binding-1:message-1:'+digestA,digestA,async()=>{
    await new Promise(resolve=>setTimeout(resolve,10));return versionA;}),
  selected.body('session-1:binding-2:message-1:'+digestB,digestB,async()=>versionB),
]);
assert.equal(resolvedA.toString('utf8'),versionA,'concurrent old version must keep its own bytes');
assert.equal(resolvedB.toString('utf8'),versionB,'concurrent new version must keep its own bytes');
for(let part=0;part<parts;part++)assert.ok(Buffer.byteLength(historyDetailPart(unicode,part).content)<=4096,
  'every UTF-8-safe part must stay under the declared byte bound');

// Exercise the same authenticated owner entrances that the browser uses, against a
// throwaway ledger. The source reader is pinned to one version and runs outside owner.
const scratch=await mkdtemp(join(tmpdir(),'concierge-history-page-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION='responsive-system-b1eed622';
try {
  const [{SessionOwner},{createNativeSession},{db}]=await Promise.all([
    import('../src/session-owner'),import('../src/session-inputs'),import('../src/state')]);
  const content='🧠'.repeat(2*1024*1024),richContent={version:1,parts:[{kind:'markdown',text:'z'.repeat(512*1024)}]};
  const source={sourceId:'source-1',sourceVersion:'a'.repeat(64),eventId:'source-message',ordinal:0,
    role:'assistant',locator:'source-line-1',textHash:'b'.repeat(64),text:content};
  const session=createNativeSession('chatgpt',{origin:'imported',title:'A long imported answer',
    source:{id:'source-1',version:'a'.repeat(64),branch:'main'}});
  let exactLoads=0,seenLimit=0;
  const owner=new SessionOwner({wake(){},steer(){return false;},async stop(){return false;},available(){return false;},
    async history(){return {messages:[{id:'native-message',role:'assistant',content,tool:null,phase:null,turnId:'native-turn'}],nextCursor:null};},
    async historyMessage(){return {id:'native-message',role:'assistant',content,tool:null,phase:null,turnId:'native-turn'};},
    sources:{async search(){return {};},async context(){return {};},async import(){return {};},
      async history(input:any){seenLimit=input.limit;return {messages:[{id:'source-message',role:'assistant',content,richContent,tool:null,phase:null,source}],nextCursor:null};},
      async historyMessage(){exactLoads++;return {id:'source-message',role:'assistant',content,richContent,tool:null,phase:null,source};}}},scratch);
  const address=`concierge:${session.id}`;
  const pageResponse=await owner.handle(new Request(`http://owner/sessions/v1/sessions/${address}/history?limit=200`));
  assert.equal(pageResponse?.status,200);
  const page=await pageResponse!.json() as any;
  assert.equal(seenLimit,20,'a requested 200-row page must be limited to the bounded window');
  assert.equal(page.messages.length,1);
  assert.ok(Buffer.byteLength(JSON.stringify(page))<8192);
  const ref=page.messages[0].contentDetail;
  assert.ok(ref?.bytes>8*1024*1024);
  for(const part of [0,1,2]){
    const response=await owner.handle(new Request(`http://owner/sessions/v1/sessions/${address}/history/messages/source-message/detail?digest=${ref.digest}&part=${part}`));
    assert.equal(response?.status,200);
    const body=await response!.json() as any;
    assert.equal(body.part,part);assert.ok(Buffer.byteLength(body.content)<=4096);
  }
  assert.equal(exactLoads,1,'the actual selected-detail route must reuse the exact source read');
  const exact=await owner.handle(new Request(`http://owner/sessions/v1/sessions/${address}/history/messages/source-message/detail?digest=${ref.digest}`));
  assert.equal(exact?.status,200);
  const exactBytes=Buffer.from(await exact!.arrayBuffer());
  assert.equal(exactBytes.length,ref.bytes);
  assert.equal(createHash('sha256').update(exactBytes).digest('hex'),ref.digest);
  assert.deepEqual(JSON.parse(exactBytes.toString('utf8')),{content,richContent});
  assert.equal(exactLoads,1,'the one-request full detail must reuse the selected immutable version');
  const stale=await owner.handle(new Request(`http://owner/sessions/v1/sessions/${address}/history/messages/source-message/detail?digest=${'0'.repeat(64)}&part=0`));
  assert.equal(stale?.status,409,`a stale detail version must refuse instead of returning changed words: ${await stale?.text()}`);
  const native=createNativeSession('codex',{origin:'native',title:'Long native answer'});
  const nativeAddress=`concierge:${native.id}`;
  const nativePage=await owner.handle(new Request(`http://owner/sessions/v1/sessions/${nativeAddress}/history?limit=20`));
  assert.equal(nativePage?.status,200);
  const nativeMessage=((await nativePage!.json()) as any).messages[0];
  assert.ok(nativeMessage.contentDetail?.digest);
  const nativePart=await owner.handle(new Request(`http://owner/sessions/v1/sessions/${nativeAddress}/history/messages/native-message/detail?digest=${nativeMessage.contentDetail.digest}&part=0&turnId=native-turn`));
  assert.equal(nativePart?.status,200,'native provider history must retain an exact detail path');
  const preparing=new SessionOwner({wake(){},steer(){return false;},async stop(){return false;},available(){return false;},
    async projectedHistory(){throw new Error('HISTORY_PAGE_STILL_PREPARING');}},scratch);
  const preparingResponse=await preparing.handle(new Request(`http://owner/sessions/v1/sessions/${nativeAddress}/history?limit=20`));
  assert.equal(preparingResponse?.status,200,'a cold background preparation is coverage, not an owner failure');
  const preparingPage=await preparingResponse!.json() as any;
  assert.equal(preparingPage.coverage?.code,'history_indexing');
  assert.equal(preparingPage.coverage?.complete,false);
  assert.ok(preparingPage.coverage?.retryAfterMs>0,'the browser must get its automatic refresh instruction');
  // A provider page with an 8 MiB retained body must not occupy the accepting loop.
  const offloaded=createNativeSession('claude-code',{origin:'native',title:'Off-loop retained history'});
  db.query("INSERT INTO turns(session_id,slack_user_msg_ts,user_text,agent_text,status) VALUES(?,?,?,?,?)")
    .run(offloaded.id,'history-fixture','An earlier question',content,'completed');
  const client=new ProviderHistoryPageClient();
  let lastTick=performance.now(),maxTickGap=0;
  const ticks=setInterval(()=>{const now=performance.now();maxTickGap=Math.max(maxTickGap,now-lastTick);lastTick=now;},5);
  try{
    const result=await client.request({operation:'page',sessionId:`concierge:${offloaded.id}`,cwd:scratch,
      cursor:null,limit:20,after:null}) as any;
    assert.equal(result.messages.length,2);
    assert.ok(Buffer.byteLength(JSON.stringify(result))<8192);
    assert.ok(maxTickGap<150,`the accepting event loop stalled ${maxTickGap} ms during off-loop projection`);
  }finally{clearInterval(ticks);await client.close();}
} finally {await rm(scratch,{recursive:true,force:true});}
console.log('history-page-growth: passed');
