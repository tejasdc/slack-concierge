import {strict as assert} from 'node:assert';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runFixtureChild} from './fixture-child';

// Handoff 2ace9de1 (2026-11-16): a Codex asker held one ChatGPT request that was both its `answer`
// duty and a `sent` request. Acceptance moved the request with the answer, then refused the sent item
// as "changed during handoff" on every retry. This fixture proves the pair moves once, and that a
// request which really changed after the digest is still refused.
const authorization='handoff-chatgpt-answer-sent-2026-11-16';
export async function checkHandoffChatGptAnswerSent(){
 const state=await mkdtemp(join(tmpdir(),'concierge-handoff-answer-sent-'));
 try{return await runFixtureChild({command:process.execPath,args:[import.meta.path,'--child'],env:{...process.env,
  CONCIERGE_TEST_MODE:'1',CONCIERGE_TEST_AUTHORIZATION:authorization,CONCIERGE_STATE_DIR:state,
  CONCIERGE_CAPTURE_STATE_DIR:join(state,'capture'),
  // Lab inventory reads a key file before any network call; a missing file records an omission at once.
  THINKERING_AGENT_TEST_KEY_FILE:join(state,'no-lab-key')},deadlineMs:30_000,fixture:'handoff-chatgpt-answer-sent'});}
 finally{await rm(state,{recursive:true,force:true});}
}

async function child(){
 const [{db},{createNativeSession,retainSessionInput},{acceptHandoff,proposeHandoff}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/session-handoff')]);
 let sequence=0;
 const askerWithChatGptRequest=()=>{
  sequence++;
  const asker=createNativeSession('codex',{title:`Handoff answer fixture asker ${sequence}`});
  const chatgpt=createNativeSession('codex',{title:`Handoff answer fixture ChatGPT stand-in ${sequence}`});
  const input=retainSessionInput({sessionId:asker.id,scope:'fixture',actionId:`asker-${sequence}`,kind:'input',origin:'human',payload:{text:'fixture'}}).input;
  const turn=db.query("INSERT INTO turns(session_id,slack_user_msg_ts,user_text,accepted_input_id,status) VALUES(?,?,'fixture',?,'done') RETURNING id")
   .get(asker.id,`fixture-${input.id}`,input.id) as {id:number};
  const requestId=`handoff-answer-sent-request-${sequence}`,now=Date.now();
  db.query(`INSERT INTO session_communication_requests(request_id,source_turn_id,source_session_id,action_id,target_session_id,payload_json,payload_hash,due_at_ms,created_at_ms,source_input_id)
   VALUES(?,?,?,?,?,?,?,?,?,?)`).run(requestId,turn.id,asker.id,`ask-chatgpt-${sequence}`,chatgpt.id,JSON.stringify({text:'question'}),'fixture-hash',now+60_000,now,input.id);
  db.query(`INSERT INTO session_chatgpt_obligations(obligation_id,task_kind,task_id,asker_session_id,question_text,target_session_id,state,active_request_id,
   next_action,due_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
   .run(requestId,'direct_input',input.id,asker.id,'question',`concierge:${chatgpt.id}`,'awaiting_answer',requestId,'wait',now+60_000,now,now);
  return {asker,input,requestId};
 };
 const propose=async(fixture:ReturnType<typeof askerWithChatGptRequest>)=>{
  const proposed=await proposeHandoff({actorSession:fixture.asker.id,inputId:fixture.input.id,runId:'fixture-run',predecessorId:fixture.asker.id,
   provider:'cc-sonnet',reason:'Codex weekly allowance exhausted',actionId:`handoff-${fixture.requestId}`}) as any;
  const successorId=Number(String(proposed.successor).replace('concierge:',''));
  return {proposed,successorId,accept:()=>acceptHandoff({actorSession:successorId,inputId:`handoff:${proposed.handoffId}`,runId:'successor-run',
   handoffId:proposed.handoffId,digest:proposed.digest}) as Promise<any>};
 };
 const source=(requestId:string)=>(db.query('SELECT source_session_id FROM session_communication_requests WHERE request_id=?').get(requestId) as {source_session_id:number}).source_session_id;

 const pair=askerWithChatGptRequest();
 const moved=await propose(pair);
 assert.deepEqual(moved.proposed.inventory.items.map((item:any)=>item.id),[`answer:${pair.requestId}`,`sent:${pair.requestId}`],
  'the live shape: one ChatGPT request is both an answer duty and a sent request');
 const accepted=await moved.accept();
 assert.equal(accepted.accepted,true,`answer+sent handoff accepts: ${JSON.stringify(accepted)}`);
 assert.equal(source(pair.requestId),moved.successorId,'the request now belongs to the successor');
 assert.deepEqual(db.query('SELECT asker_session_id,generation FROM session_chatgpt_obligations WHERE obligation_id=?').get(pair.requestId),
  {asker_session_id:moved.successorId,generation:1},'the answer duty moved exactly once');
 assert.deepEqual(db.query('SELECT kind,ref FROM session_handoff_items WHERE handoff_id=? ORDER BY rowid').all(moved.proposed.handoffId),
  [{kind:'answer',ref:pair.requestId},{kind:'sent',ref:pair.requestId}],'both items are recorded once each');
 const again=await moved.accept();
 assert.equal(again.duplicate,true,'a repeated acceptance is the same accepted handoff');

 // A request that really changed after the digest is still refused and nothing moves.
 const settled=askerWithChatGptRequest();
 const refused=await propose(settled);
 db.query("UPDATE session_communication_requests SET outcome='completed' WHERE request_id=?").run(settled.requestId);
 const result=await refused.accept();
 assert.equal(result.accepted,false,'a request settled after the digest is not silently moved');
 assert.deepEqual(db.query('SELECT state FROM session_handoffs WHERE id=?').get(refused.proposed.handoffId),{state:'proposed'});
 assert.equal(source(settled.requestId),settled.asker.id,'the settled request stays with its predecessor');

 // A request another session took over is refused inside the transaction even with an unchanged digest.
 const stolen=askerWithChatGptRequest();
 const other=createNativeSession('codex',{title:'Handoff answer fixture other owner'});
 const takeover=await propose(stolen);
 db.query('UPDATE session_communication_requests SET source_session_id=? WHERE request_id=?').run(other.id,stolen.requestId);
 db.query('UPDATE session_chatgpt_obligations SET asker_session_id=? WHERE obligation_id=?').run(other.id,stolen.requestId);
 const stolenResult=await takeover.accept().then(value=>value,error=>({error:String(error)}));
 assert.ok(!('accepted' in stolenResult)||stolenResult.accepted===false,`a request owned elsewhere is refused: ${JSON.stringify(stolenResult)}`);
 assert.equal(source(stolen.requestId),other.id,'the other owner keeps its request');

 console.log(JSON.stringify({fixture:'handoff-chatgpt-answer-sent',answerAndSentMoveOnce:true,settledRequestRefused:true,foreignOwnerRefused:true}));
}
if(import.meta.main){if(process.argv[2]==='--child')child().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});else console.log(JSON.stringify(await checkHandoffChatGptAnswerSent()));}
