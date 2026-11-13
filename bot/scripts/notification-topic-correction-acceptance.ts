// Deterministic owner acceptance for agent consolidation of duplicate bug-report topics.
// All rows and actions live in a disposable Concierge state directory.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NOTIFICATION_TOPIC_CORRECTION_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-notification-correction-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=NOTIFICATION_TOPIC_CORRECTION_TEST_AUTHORIZATION;

const [{db,claimNextQueuedTurn,markTurnProviderAdmissionIntended,acknowledgeTurnProviderInput},{SessionOwner},{SessionCommunicationCoordinator},
  {nativeRunId,updateSessionMetadata,recordSessionEvent,retainSessionInput},
  {topicsCommand,readTopic}]=await Promise.all([
  import('../src/state'),import('../src/session-owner'),import('../src/session-communication'),import('../src/session-inputs'),import('../src/session-topics')]);

const errors:unknown[]=[];
const owner=new SessionOwner({available:()=>true,wake:()=>{},stop:async()=>false,steer:()=>false},scratch);
const communication=new SessionCommunicationCoordinator({owner,isOwnerAlive:()=>true,onError:error=>errors.push(error)});
owner.communication=communication;

function run(){
  const claim=claimNextQueuedTurn('notification-correction-fixture');
  assert.ok(claim);
  assert.equal(markTurnProviderAdmissionIntended(claim.turn_id,'notification-correction-fixture',claim.dispatch_attempt),true);
  acknowledgeTurnProviderInput(claim.turn_id,'notification-correction-fixture',claim.dispatch_attempt,[]);
  const runId=nativeRunId(claim.turn_id),inputId=claim.accepted_input_id!;
  return {actor:{sessionId:claim.session_id,turnId:claim.turn_id,inputId,runId},source:{input_id:inputId,run_id:runId}};
}

try{
  communication.start();await communication.idle();
  const inbox=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'Notification correction fixture'}});
  const inboxId=Number(inbox.session.id.slice(10));updateSessionMetadata(inboxId,{inbox:true});
  const current=run();
  const makeCapture=(text:string,bugReport=false,files:{name:string;contentType:string;content?:string}[]=[],origin:'human'|'agent'='human'):string=>{
    const captureId=randomUUID(),id=`capture:${captureId}`;
    const attachments=files.map(file=>owner.upload({clientActionId:randomUUID(),name:file.name,contentType:file.contentType,
      base64:Buffer.from(file.content??file.name).toString('base64')}).attachment.id);
    const source={kind:'thinkering',id:captureId,recordedAt:new Date().toISOString(),metadata:bugReport?{client:'thinkering-bug-report'}:{}};
    retainSessionInput({id,sessionId:inboxId,scope:'surface:thinkering',actionId:randomUUID(),kind:'input',origin,
      payload:{text,attachments,capture:{id:captureId,source}}});
    recordSessionEvent({eventId:id,sessionId:inboxId,inputId:id,kind:'inbox_capture',payload:{captureId,source}});
    return id;
  };
  const first=makeCapture('Duplicate notification report A',true,[{name:'a.png',contentType:'image/png'}]);
  const correction=makeCapture('Human correction: keep this with the notification problem');
  const second=makeCapture('Duplicate notification report B',true,[{name:'b.png',contentType:'image/png'}]);
  const spotify=makeCapture('Spotify reconnect fails. Its notification opens the wrong thread.',true,[{name:'spotify.png',contentType:'image/png'}]);
  const originalPayloads=new Map([first,second,spotify].map(id=>[id,(db.query('SELECT payload_json FROM session_inputs WHERE id=?').get(id) as any).payload_json]));
  const originalAttachments=new Map([...originalPayloads].map(([id,payload])=>[id,owner.attachments(JSON.parse(payload).attachments)]));

  const area=topicsCommand(current.actor,{verb:'area.create',action_id:'correction-area',name:'Notification correction acceptance'}).area;
  const keeper=topicsCommand(current.actor,{verb:'create',action_id:'keeper-topic',title:'Notification report A',roots:[first],area_ids:[area.id]}).topic.topicId as string;
  const duplicate=topicsCommand(current.actor,{verb:'create',action_id:'duplicate-topic',title:'Notification report B',roots:[second],area_ids:[area.id]}).topic.topicId as string;
  const spotifyTopic=topicsCommand(current.actor,{verb:'create',action_id:'spotify-topic',title:'Spotify report',roots:[spotify],area_ids:[area.id]}).topic.topicId as string;
  topicsCommand(current.actor,{verb:'place',topic_id:keeper,action_id:'human-correction-placement',roots:[correction]});
  const requestA=topicsCommand(current.actor,{verb:'request.add',topic_id:keeper,action_id:'request-a',title:'Notification A',sources:[first,spotify],brief:'Investigate notification report A and its notification evidence.'}).request.requestId as string;
  const requestB=topicsCommand(current.actor,{verb:'request.add',topic_id:duplicate,action_id:'request-b',title:'Notification B',sources:[second],brief:'Investigate notification report B.'}).request.requestId as string;
  const repairRequest=topicsCommand(current.actor,{verb:'request.add',topic_id:keeper,action_id:'repair-request',title:'Consolidate reports',sources:[correction],brief:'Repair the supported consolidation boundary.'}).request.requestId as string;
  const investigator=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat'});
  const sharedDispatch=await communication.ask({source:current.source,action_id:'shared-notification-investigator',address:investigator.session.address,
    thread:first,summary:'Investigate the notification destination issue',text:'Investigate the notification destination issue from the retained reports.',requestedEffect:'work'});
  await communication.idle();
  topicsCommand(current.actor,{verb:'request.link',request_id:requestA,action_id:'link-dispatch-a',dispatch:sharedDispatch.request_id});
  topicsCommand(current.actor,{verb:'request.link',request_id:requestB,action_id:'link-dispatch-b',dispatch:sharedDispatch.request_id});
  const dispatchBefore=communication.inspect(sharedDispatch.request_id);

  const refuses=(body:any,code:string)=>assert.throws(()=>topicsCommand(current.actor,body),(error:any)=>error?.code===code);
  refuses({verb:'merge',topic_id:duplicate,into:keeper,action_id:'missing-correction',reason:'human-approved'},'BUG_REPORT_CORRECTION_SOURCE_REQUIRED');
  refuses({verb:'merge',topic_id:duplicate,into:keeper,action_id:'unknown-correction',reason:'Same concern',correction_source_id:'missing'},'BUG_REPORT_CORRECTION_SOURCE_REQUIRED');
  refuses({verb:'merge',topic_id:duplicate,into:keeper,action_id:'bug-as-correction',reason:'Same concern',correction_source_id:first},'BUG_REPORT_CORRECTION_SOURCE_REQUIRED');
  const agentCorrection=makeCapture('Agent claim of correction',false,[],'agent');
  topicsCommand(current.actor,{verb:'place',topic_id:keeper,roots:[agentCorrection],action_id:'agent-correction-place'});
  refuses({verb:'merge',topic_id:duplicate,into:keeper,action_id:'agent-as-correction',reason:'Same concern',correction_source_id:agentCorrection},'BUG_REPORT_CORRECTION_SOURCE_REQUIRED');
  // Keep the baseline three roots: this unrelated agent source is filed elsewhere.
  const ordinary=makeCapture('Existing unrelated work');
  const ordinaryTopic=topicsCommand(current.actor,{verb:'create',action_id:'ordinary-topic',title:'Unrelated work',roots:[ordinary],area_ids:[area.id]}).topic.topicId;
  topicsCommand(current.actor,{verb:'place',topic_id:ordinaryTopic,roots:[agentCorrection],action_id:'agent-correction-remove'});
  refuses({verb:'merge',topic_id:duplicate,into:keeper,action_id:'unrelated-correction',reason:'Same concern',correction_source_id:ordinary},'BUG_REPORT_CORRECTION_SOURCE_REQUIRED');
  refuses({verb:'merge',topic_id:duplicate,into:ordinaryTopic,action_id:'bug-into-work',reason:'Same concern',correction_source_id:correction},'BUG_REPORT_OWN_THREAD');
  refuses({verb:'place',topic_id:keeper,roots:[second],action_id:'agent-place'},'BUG_REPORT_OWN_THREAD');
  const fresh=makeCapture('Fresh independent report',true);
  refuses({verb:'create',action_id:'shared-intake',title:'Wrong combined intake',roots:[fresh,makeCapture('Another unplaced request')],area_ids:[area.id]},'BUG_REPORT_OWN_THREAD');
  refuses({verb:'place',topic_id:ordinaryTopic,roots:[fresh],action_id:'fresh-place'},'BUG_REPORT_OWN_THREAD');
  assert.throws(()=>communication.thread({source:current.source,action_id:'fresh-thread',input_id:fresh,thread:ordinary}),/A new bug report first needs independent Inbox intake/);
  refuses({verb:'route',topic_id:keeper,message_id:fresh,side_scope:'Notification side',reason:'Related symptom',action_id:'fresh-route'},'ROUTE_SOURCE_UNPLACED');
  topicsCommand(current.actor,{verb:'create',action_id:'fresh-independent',title:'Fresh independent report',roots:[fresh],area_ids:[area.id]});
  refuses({verb:'route',topic_id:keeper,message_id:spotify,action_id:'unscoped-route'},'BUG_REPORT_SECONDARY_ROUTE_REQUIRED');
  refuses({verb:'route',topic_id:keeper,message_id:spotify,side_scope:'Notification side',action_id:'unreasoned-route'},'BUG_REPORT_SECONDARY_ROUTE_REQUIRED');

  const routeAction={verb:'route',topic_id:keeper,message_id:spotify,action_id:'notification-side-route',
    reason:'The same notification navigation symptom occurs in this independently filed report',side_scope:'Investigate only the notification opening the wrong thread; reconnect remains in Spotify.'};
  const routed=topicsCommand(current.actor,routeAction);
  assert.equal(routed.route.sourceMessageId,spotify);
  assert.equal(routed.route.sourceRoot,spotify);
  assert.equal(routed.route.destinationTopicId,keeper);
  assert.equal(topicsCommand(current.actor,routeAction).duplicate,true);
  assert.throws(()=>topicsCommand(current.actor,{...routeAction,side_scope:'Reconnect too'}),/Idempotency conflict/);
  assert.deepEqual(readTopic(spotifyTopic).topic.roots,[spotify],'Spotify remains the independent primary topic');
  const mergeAction={verb:'merge',topic_id:duplicate,into:keeper,action_id:'agent-notification-correction',reason:'Same notification issue identified by his correction',correction_source_id:correction};
  const merged=topicsCommand(current.actor,mergeAction);
  assert.equal(merged.merged.topicId,duplicate);
  assert.equal(merged.topic.topicId,keeper);
  const replay=topicsCommand(current.actor,mergeAction);
  assert.equal(replay.duplicate,true,'the retained agent action returns its first receipt');
  assert.deepEqual(replay.merged,merged.merged,'replay does not repeat the merge');
  assert.throws(()=>topicsCommand(current.actor,{...mergeAction,correction_source_id:first}),/Idempotency conflict/);

  const destination=readTopic(keeper);
  assert.deepEqual(new Set(destination.topic.roots),new Set([first,correction,second,routed.route.destinationMessageId]));
  assert.deepEqual(new Set(destination.requests.map((request:any)=>request.id)),new Set([requestA,requestB,repairRequest]));
  assert.equal(destination.requests.find((request:any)=>request.id===requestA).state,'open');
  assert.equal(destination.requests.find((request:any)=>request.id===requestB).state,'open');
  assert.deepEqual(destination.requests.find((request:any)=>request.id===requestA).sources.map((source:any)=>source.inputId),[first,spotify]);
  assert.deepEqual(destination.requests.flatMap((request:any)=>request.dispatches.map((dispatch:any)=>dispatch.requestId)),
    [sharedDispatch.request_id,sharedDispatch.request_id],'the one existing dispatch remains linked to both requests');
  assert.deepEqual(communication.inspect(sharedDispatch.request_id),dispatchBefore,'merge neither cancels nor replays the worker request');
  assert.equal(destination.questions.length,0,'merge did not invent, clear or move attention questions');
  for(const [id,payload] of originalPayloads){
    assert.equal((db.query('SELECT payload_json FROM session_inputs WHERE id=?').get(id) as any).payload_json,payload);
    assert.deepEqual(owner.attachments(JSON.parse(payload).attachments),originalAttachments.get(id),'original attachment bytes and digests are unchanged');
  }
  const routedEvent=db.query('SELECT * FROM session_owner_events WHERE event_id=?').get(routed.route.destinationMessageId) as any;
  const {inboxMessage}=await import('../src/session-inbox');
  const projection=inboxMessage(routedEvent);
  assert.equal(projection.content,routeAction.side_scope);
  assert.equal(projection.author.kind,'agent');
  assert.equal(projection.role,'assistant');
  assert.equal(projection.routedFrom.messageId,spotify);
  assert.equal(projection.attachments[0].name,'spotify.png');
  const {preparedInboxDisplay}=await import('../src/presentation-inbox-display');
  const prepared=preparedInboxDisplay(db,inboxId,routedEvent.sequence,routed.route.destinationMessageId)!;
  const displayed=prepared.detailJson?JSON.parse(prepared.detailJson):prepared.preview;
  for(const field of ['content','role','author','routedFrom','attachments'])assert.deepEqual(displayed[field],projection[field],`prepared page and detail agree on ${field}`);
  const mergeEvent=JSON.parse((db.query("SELECT payload_json FROM session_owner_events WHERE kind='topic' AND json_extract(payload_json,'$.change')='merged'").get() as any).payload_json);
  assert.equal(mergeEvent.by.kind,'agent');
  assert.equal(mergeEvent.by.inputId,current.actor.inputId);
  assert.equal(mergeEvent.correctionSourceId,correction);
  assert.equal(readTopic(duplicate).topic.state,'closed');
  assert.equal(db.query("SELECT COUNT(*) AS count FROM session_owner_events WHERE kind='topic' AND json_extract(payload_json,'$.change')='merged'").get().count,1,
    'the owner records one merge event');
  const ordinaryDestination=topicsCommand(current.actor,{verb:'create',action_id:'ordinary-destination',title:'Another work thread',area_ids:[area.id]}).topic.topicId;
  const ordinaryRoute=topicsCommand(current.actor,{verb:'route',topic_id:ordinaryDestination,message_id:ordinary,action_id:'ordinary-route'});
  const ordinaryProjection=inboxMessage(db.query('SELECT * FROM session_owner_events WHERE event_id=?').get(ordinaryRoute.route.destinationMessageId));
  assert.equal(ordinaryProjection.content,'Existing unrelated work');
  assert.equal(ordinaryProjection.author.kind,'human','an ordinary unscoped route still quotes the original author');
  const ordinaryRoutePayload=JSON.parse((db.query("SELECT payload_json FROM session_inputs WHERE scope=? AND action_id='ordinary-route'").get(`communication:${current.actor.inputId}`) as any).payload_json);
  assert.deepEqual(ordinaryRoutePayload,{kind:'topic-route',messageId:ordinary,destination:ordinaryDestination,reason:null},'ordinary action payload remains compatible with accepted pre-release retries');
  assert.equal(topicsCommand(current.actor,{verb:'merge',topic_id:ordinaryTopic,into:ordinaryDestination,action_id:'ordinary-merge',reason:'Ordinary organization'}).topic.topicId,ordinaryDestination);
  const ordinaryRoots=readTopic(ordinaryDestination).topic.roots;
  const ordinaryIntoBug={verb:'merge',topic_id:ordinaryDestination,into:keeper,action_id:'ordinary-into-bug-topic',reason:'Related ordinary captures join the existing notification concern'};
  assert.equal(topicsCommand(current.actor,ordinaryIntoBug).topic.topicId,keeper,'ordinary-topic merging into a bug topic remains supported without a bug consolidation correction');
  assert.equal(topicsCommand(current.actor,ordinaryIntoBug).duplicate,true);
  assert.deepEqual(new Set(readTopic(keeper).topic.roots),new Set([...destination.topic.roots,...ordinaryRoots]));
  assert.deepEqual(new Set(readTopic(keeper).requests.map((request:any)=>request.id)),new Set([requestA,requestB,repairRequest]));
  assert.deepEqual(communication.inspect(sharedDispatch.request_id),dispatchBefore);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({fixture:'notification-topic-correction-acceptance',agentMerge:true,correctionSourceRequired:true,
    guardedDirectIntake:true,spotifySideRouted:true,originalSourcesRetained:true,requestsRetained:true,sharedDispatchPreserved:true,agentActionIdempotent:true,ordinaryTopicIntoBugTopic:true}));
}finally{
  await communication.stop();
  rmSync(scratch,{recursive:true,force:true});
}
