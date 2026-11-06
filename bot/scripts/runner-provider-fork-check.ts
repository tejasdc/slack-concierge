import assert from 'node:assert/strict';
import {serveRunnerProviderForkCall} from '../src/runner-provider-fork';

const parent='2b7f1e81-e7d1-4da0-bcc7-9422bdf4ca50';
const child='8a806fd6-e03f-4e3f-a1bd-a234254f38c2';
const boundary='7b0503c9-65f7-4c56-9892-28a2b966a0ef';
const source='concierge-native-fork:9d7df9ba-7568-43f7-9de5-8635ae1c3459';
const projectCalls:Array<[string|null,string]>=[];
const projectCwd=(project:string|null,path:string)=>{
  projectCalls.push([project,path]);
  return Promise.resolve(project===null?'/runner/workspace':`/runner/workspace/${project}${path?`/${path}`:''}`);
};
let claudeInput:any;
const claude=await serveRunnerProviderForkCall('provider-fork.execute',{
  provider:'claude-code',account:'tejas@example.test',sessionUUID:parent,boundary,threadSource:source,
  location:{project:'thinkering',path:'bot'},additionalLocations:[{project:'slack-concierge',path:'docs'}],
},{resolveHome:(provider,account)=>provider==='claude-code'&&account==='tejas@example.test'?'/runner/accounts/claude':null,
  resolveProject:projectCwd,runClaudeFork:async input=>{claudeInput=input;return child;}}) as any;
assert.equal(claude.sessionUUID,child);
assert.deepEqual(claudeInput,{home:'/runner/accounts/claude',cwd:'/runner/workspace/thinkering/bot',sessionUUID:parent,boundary});
assert.deepEqual(projectCalls,[['thinkering','bot'],['slack-concierge','docs']]);

const codexRequests:any[]=[];
const codexClient:any={request:async(method:string,params:any)=>{
  codexRequests.push({method,params});
  if(method==='account/read')return {account:{email:'codex@example.test'}};
  if(method==='thread/fork')return {thread:{id:child}};
  throw new Error(`unexpected ${method}`);
},close:async()=>{}};
const codex=await serveRunnerProviderForkCall('provider-fork.execute',{
  provider:'codex',account:'codex@example.test',sessionUUID:parent,boundary:'turn_17',threadSource:source,
  location:{project:null,path:''},additionalLocations:[{project:'thinkering',path:'notes'}],
},{resolveHome:(provider,account)=>provider==='codex'&&account==='codex@example.test'?'/runner/accounts/codex':null,
  resolveProject:projectCwd,codexClient:()=>codexClient}) as any;
assert.equal(codex.sessionUUID,child);
assert.equal(codexRequests[0].method,'account/read');
assert.equal(codexRequests[1].method,'thread/fork');
assert.deepEqual(codexRequests[1].params,{threadId:parent,cwd:'/runner/workspace',runtimeWorkspaceRoots:['/runner/workspace','/runner/workspace/thinkering/notes'],
  approvalPolicy:'never',sandbox:'danger-full-access',deferGoalContinuation:true,excludeTurns:true,lastTurnId:'turn_17',threadSource:source});

await assert.rejects(()=>serveRunnerProviderForkCall('provider-fork.execute',{
  provider:'claude-code',account:'tejas@example.test',sessionUUID:parent,boundary,threadSource:source,
  location:{project:'thinkering',path:'../outside'},additionalLocations:[],
},{resolveHome:()=>'/runner/accounts/claude',resolveProject:projectCwd}),/INVALID_PROVIDER_FORK_PROJECT/);
console.log('runner provider forks resolve account homes and project paths locally, preserve exact boundaries and Codex provenance, and reject traversal');
