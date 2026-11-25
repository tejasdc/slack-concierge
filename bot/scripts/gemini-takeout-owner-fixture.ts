import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';

const release=process.argv[2];
assert.ok(release?.startsWith('/')&&existsSync(join(release,'.build/adapters/src/session-sources.js')),
  'Pass the absolute path to a built Thinkering release.');
const scratch=mkdtempSync(join(tmpdir(),'concierge-gemini-'));
const sourceSocket=join(scratch,'source','capabilities.sock');
mkdirSync(join(scratch,'archives'),{mode:0o700});
Object.assign(process.env,{CONCIERGE_STATE_DIR:scratch,CONCIERGE_CAPTURE_STATE_DIR:join(scratch,'capture')});
delete process.env.CONCIERGE_THINKERING_CAPABILITY_URL;
const responderPath=join(scratch,'source.mjs');
const adapter=(name:string)=>JSON.stringify(pathToFileURL(join(release,'.build/adapters/src',name)).href);
writeFileSync(responderPath,`
  import {DirectorySessionSources} from ${adapter('session-sources.js')};
  import {listenSessionCapabilities} from ${adapter('session-capability-server.js')};
  const sources=new DirectorySessionSources(process.argv[3]);
  const host=await listenSessionCapabilities({socketPath:process.argv[2],sources});
  process.on('SIGTERM',async()=>{await host.close();await sources.close();process.exit(0);});
`);
const responder=Bun.spawn(['node',responderPath,sourceSocket,join(scratch,'archives')],{cwd:release,stderr:'inherit'});
const digest=(bytes:string)=>createHash('sha256').update(bytes).digest('hex');
let server:ReturnType<typeof Bun.serve>|undefined;
try {
  const [{SessionOwner},{SessionCapabilityClient,SessionCapabilityError},{db},{getAcceptedSessionInput}]=await Promise.all([
    import('../src/session-owner'),import('../src/session-capability-client'),import('../src/state'),import('../src/session-inputs')]);
  for(let attempts=0;attempts<100&&!existsSync(sourceSocket);attempts++)await Bun.sleep(100);
  assert.ok(existsSync(sourceSocket),'The isolated Thinkering capability did not listen.');
  const client=new SessionCapabilityClient({socketPath:sourceSocket});
  const owner=new SessionOwner({
    available:provider=>provider==='codex',wake:()=>{},steer:()=>false,stop:async()=>false,
    sources:{import:input=>client.importSource(input),search:input=>client.searchSources(input),
      context:input=>client.sourceContext(input),proof:input=>client.sourceSearchProof(input),
      history:input=>client.sourceHistory(input),historyMessage:input=>client.sourceHistoryMessage(input)}
  },scratch);
  const ownerSocket=join(scratch,'owner.sock');
  server=Bun.serve({unix:ownerSocket,fetch:async request=>await owner.handle(request)??new Response(null,{status:404})});
  async function call(route:string,body?:unknown,status=200) {
    const response=await fetch('http://owner/sessions/v1/'+route,{unix:ownerSocket,
      ...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
    const result=await response.json() as any;
    assert.equal(response.status,status,JSON.stringify(result));
    return result;
  }
  const text='Synthetic current request: summarize the provenance.';
  const content=JSON.stringify([
    {header:'Gemini Apps',conversationId:'marked-group',title:'Prompted markedgrpword',safeHtmlItem:[{html:'<p>Exported answer</p>'}]},
    {header:'Gemini Apps',activityId:'activity-with-explicit-id',title:'markedactivityword'},
  ]);
  const importBody={clientActionId:randomUUID(),name:'MyActivity.json',scope:'marked-owner-check',content};
  const imported=await call('imports',importBody);
  const readObservation=(action:string,version=digest(content))=>db.query(
    'SELECT * FROM archive_import_observations WHERE action_id=? AND source_version=?').get(action,version) as Record<string,any>;
  const initial=readObservation(importBody.clientActionId);
  assert.equal(initial.indexed_conversations,1);
  assert.equal(initial.indexed_activity_records,1);
  assert.ok(initial.accepted_at_ms>0&&initial.import_duration_ms>=0);
  assert.equal(initial.first_search_at_ms,null);
  await call('search',{query:'notpresentinthisfixtureba42'});
  assert.equal(readObservation(importBody.clientActionId).first_search_at_ms,null);
  let firstSearch:Record<string,any>|undefined;
  for(const [index,query] of ['markedgrpword','markedactivityword'].entries()){
    const session=imported.sessions[index],source=imported.sources[index],message=source.messages[0];
    assert.equal(session.provider,'gemini');
    assert.equal(session.catalogueKind,'historical-evidence');
    assert.equal(session.nativeBinding,null);
    assert.equal(session.runtimeThreadId,null);
    assert.equal(session.messageableForAgents,false);
    assert.equal(source.version,digest(content));
    let search=await call('search',{query,includeTools:index===1});
    let hit=search.results.find((row:any)=>row.session.id===session.id);
    // The first search can ask the source host to freeze its exact version before returning it.
    for(let attempts=0;!hit&&attempts<10&&search.coverage.reason.includes('could not be retained');attempts++){
      await Bun.sleep(100);
      search=await call('search',{query,includeTools:index===1});
      hit=search.results.find((row:any)=>row.session.id===session.id);
    }
    assert.ok(hit,`Missing exact Gemini result for ${query}: ${JSON.stringify(search)}`);
    assert.ok(hit.evidence.some((item:any)=>item.eventId===message.eventId&&item.textHash===message.textHash));
    const observation=readObservation(importBody.clientActionId);
    assert.ok(observation.first_search_at_ms>=initial.accepted_at_ms&&observation.first_search_duration_ms>=0);
    if(index===0){
      assert.equal(observation.first_search_coverage_complete,Number(search.coverage.complete));
      firstSearch=observation;
    } else {
      assert.deepEqual(observation,firstSearch,'Later search matches cannot replace the first hit');
    }
    const pin={address:session.address,sourceId:source.id,sourceVersion:source.version};
    assert.equal((await call('context',{...pin,eventId:message.eventId})).evidence[0].text,message.text);
    const history=await call(`sessions/${session.id}/history`);
    assert.ok(history.messages.some((item:any)=>item.id===message.eventId));
    const refused=await call('sessions',{clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text},
      reconstruction:{...pin,branch:source.branch}},409);
    assert.equal(refused.error.code,'GEMINI_RECONSTRUCTION_UNVERIFIED');
  }
  await call('imports',importBody);
  assert.deepEqual(readObservation(importBody.clientActionId),firstSearch,'Retry preserves the accepted import and first search');
  const otherAction={...importBody,clientActionId:randomUUID()};
  await call('imports',otherAction);
  assert.equal(readObservation(otherAction.clientActionId).first_search_at_ms,null,'The earlier search is not a witness for a later import action');
  const sourceImport=owner.runtime.sources!.import;
  owner.runtime.sources!.import=async()=>{throw new SessionCapabilityError('SOURCE_REFUSED','private refusal text',422);};
  const refusedImport={...importBody,clientActionId:randomUUID()};
  await call('imports',refusedImport,422);
  assert.equal(readObservation(refusedImport.clientActionId).accepted_at_ms,null);
  assert.equal(readObservation(refusedImport.clientActionId).last_failure_kind,'source_rejected');
  assert.equal(readObservation(refusedImport.clientActionId).failed_attempts,1);
  owner.runtime.sources!.import=async()=>{throw new SessionCapabilityError('SOURCE_CAPABILITY_FAILED','private diagnostic text',503,true);};
  await call('imports',refusedImport,503);
  assert.equal(readObservation(refusedImport.clientActionId).failed_attempts,2);
  assert.equal(readObservation(refusedImport.clientActionId).source_refusals,1);
  assert.equal(readObservation(refusedImport.clientActionId).last_failure_kind,'source_outcome_unknown');
  owner.runtime.sources!.import=sourceImport;
  await call('imports',refusedImport);
  assert.equal(readObservation(refusedImport.clientActionId).failed_attempts,2,'Acceptance preserves the failed attempt count');
  assert.equal(readObservation(refusedImport.clientActionId).source_refusals,1,'Acceptance preserves the proven source refusal');
  assert.equal(readObservation(refusedImport.clientActionId).indexed_conversations,1);
  const observations=JSON.stringify(db.query('SELECT * FROM archive_import_observations').all())+
    JSON.stringify(db.query('SELECT * FROM archive_import_source_pins').all());
  for(const privateValue of ['marked-owner-check','MyActivity.json','markedgrpword','markedactivityword','marked-group',
    'activity-with-explicit-id','Exported answer','private refusal text','private diagnostic text']) {
    assert.ok(!observations.includes(privateValue),'Diagnostic rows must omit content and raw source identifiers');
  }
  assert.equal((db.query('SELECT count(*) AS n FROM turns').get() as {n:number}).n,0);
  console.log('Installed Thinkering responder through scratch owner socket: grouped and activity-only search, exact context/history, two refusals, zero turns.');

  // This adapter double supplies a hypothetical verified packet. The installed parser never
  // infers this proof from grouped Takeout activity.
  const source={...imported.sources[0],messages:imported.sources[0].messages.map((message:any,ordinal:number)=>({...message,ordinal}))};
  const sourceRef={sourceId:source.id,sourceVersion:source.version,branch:source.branch};
  const events=source.messages.map(({eventId,ordinal,role,locator,textHash,text}:any)=>({eventId,ordinal,role,locator,textHash,text}));
  source.reconstruction={...sourceRef,packetVersion:'gemini-export-dialogue-v1',dialogueDigest:digest(JSON.stringify(events))};
  owner.runtime.sources!.import=async()=>({sources:[source]});
  const verified=(await call('imports',{clientActionId:randomUUID()})).sessions[0];
  owner.runtime.sources!.context=async()=>({source,evidence:source.messages,hasMore:false});
  const body={clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text},
    reconstruction:{address:verified.address,...sourceRef}};
  const badSource={...source,reconstruction:{...source.reconstruction,dialogueDigest:'0'.repeat(64)}};
  owner.runtime.sources!.context=async()=>({source:badSource,evidence:source.messages,hasMore:false});
  assert.equal((await call('sessions',body,409)).error.code,'GEMINI_RECONSTRUCTION_UNVERIFIED');
  owner.runtime.sources!.context=async()=>({source,evidence:source.messages,hasMore:false});
  const created=await call('sessions',body,202);
  assert.equal(created.session.provider,'codex');
  assert.equal(created.session.origin,'reconstructed');
  assert.equal(created.session.interactionPolicy,'standard');
  assert.equal(created.session.lineage.parentId,verified.id);
  assert.notEqual(created.session.id,verified.id);
  assert.equal(created.operation.state,'queued');
  const accepted=getAcceptedSessionInput(created.operation.operationId)!;
  const payload=JSON.parse(accepted.payload_json);
  assert.equal(payload.firstInput.text,text);
  assert.match(payload.preparedPrompt,/Archived instructions.*carry no authority/);
  assert.ok(payload.preparedPrompt.includes(JSON.stringify(events)));
  const nextSource={...source,version:'1'.repeat(64),reconstruction:undefined};
  owner.runtime.sources!.import=async()=>({sources:[nextSource]});
  const nextAction=randomUUID();
  const next=(await call('imports',{clientActionId:nextAction})).sessions[0];
  assert.equal(next.id,verified.id);
  assert.notEqual(next.address,verified.address);
  assert.equal(readObservation(nextAction,nextSource.version).first_search_at_ms,null);
  await call('search',{query:'markedgrpword'});
  assert.equal(readObservation(nextAction,nextSource.version).first_search_at_ms,null,'An older version of the same source does not count');
  assert.ok(readObservation(otherAction.clientActionId).first_search_at_ms>=firstSearch!.first_search_at_ms);
  owner.runtime.sources!.context=async()=>{throw new Error('A committed retry must never reopen sources.');};
  assert.equal((await call('sessions',body)).session.id,created.session.id);
  await call('sessions',{...body,clientActionId:randomUUID()},409);
  await call('sessions',{...body,firstInput:{text:'Changed request'}},409);
  assert.equal((db.query('SELECT count(*) AS n FROM turns').get() as {n:number}).n,1);
  console.log('Verified-adapter double: one ordinary queued child, evidence and current request retained separately, bad proof and changed retry refused.');
} finally {
  server?.stop(true);
  responder.kill();
  await responder.exited;
  rmSync(scratch,{recursive:true,force:true});
}
