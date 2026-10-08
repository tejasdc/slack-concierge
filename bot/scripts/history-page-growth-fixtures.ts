#!/usr/bin/env bun
import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {historyContent,historyDetailPart,previewHistoryMessage} from '../src/history-message-preview';
import {HistoryDetailCache} from '../src/history-detail-cache';
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
const parts=previewHistoryMessage({id:'unicode',role:'assistant',content:'🧠'.repeat(30_000),
  richContent:{parts:[{kind:'markdown',text:'ok'}]},tool:null,phase:null}).contentDetail!.parts;
const rejoined=Array.from({length:parts},(_,part)=>historyDetailPart(unicode,part).content).join('');
assert.equal(rejoined,unicode,'UTF-8 chunks must join into exact structured content');
const selected=new HistoryDetailCache();let selectedLoads=0;
for(const part of [0,1,2,3])await selected.part('same-exact-version',part,async()=>{selectedLoads++;return unicode;});
assert.equal(selectedLoads,1,'consecutive selected-detail parts must not reconstruct the source repeatedly');

// Exercise the same authenticated owner entrances that the browser uses, against a
// throwaway ledger. The source reader is pinned to one version and runs outside owner.
const scratch=await mkdtemp(join(tmpdir(),'concierge-history-page-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION='responsive-system-b1eed622';
try {
  const [{SessionOwner},{createNativeSession}]=await Promise.all([
    import('../src/session-owner'),import('../src/session-inputs')]);
  const content='🧠'.repeat(2*1024*1024),richContent={version:1,parts:[{kind:'markdown',text:'z'.repeat(512*1024)}]};
  const source={sourceId:'source-1',sourceVersion:'a'.repeat(64),eventId:'source-message',ordinal:0,
    role:'assistant',locator:'source-line-1',textHash:'b'.repeat(64),text:content};
  const session=createNativeSession('chatgpt',{origin:'imported',title:'A long imported answer',
    source:{id:'source-1',version:'a'.repeat(64),branch:'main'}});
  let exactLoads=0,seenLimit=0;
  const owner=new SessionOwner({wake(){},steer(){return false;},async stop(){return false;},available(){return false;},
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
  const stale=await owner.handle(new Request(`http://owner/sessions/v1/sessions/${address}/history/messages/source-message/detail?digest=${'0'.repeat(64)}&part=0`));
  assert.equal(stale?.status,409,'a stale detail version must refuse instead of returning changed words');
} finally {await rm(scratch,{recursive:true,force:true});}
console.log('history-page-growth: passed');
