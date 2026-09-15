import {afterEach,beforeEach,expect,test} from 'bun:test';
import {createHash,randomUUID} from 'node:crypto';
import {db,claimNextQueuedTurn,createOrGetSession,upsertChannel} from '../src/state';
import {SessionExecutionHost} from '../src/session-execution-host';
import {ActiveTurnDispatchRegistry} from '../src/turn-dispatch-seams';
import {getAcceptedSessionInput,recordSessionEvent,updateSessionMetadata} from '../src/session-inputs';
import {claudeHistoryMessages,codexHistoryMessages,type ProviderHistoryMessage} from '../src/provider-history';
import type {AgentProvider} from '../src/providers';
import {acquireDatabaseTestLock} from './db-lock';

let unlock:()=>void,host:SessionExecutionHost,provider:AgentProvider;
let messages:ProviderHistoryMessage[],run:Parameters<AgentProvider['run']>[0];
let finish:()=>void,finished:Promise<void>,started:Promise<void>,ready:()=>void,task:Promise<unknown>|undefined;
function clear(){for(const table of ['session_owner_events','session_inputs','session_attachments','turn_dependencies','routed_requests','routed_input_events','comparison_requests','fork_requests','slack_thread_statuses','slack_user_input_claims','turn_steering_messages','turn_delivery_chunks','turns','sessions','channels','process_instances'])db.query(`DELETE FROM ${table}`).run();}
function echo(text:string,clientId:string) {
  const id=randomUUID();
  const message=provider.id==='claude-code'
    ?claudeHistoryMessages({type:'user',uuid:id,session_id:'native-thread',message:{content:text}},'native-thread')[0]!
    :codexHistoryMessages({type:'userMessage',id,clientId,content:[{type:'text',text}]},'native-turn','native-thread')[0]!;
  messages.push(message);run.onProviderMessage?.(message);return message;
}
beforeEach(async()=>{
  unlock=await acquireDatabaseTestLock();clear();messages=[];task=undefined;
  finished=new Promise(resolve=>finish=resolve);started=new Promise(resolve=>ready=resolve);
  provider={id:'codex',capabilities:{send:true,steer:true,history:true},fork:async()=>{throw new Error('No fork in this test.');},
    history:async()=>({messages:[...messages],nextCursor:'native-cursor',coverage:{complete:false,omissions:['older page']}}),
    run:async input=>{run=input;input.onProviderThreadStarted?.('native-thread');if(provider.id==='codex')input.onProviderTurnStarted?.('native-turn');input.onInputAcknowledged?.();echo(input.prompt,input.clientUserMessageId!);
      input.onSteeringReady?.(async message=>{echo(message.text,message.clientMessageId);});ready();await finished;input.onProviderTerminal?.();return {text:'answer',sessionUUID:'native-thread',toolsUsed:[]};}};
  host=new SessionExecutionHost({instanceId:'history-owner',registry:new ActiveTurnDispatchRegistry({onStarted:()=>{},onSettled:()=>{}}),providers:{codex:provider,'claude-code':provider},defaultCwd:'/tmp',wake:()=>{}});
});
afterEach(async()=>{finish();await task;clear();unlock();});
async function start(){const claim=claimNextQueuedTurn('history-owner')!;expect(claim).not.toBeNull();task=host.run(claim);await started;return claim;}
async function history(id:string){return await host.owner.history(id,null,20) as {messages:ProviderHistoryMessage[];nextCursor:string|null;coverage:unknown};}
async function settled(){finish();await task;}
async function until(check:()=>boolean){for(let n=0;n<100&&!check();n++)await Bun.sleep(5);expect(check()).toBe(true);}

for(const id of ['codex','claude-code'] as const)test(`${id} history and live events restore accepted text and attachments without changing native boundaries`,async()=>{
  provider.id=id;
  const file=host.owner.upload({clientActionId:randomUUID(),name:'garden.txt',contentType:'text/plain',base64:Buffer.from('two beds').toString('base64')}).attachment;
  const text='  Use my garden notes.\nKeep the exact spacing.  ',contextText='Private selected revision scaffold';
  const created=host.owner.create({clientActionId:randomUUID(),provider:id,purpose:'chat',firstInput:{text,attachments:[file.id],selection:[{objectId:'plan',revision:'one'}],context:[{kind:'selection',reference:{objectId:'plan',revision:'one'},text:contextText,sha256:createHash('sha256').update(contextText).digest('hex')}]}});
  const claim=await start();await settled();
  const raw=structuredClone(messages[0]!),saved=db.query("SELECT payload_json FROM session_owner_events WHERE kind='message'").all();
  expect(raw.content).toBe((db.query('SELECT replay_text FROM turns WHERE id=?').get(claim.turn_id) as any).replay_text);
  expect(raw.content).toContain('concierge-session-input');expect(raw.content).toContain(contextText);
  expect(raw.content).toContain(text);
  const page=await history(created.session.id),message=page.messages[0]!;
  expect(message).toEqual({...raw,content:text,submissionId:created.operation.inputId!,attachments:[{id:file.id,name:file.name,contentType:file.contentType}]});
  expect(page.nextCursor).toBe('native-cursor');expect(page.coverage).toEqual({complete:false,omissions:['older page']});
  const event=host.owner.events(0,created.session.id).find(event=>event.kind==='message')!;
  expect(event.payload.message).toEqual(message);expect(event.inputId).toBe(created.operation.inputId);
  expect(messages[0]).toEqual(raw);expect(db.query("SELECT payload_json FROM session_owner_events WHERE kind='message'").all()).toEqual(saved);
  const context=await host.owner.context({address:created.session.address});
  expect(context.evidence[0]!.text).toBe(raw.content);
  const exact=await host.owner.context({address:created.session.address,sourceId:context.evidence[0]!.sourceId,sourceVersion:context.evidence[0]!.sourceVersion,eventId:raw.id});
  expect(exact.evidence[0]!.textHash).toBe(context.evidence[0]!.textHash);
});

test('same-run human, agent and service steering keeps each exact author, text and attachment on a Slack-born session',async()=>{
  upsertChannel({slack_channel_id:'CHISTORY',slack_channel_name:'history',group_name:null,name:'history',vault_path:'/tmp',code_path:'/tmp',provider_default:'codex'});
  const session=createOrGetSession('CHISTORY','1700000000.100001','codex'),id=`concierge:${session.id}`;
  const first=host.owner.submit(id,{clientActionId:randomUUID(),text:'Native continuation of my Slack session.'});await start();
  const file=host.owner.upload({clientActionId:randomUUID(),name:'photo.txt',contentType:'text/plain',base64:Buffer.from('attached').toString('base64')}).attachment;
  const inputs=[first.operation];
  for(const origin of ['agent','service','human'] as const){
    const operation=origin==='human'
      ?host.owner.submit(id,{clientActionId:randomUUID(),text:`${origin} exact text`,attachments:[file.id],delivery:'steer',expectedRunId:first.operation.runId}).operation
      :host.owner.receipt(host.owner.admit({sessionId:session.id,inputId:randomUUID(),origin,sourceInputId:first.operation.inputId!,sourceRunId:first.operation.runId!,requestId:'retained-request',text:`${origin} exact text`}));
    await until(()=>messages.length===inputs.length+1);inputs.push(operation);
  }
  await settled();
  const page=await history(id),events=host.owner.events(0,id).filter(event=>event.kind==='message');
  expect(page.messages.map(message=>message.content)).toEqual(inputs.map(input=>input.text!));
  expect(page.messages.map(message=>message.submissionId)).toEqual(inputs.map(input=>input.inputId!));
  expect(events.map(event=>event.inputId)).toEqual(inputs.map(input=>input.inputId));
  expect(events.map(event=>event.payload.message)).toEqual(page.messages);
  expect(page.messages.map(message=>message.id)).toEqual(messages.map(message=>message.id));
  expect(page.messages.map(message=>message.turnId)).toEqual(messages.map(message=>message.turnId));
  expect(page.messages[3]!.attachments?.[0]?.id).toBe(file.id);
  expect(inputs.map(input=>getAcceptedSessionInput(input.inputId!)!.origin)).toEqual(['human','agent','service','human']);
  expect(db.query('SELECT count(*) AS n FROM slack_user_input_claims').get()).toEqual({n:0});
});

test('quoted envelope JSON cannot claim another input, and unmatched native/source evidence stays literal',async()=>{
  const created=host.owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'Original input'}});await start();
  const original=structuredClone(messages[0]!);
  const steered=host.owner.submit(created.session.id,{clientActionId:randomUUID(),text:original.content,delivery:'steer',expectedRunId:created.operation.runId});await until(()=>messages.length===2);await settled();
  const quoted=structuredClone(messages[1]!);
  const foreignSession=host.owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat'});
  const foreign={...original,id:'foreign-native-message'};
  recordSessionEvent({eventId:'foreign-event',sessionId:Number(foreignSession.session.id.slice(10)),kind:'message',payload:{message:foreign}});
  const unmatched=[{...original,id:'copied-envelope'}, {...original,turnId:'different-native-turn'}, {...original,content:original.content+' '},foreign,{...original,id:'assistant-copy',role:'assistant' as const},{...original,id:'tool-copy',role:'tool' as const,tool:'tool',detailKey:'native-detail'}];
  messages.push(...unmatched);
  const page=await history(created.session.id);
  expect(page.messages[0]).toEqual({...original,content:'Original input',submissionId:created.operation.inputId});
  expect(page.messages[1]).toEqual({...quoted,content:original.content,submissionId:steered.operation.inputId});
  expect(page.messages.slice(2)).toEqual(unmatched);
  updateSessionMetadata(Number(created.session.id.slice(10)),{origin:'imported',source:{id:'archive',version:'a'.repeat(64),branch:'main'}});
  host.owner.runtime.sources={search:async()=>({}),context:async()=>({}),import:async()=>({}),history:async()=>({messages:[original],nextCursor:null})};
  expect((await history(created.session.id)).messages).toEqual([original]);
});

test('interrupted history prefixes are hidden only when the whole native message matches retained preparation',async()=>{
  const created=host.owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'prior uncertain input'}});
  db.query("UPDATE turns SET status='error' WHERE accepted_input_id=?").run(created.operation.inputId);
  const accepted=host.owner.submit(created.session.id,{clientActionId:randomUUID(),text:'My current input'}),claim=await start();await settled();
  const raw=structuredClone(messages[0]!);
  expect(raw.content).toContain('prior uncertain input');expect(raw.content.startsWith('{')).toBe(false);
  expect((await history(created.session.id)).messages[0]).toEqual({...raw,content:'My current input',submissionId:accepted.operation.inputId});
  db.query('UPDATE turns SET replay_text=? WHERE id=?').run('different preparation',claim.turn_id);
  expect((await history(created.session.id)).messages[0]!.content).toBe('My current input');
  db.query("UPDATE session_inputs SET receipt_json=json_set(receipt_json,'$.admission.promptHash',?) WHERE id=?").run('different hash',accepted.operation.inputId);
  expect((await history(created.session.id)).messages[0]).toEqual(raw);
});

test('ChatGPT history preserves its native run submission identity',async()=>{
  const created=host.owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'Current input'}});await start();await settled();
  db.query("UPDATE sessions SET provider_id='chatgpt' WHERE id=?").run(Number(created.session.id.slice(10)));
  host.owner.runtime.history=async()=>({messages:[...messages],nextCursor:null});
  expect((await history(created.session.id)).messages).toEqual(messages);
  expect(host.owner.events(0,created.session.id).find(event=>event.kind==='message')!.payload.message).toEqual(messages[0]);
});
