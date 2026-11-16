// Real Google producer, synthetic transport. The old void-callback producer fails the held-result assertion.
import assert from 'node:assert/strict';
import {mock} from 'bun:test';
const root = process.env.WAL_CALLBACK_PRODUCER_ROOT ?? new URL('../src/', import.meta.url).pathname;
mock.module(root+'provider-account-usage.ts',()=>({providerAccountUsage:()=>null,
  scheduleProviderAccountUsageRefreshAfterCurrent:async()=>{},storedProviderAccountLabels:()=>[]}));
mock.module(root+'state-database.ts',()=>({db:{}}));
mock.module(root+'provider-free-notice.ts',()=>({publishProviderFreeNotice:()=>{throw Error('unexpected notice')}}));
const {runAntigravityTurn}=await import(root+'antigravity.ts');
const order:string[]=[];
let release!:()=>void;
const admission=new Promise<void>(resolve=>{release=resolve});
let callbacks=0, consumed=0;let entered!:()=>void;const firstEntered=new Promise<void>(resolve=>entered=resolve);
const callback=(name:string)=>async()=>{callbacks++;order.push(name+':received');entered();await admission;consumed++;order.push(name+':consumed')};
const id='cac65334-e28b-4bd3-a223-80e0b7a361d7';
const events=[{event:'init',conversation_id:id,init:{permission_mode:'always-proceed'}},
  {event:'step_update',step_update:{step_index:1,step_type:'user_input',state:'DONE'}},
  {event:'step_update',step_update:{step_index:2,step_type:'agent_response',state:'DONE',text_delta:'synthetic reply'}},
  {event:'result',result:{conversation_id:id,status:'SUCCESS',response:'synthetic reply',num_turns:1,usage:{total_tokens:2}}}];
let returned=false;
const running=runAntigravityTurn({prompt:'synthetic',cwd:'/tmp',additionalDirs:[],environment:{},model:'gemini-3.8-flash-high',
  onInputAcknowledged:callback('ack'),onProviderMessage:callback('message'),onProviderTerminal:callback('terminal'),
  transport:{async run(input:any){for(const event of events)input.onStdout(JSON.stringify(event)+'\n');return {code:0,signal:null}}}} as any);
const completion=running.then(result=>{returned=true;order.push('provider-result-returned');return result});
await firstEntered;await new Promise(resolve=>setImmediate(resolve));
assert.equal(returned,false,'provider completion retains held consumers');
assert.equal(consumed,0);
const beforeRelease=[...order];release();
const result=await completion;
assert.equal(result.text,'synthetic reply');
assert.equal(callbacks,3);
assert.equal(consumed,callbacks);
assert.deepEqual(order,['ack:received','ack:consumed','terminal:received','terminal:consumed','message:received','message:consumed','provider-result-returned']);
console.log(JSON.stringify({runtime:Bun.version,callbacks,consumed,beforeRelease,afterRelease:order,
  conclusion:'Actual Google producer retains ordered callbacks and awaits consumption before successful result.'},null,2));
