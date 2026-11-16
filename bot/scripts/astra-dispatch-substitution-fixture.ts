import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-astra-dispatch-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION;
const [{db,claimNextQueuedTurn},{createNativeSession,retainSessionInput,enqueueSessionInput,sessionMetadata},{SessionOwner},{SessionCommunicationCoordinator},{dispatchModelForTurn},{astraDenialStatus},{runCodexTurn}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/session-owner'),import('../src/session-communication'),
  import('../src/astra-turn-gate'),import('../src/turn-execution'),import('../src/codex')]);
const events=(turnId:number,kind:string)=>(db.query('SELECT payload_json FROM session_owner_events WHERE turn_id=? AND kind=?').all(turnId,kind) as {payload_json:string}[]).map(row=>JSON.parse(row.payload_json));
try{
  const owner=new SessionOwner({available:()=>true,wake:()=>{},stop:async()=>false,steer:()=>false,
    capabilities:()=>({models:['gpt-6-astra','gpt-6-sol']})} as any,scratch);
  const communication=new SessionCommunicationCoordinator({owner,isOwnerAlive:()=>true,onError:()=>{}});
  // An Astra-bound session whose work comes from agents, as sessions 8245, 3081 and 3558 were.
  const session=createNativeSession('codex',{title:'agent-bound astra',summary:undefined,purpose:'develop',origin:'native',model:'gpt-6-astra'});
  db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run('astra-thread',session.id);
  let n=0;
  const start=(origin:'agent'|'human',payload:Record<string,unknown>)=>{
    const id=`astra-input-${++n}`;
    const input=retainSessionInput({id,sessionId:session.id,scope:'fixture',actionId:id,kind:'input',origin,payload:{text:'Continue.',...payload}}).input;
    enqueueSessionInput(input.id);
    const turn=claimNextQueuedTurn('fixture')!.turn_id;
    db.query('UPDATE turns SET provider_turn_id=? WHERE id=?').run(`provider-${id}`,turn);
    return {input,turn,providerTurnId:`provider-${id}`};
  };
  const dispatch=(turn:{input:{id:string};turn:number})=>dispatchModelForTurn({sessionId:session.id,turnId:turn.turn,inputId:turn.input.id,
    model:'gpt-6-astra',providerSessionId:'astra-thread',dispatchAttempt:1});
  const gate=(turn:{providerTurnId:string})=>communication.modelStartGate({providerSessionId:'astra-thread',model:'gpt-6-astra',providerTurnId:turn.providerTurnId});
  const finish=(turn:{turn:number})=>db.query("UPDATE turns SET status='done' WHERE id=?").run(turn.turn);

  const agent=start('agent',{});
  assert.equal(dispatch(agent),'gpt-6.1-sol','an agent turn to an Astra-bound session is dispatched on Sol');
  const substitution=events(agent.turn,'model_substitution');
  assert.equal(substitution.length,1);
  assert.deepEqual({from:substitution[0].from,to:substitution[0].to,turnId:substitution[0].turnId,inputId:substitution[0].inputId},
    {from:'gpt-6-astra',to:'gpt-6.1-sol',turnId:agent.turn,inputId:agent.input.id});
  assert.match(substitution[0].reason,/Astra|escalat/i);
  assert.equal(dispatch(agent),'gpt-6.1-sol');
  assert.equal(events(agent.turn,'model_substitution').length,1,'the substitution is recorded once per attempt');
  assert.equal(sessionMetadata(db.query('SELECT * FROM sessions WHERE id=?').get(session.id) as any).model,'gpt-6-astra','the stored binding is not changed');
  assert.equal(astraDenialStatus(agent.turn),null,'no denial before the hook has refused anything');
  const denied=gate(agent);
  assert.equal(denied.allowed,false,'the gate itself still refuses this turn');
  gate(agent);
  const denials=events(agent.turn,'model_start_denied');
  assert.equal(denials.length,1,'a denial is recorded once per turn');
  assert.equal(denials[0].message,denied.message);
  assert.equal(denials[0].model,'gpt-6-astra');
  assert.match(astraDenialStatus(agent.turn)!,/^Blocked by the Astra escalation check: /);
  assert.ok(astraDenialStatus(agent.turn)!.includes(denied.message!));
  finish(agent);

  const human=start('human',{});
  assert.equal(dispatch(human),'gpt-6-astra','a human-authored input stays on Astra');
  assert.equal(events(human.turn,'model_substitution').length,0);
  assert.equal(gate(human).allowed,true);
  finish(human);

  const reason=start('agent',{escalationReason:'Third failed fix of the same issue; ChatGPT Pro answer failed to hold.'});
  assert.equal(dispatch(reason),'gpt-6-astra','an input with a recorded escalation reason stays on Astra');
  assert.equal(events(reason.turn,'model_substitution').length,0);
  assert.equal(gate(reason).allowed,true);
  finish(reason);

  // The per-turn model reaches turn/start, which is where a warm thread reads it.
  const calls:Array<{method:string;params:any}>=[];
  const listeners=new Set<(event:any)=>void>();
  const client={async connect(){return 1;},
    async request(method:string,params:any){
      calls.push({method,params});
      if(method==='thread/resume')return {thread:{id:params.threadId},model:params.model};
      queueMicrotask(()=>{for(const listener of listeners)listener({method:'turn/completed',params:{threadId:params.threadId,
        turn:{id:'native-turn',status:'completed',error:null,items:[{type:'userMessage',clientId:params.clientUserMessageId}]}}});});
      return {turn:{id:'native-turn'}};
    },
    async notify(){},onNotification(listener:(event:any)=>void){listeners.add(listener);return ()=>listeners.delete(listener);},
    onDisconnect(){return ()=>true;},waitForDisconnect(){return new Promise<void>(()=>{});}};
  await runCodexTurn({prompt:'substituted turn',cwd:scratch,additionalDirs:[],sessionUUID:'astra-thread',appServerClient:client as any,
    model:'gpt-6.1-sol',turnModelOverride:'gpt-6.1-sol',reasoning_effort:'xhigh',clientUserMessageId:'slack-concierge:turn:1:attempt:1'});
  assert.equal(calls.find(call=>call.method==='thread/resume')!.params.model,'gpt-6.1-sol');
  const turnStart=calls.find(call=>call.method==='turn/start')!.params;
  assert.equal(turnStart.model,'gpt-6.1-sol');
  assert.equal(turnStart.effort,'xhigh','the session reasoning effort is kept');
  calls.length=0;
  await runCodexTurn({prompt:'astra turn',cwd:scratch,additionalDirs:[],sessionUUID:'astra-thread',appServerClient:client as any,
    model:'gpt-6-astra',reasoning_effort:'xhigh',clientUserMessageId:'slack-concierge:turn:2:attempt:1'});
  assert.equal('model' in calls.find(call=>call.method==='turn/start')!.params,false,'an Astra turn sends no override');
  console.log('Astra dispatch: refused agent turns run on Sol with a recorded substitution; human and reasoned turns stay on Astra; denials are recorded once and shown');
}finally{rmSync(scratch,{recursive:true,force:true});}
