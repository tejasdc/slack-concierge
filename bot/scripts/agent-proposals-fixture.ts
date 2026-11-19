import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LEGACY_TOPIC_COMPLETION_TEST_AUTHORIZATION} from '../src/test-authorizations';

/**
 * Work an agent found on its own waits for his accept [decision: agent-found-work-waits-for-his-accept]:
 * an uncertain report becomes a To-dos candidate and nothing in the Inbox, his Accept admits it as an
 * ordinary agent report, his Dismiss closes it and tells the reporter, one agent cannot flood him, a
 * certain report goes straight in, and a watch-woken run without his lineage counts as found work.
 */
const scratch=mkdtempSync(join(tmpdir(),'concierge-agent-proposals-'));
const socket=join(scratch,'thinkering.sock');
Object.assign(process.env,{CONCIERGE_STATE_DIR:scratch,CONCIERGE_CAPTURE_STATE_DIR:join(scratch,'capture'),CONCIERGE_TEST_MODE:'1',
  CONCIERGE_TEST_AUTHORIZATION:LEGACY_TOPIC_COMPLETION_TEST_AUTHORIZATION,THINKERING_SESSION_CAPABILITY_SOCKET:socket});
delete process.env.CONCIERGE_THINKERING_CAPABILITY_URL;
type Todo={id:string;text:string;status:string;updatedAt:string;source:any};
const todos=new Map<string,Todo>();
const calls:string[]=[];
let loseNextAnswer=false;
const {proposalTodoId}=await import('../src/agent-proposals');
const server=Bun.serve({unix:socket,async fetch(request){
  const url=new URL(request.url);calls.push(`${request.method} ${url.pathname}`);
  if(request.method==='POST'&&url.pathname==='/todos'){
    const body=await request.json() as any;
    assert.equal(body.candidate,true);assert.equal(body.source.type,'concierge-proposal');
    assert.ok(request.headers.get('x-concierge-agent-source'),'The reporting agent is the actor');
    const id=proposalTodoId(body.source.id);
    if(todos.has(id))return Response.json({error:'TODO_CANDIDATE_DUPLICATE'},{status:400});
    if([...todos.values()].some(todo=>todo.text===body.text&&todo.source.quote===body.source.quote))return Response.json({error:'TODO_CANDIDATE_DUPLICATE'},{status:400});
    todos.set(id,{id,text:body.text,status:'candidate',updatedAt:new Date().toISOString(),source:body.source});
    if(loseNextAnswer){loseNextAnswer=false;return Response.json({error:'GATEWAY_TIMEOUT'},{status:504});}
    return Response.json({task:todos.get(id)});
  }
  if(request.method==='GET'&&url.pathname==='/todos/tasks')return Response.json({items:[...todos.values()]});
  if(request.method==='POST'&&url.pathname==='/todos/decision'){
    const body=await request.json() as any;const todo=todos.get(body.id)!;
    assert.ok(request.headers.get('x-agent-why'));
    if(todo.updatedAt!==body.expectedUpdatedAt)return Response.json({error:'STALE_REVISION'},{status:409});
    todo.status='done';todo.updatedAt=new Date().toISOString();return Response.json({task:todo});
  }
  return Response.json({error:'NOT_FOUND'},{status:404});
}});
const [{db,finishTurn,claimNextQueuedTurn,markTurnProviderAdmissionIntended,acknowledgeTurnProviderInput},{SessionOwner},{nativeRunId},{hasHumanLineage,foundOnItsOwn},{PENDING_PROPOSALS_PER_AGENT}]=await Promise.all([
  import('../src/state'),import('../src/session-owner'),import('../src/session-inputs'),import('../src/session-communication'),import('../src/agent-proposals')]);
const workspace=join(scratch,'workspace');mkdirSync(join(workspace,'slack-inbox','.git'),{recursive:true});
writeFileSync(join(workspace,'slack-inbox','AGENTS.md'),'Disposable Inbox fixture.\n');
const owner=new SessionOwner({available:()=>true,wake:()=>{},steer:()=>false,stop:async()=>false},workspace);
const pass=async()=>{owner.settleProposalsSoon();await (owner as any).proposalPass;};
const claim=(worker:string)=>{
  const claimed=claimNextQueuedTurn(worker);assert.ok(claimed);
  assert.equal(markTurnProviderAdmissionIntended(claimed.turn_id,worker,claimed.dispatch_attempt),true);
  acknowledgeTurnProviderInput(claimed.turn_id,worker,claimed.dispatch_attempt,[]);
  return claimed;
};
const count=(sql:string,...args:unknown[])=>(db.query(sql).get(...args) as {n:number}).n;
try{
  await owner.create({clientActionId:'reporter',provider:'codex',purpose:'chat',firstInput:{text:'Read the mail and report what you find.'}});
  const first=claim('agent-proposals-fixture');
  const source={inputId:first.accepted_input_id!,runId:nativeRunId(first.turn_id)};
  const report=(actionId:string,extra:Record<string,unknown>={})=>owner.reportAgentIssue({source,actionId,title:`Maybe handle ${actionId}`,text:`Apple mail about an app (${actionId}).`,...extra}) as Promise<any>;

  // 1. Uncertain: a proposal, nothing in the Inbox.
  const proposed=await report('apple-mail');
  assert.equal(proposed.proposal.state,'proposed');assert.equal(proposed.report,undefined);
  assert.equal(count("SELECT count(*) AS n FROM session_inputs WHERE scope='capture:agent-report'"),0,'No Inbox capture');
  assert.equal(count("SELECT count(*) AS n FROM inbox_requests"),0,'No Inbox request for upkeep to remind about');
  assert.deepEqual(await report('apple-mail'),{...proposed,proposal:{...proposed.proposal}},'Exact retry returns the same proposal');
  await assert.rejects(report('apple-mail',{text:'other words'}),/Idempotency conflict/);
  await pass();
  const offered=[...todos.values()][0]!;
  assert.equal(offered.status,'candidate');assert.equal(offered.source.id,proposed.proposal.id);
  await pass();
  assert.equal(count("SELECT count(*) AS n FROM inbox_requests"),0,'Undecided proposal stays out of the Inbox across passes');

  // 2. His Accept admits it as an ordinary agent report and takes it off his list.
  offered.status='open';offered.updatedAt=new Date().toISOString();
  await pass();
  assert.equal((db.query('SELECT state FROM agent_proposals WHERE capture_id=?').get(proposed.proposal.id) as any).state,'accepted');
  assert.equal(count("SELECT count(*) AS n FROM inbox_requests WHERE request_id LIKE 'req:agent-report:%'"),1,'Accepted proposal opens its Inbox request');
  assert.equal(count("SELECT count(*) AS n FROM session_inputs WHERE scope='capture:agent-report'"),1);
  assert.equal(offered.status,'done','Accepted work leaves his list');
  const again=await report('apple-mail');
  assert.ok(again.report?.requestId,'A retry after acceptance returns the Inbox receipt');

  // 3. His Dismiss closes without work and tells the reporter.
  const dismissed=await report('ideaflow-mail');
  await pass();
  const second=[...todos.values()].find(todo=>todo.source.id===dismissed.proposal.id)!;
  second.status='dropped';
  await pass();
  assert.equal((db.query('SELECT state FROM agent_proposals WHERE capture_id=?').get(dismissed.proposal.id) as any).state,'declined');
  assert.equal(count("SELECT count(*) AS n FROM inbox_requests WHERE request_id LIKE 'req:agent-report:%'"),1,'Dismissed proposal sends no work');
  assert.equal(count('SELECT count(*) AS n FROM session_inputs WHERE id=?',`proposal-decision:${dismissed.proposal.id}`),1,'The reporter is told so it can learn');
  const next=await report('third-mail');
  assert.deepEqual(next.proposal.decidedBefore.map((item:any)=>item.decision).sort(),['accepted','declined'],'The receipt shows his earlier decisions');

  // 3b. A lost answer: the to-do was made, the retry finds it by its fixed id.
  loseNextAnswer=true;
  const lost=await report('lost-answer');
  await pass();
  assert.equal((db.query('SELECT todo_id FROM agent_proposals WHERE capture_id=?').get(lost.proposal.id) as any).todo_id,null);
  await pass();
  assert.equal((db.query('SELECT todo_id FROM agent_proposals WHERE capture_id=?').get(lost.proposal.id) as any).todo_id,proposalTodoId(lost.proposal.id),'Adopts its own to-do');

  // 4. One agent cannot flood him.
  const waiting=()=>count("SELECT count(*) AS n FROM agent_proposals WHERE state='proposed'");
  for(let index=1;waiting()<PENDING_PROPOSALS_PER_AGENT;index++)await report(`flood-${index}`);
  await assert.rejects(report('flood-over'),/has not decided your 3 earlier proposals/);

  // 4b. Accepted but admission never happened (the owner stopped in between): the next pass admits it.
  const pending=db.query("SELECT capture_id,todo_id FROM agent_proposals WHERE state='proposed' AND todo_id IS NOT NULL LIMIT 1").get() as any;
  db.query("UPDATE agent_proposals SET state='accepted',decided_at_ms=? WHERE capture_id=?").run(Date.now(),pending.capture_id);
  todos.get(pending.todo_id)!.status='open';
  await pass();
  assert.ok((db.query('SELECT admitted_input_id FROM agent_proposals WHERE capture_id=?').get(pending.capture_id) as any).admitted_input_id,'Re-admitted');
  assert.equal(todos.get(pending.todo_id)!.status,'done');

  // 4c. Re-proposing what he dismissed (same words and quote) is not offered again.
  await report('ideaflow-mail-again',{title:'Maybe handle ideaflow-mail',text:'Apple mail about an app (ideaflow-mail).'}).then(async again=>{
    await pass();
    assert.equal((db.query('SELECT state FROM agent_proposals WHERE capture_id=?').get(again.proposal.id) as any).state,'duplicate');
  });

  // 5. Certain work goes straight to the Inbox; a short reason is refused.
  await assert.rejects(report('vague',{certain:'yes'}),/certainly his/);
  const certain=await report('health',{certain:'Concierge itself failed to deliver a reply; this is his own system.'});
  assert.ok(certain.report?.requestId);assert.equal(certain.proposal,undefined);

  // 6. A run woken by a service (a watch) has no human lineage; his own message does.
  assert.equal(hasHumanLineage(first.session_id,first.turn_id),true,'His first message is human lineage');
  finishTurn(first.turn_id,'done','Reported.');
  owner.admit({sessionId:first.session_id,inputId:'watch-wake',origin:'service',sourceInputId:'watch-wake',sourceRunId:'watch-wake',requestId:'watch-wake',text:'Your watched file changed.',threadReplyNotRequired:true});
  let woken=claim('agent-proposals-fixture-2');
  for(let tries=0;woken.session_id!==first.session_id&&tries<10;tries++)woken=claim(`agent-proposals-fixture-${tries+3}`);
  assert.equal(woken.session_id,first.session_id);
  assert.equal(hasHumanLineage(woken.session_id,woken.turn_id),false,'A watch wake has no human lineage');
  assert.equal(foundOnItsOwn(woken.session_id,woken.turn_id),true,'A watch wake is found work');
  assert.equal(foundOnItsOwn(first.session_id,first.turn_id),false,'A run holding his message is not');

  const stats=owner.agentProposals(new URLSearchParams({days:'7'}));
  assert.equal(stats.certainReports,1);
  console.log(JSON.stringify({fixture:'agent-proposals',proposalOutsideInbox:true,acceptAdmits:true,dismissTells:true,cap:true,certain:true,lineage:true,calls:calls.length}));
}finally{server.stop(true);rmSync(scratch,{recursive:true,force:true});}
