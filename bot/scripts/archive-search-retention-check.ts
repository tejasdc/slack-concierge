import {strict as assert} from 'node:assert';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {indexedArchiveSource,retainedArchiveSearchSource} from '../src/archive-search-source';

const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const id='["native","codex","isolated-archive","00000000-0000-4000-8000-000000000001"]';
const source={id,provider:'codex',scope:'isolated-archive',nativeId:'00000000-0000-4000-8000-000000000001',
 synthetic:false,title:'Exact archived search result',createdAt:'2026-10-08T00:00:00.000Z',project:null,
 version:digest('frozen source bytes'),branch:'native-record-order',messages:[],omissions:[],consultation:null};
const pin={sourceId:id,sourceVersion:source.version,branch:source.branch,eventId:'older-event'};
// This is the prepared-history wire response: the matched event need not be in its one-message page.
const page={messages:[{id:'latest-event',content:'latest'}],nextCursor:'older-page',retainedEventId:pin.eventId};
assert.equal(retainedArchiveSearchSource(source,pin,page),source,'meaning search keeps indexed compact metadata');
assert.equal(indexedArchiveSource({...source,provider:'claude'})?.provider,'claude-code',
 'the indexed native spelling maps to the existing wire spelling');
assert.equal(indexedArchiveSource({...source,consultation:undefined})?.consultation,null,
 'the index has an optional consultation while the capability wire uses null');
assert.equal(retainedArchiveSearchSource({...source,messages:[{sourceId:id,sourceVersion:source.version,
 eventId:pin.eventId,ordinal:0,role:'user',locator:'jsonl:1',text:'archived phrase',textHash:digest('archived phrase')}]},pin,page)?.title,source.title,
 'lexical search keeps the adapter candidate metadata');
for(const invalid of [{provider:['codex']},{nativeId:null},{scope:5},{synthetic:'false'},{createdAt:null},{project:5},
 {consultation:{}},{consultation:{sourceId:id,sourceVersion:source.version,boundary:null,packetVersion:'dialogue-v1'}},
 {omissions:[42]},{messages:[{eventId:pin.eventId}]}]){
 assert.equal(indexedArchiveSource({...source,...invalid}),null,'index metadata must satisfy the source contract');
 assert.equal(retainedArchiveSearchSource({...source,...invalid},pin,page),null,'retention proof cannot repair invalid metadata');
}
assert.equal(retainedArchiveSearchSource(source,{...pin,branch:'another-branch'},page),null);
assert.equal(retainedArchiveSearchSource(source,pin,{messages:page.messages,nextCursor:page.nextCursor}),null,
 'a generic page does not prove the matched event');
assert.equal(retainedArchiveSearchSource(source,pin,{...page,retainedEventId:'different-event'}),null);
assert.equal(retainedArchiveSearchSource(source,pin,null),null);

async function ownerChild(){
 const {SessionOwner}=await import('../src/session-owner');
 let unavailable=false;
 const searched:{eventId:string}[]=[];
 const owner=new SessionOwner({available:()=>true,wake:()=>{},steer:()=>false,stop:async()=>false,
  sources:{search:async(input:any)=>input.query==='semantic only'?{sources:[],matches:[],complete:true,refresh:[]}:({sources:[{...source,messages:[{sourceId:id,sourceVersion:source.version,
    eventId:pin.eventId,ordinal:0,role:'user',locator:'jsonl:1',textHash:digest('archived phrase'),text:'archived phrase'}]}],
    matches:[{sourceId:id,sourceVersion:source.version,eventId:pin.eventId,ordinal:0,role:'user',
      locator:'jsonl:1',textHash:digest('archived phrase'),text:'archived phrase'}],complete:true,refresh:[]}),
   history:async(input:any)=>{searched.push(input);if(unavailable)throw new Error('SOURCE_EVENT_NOT_FOUND');return page;},
   context:async()=>{throw new Error('Whole source context is forbidden in this fixture.');},
   import:async()=>({sources:[]})}},process.env.CONCIERGE_STATE_DIR!);
 const found=await owner.search({query:'archived phrase',limit:3});
 assert.ok(found.results.some((result:any)=>result.session.title===source.title));
 assert.equal(searched.length,1);assert.equal(searched[0].eventId,pin.eventId);
 unavailable=true;
 const absent=await owner.search({query:'archived phrase',limit:3});
 assert.ok(absent.coverage.omissions.some((item:string)=>item.includes('could not be retained')),
  'a missing exact source event must be explicit coverage, not a 502');
 const {startMeaningIndex}=await import('../src/meaning-index');
 const meaning=startMeaningIndex(process.env.CONCIERGE_STATE_DIR!,()=>null);
 meaning.stop(); // The fixture controls embedding results, not a real model process.
 meaning.search=async()=>({available:true,indexed:1,pending:false,reason:null,hits:[{
  target:{kind:'archive',...pin,nativeId:source.nativeId,source},score:0.9,text:'semantic evidence',at:null,ref:'fixture'}]});
 unavailable=false;
 const semantic=await owner.search({query:'semantic only',limit:3});
 assert.ok(semantic.results.some((result:any)=>result.session.title===source.title&&result.match.meaning===0.9),
  'actual meaning-only search must use indexed identity with the page proof');
 unavailable=true;
 const semanticAbsent=await owner.search({query:'semantic only',limit:3});
 assert.ok(semanticAbsent.coverage.omissions.some((item:string)=>item.includes('archive meaning matches')));
 console.log(JSON.stringify({check:'archive-search-retention',lexical:true,meaningOwner:true,meaningMetadata:true,
  exactEventProof:true,unavailableCoverage:true,contextReads:0}));
}
if(import.meta.main){
 if(process.argv[2]==='--child')ownerChild().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
 else {
  const state=await mkdtemp(join(tmpdir(),'archive-search-retention-'));
  try{
   const child=spawn(process.execPath,[import.meta.path,'--child'],{env:{...process.env,CONCIERGE_STATE_DIR:state,
    CONCIERGE_CAPTURE_STATE_DIR:join(state,'capture'),CONCIERGE_TEST_MODE:'1',
    CONCIERGE_TEST_AUTHORIZATION:'responsive-system-b1eed622'},stdio:['ignore','pipe','pipe']});
   let output='',errors='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors+=chunk;});
   const timeout=setTimeout(()=>child.kill('SIGKILL'),15_000);
   try{const code=await new Promise(resolve=>child.once('exit',resolve));assert.equal(code,0,errors+'\n'+output);
    console.log(output.trim());}finally{clearTimeout(timeout);}
  }finally{await rm(state,{recursive:true,force:true});}
 }
}
