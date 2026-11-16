// Nov 16 2026: Codex ended accepted turns with its usage-limit text and those turns failed their requests
// while Claude had room. This replays (a) the zero-work refusal becoming a held wait, (b) who may be moved,
// (c) the model tier kept across providers. Scratch state and a fake Codex client only.
import {strict as assert} from 'node:assert';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HELD_WORK_MOVABILITY_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-held-failover-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=HELD_WORK_MOVABILITY_TEST_AUTHORIZATION;
const [{runCodexTurn},{ProviderDispatchError},{aliasKeepingTier,resolveProviderAlias,modelTier},{pinned,PINNED_SQL},
  {db},{createNativeSession,retainSessionInput}]=await Promise.all([import('../src/codex'),import('../src/provider-failures'),
  import('../src/aliases'),import('../src/held-work-failover'),import('../src/state'),import('../src/session-inputs')]);

const resetSeconds=Math.floor(Date.now()/1000)+3*86_400;
const requests:string[]=[];
const notifications=new Set<(event:any)=>void>();
const client:any={
  async connect(){return 1;},
  async request(method:string,params:any){
    requests.push(method);
    if(method==='config/read')return {config:{}};
    if(method==='thread/resume')return {thread:{id:params.threadId},model:'gpt-fixture'};
    if(method==='account/rateLimits/read')return {rateLimits:{limitId:'codex',primary:{usedPercent:100,resetsAt:resetSeconds},secondary:null}};
    if(method==='turn/start'){
      queueMicrotask(()=>{for(const listener of notifications)listener({method:'item/started',params:{threadId:params.threadId,turnId:'t',
        item:{type:'userMessage',clientId:params.clientUserMessageId}}});
        for(const listener of notifications)listener({method:'turn/completed',params:{threadId:params.threadId,turn:{id:'t',status:'failed',items:[],
          error:{message:"You've hit your usage limit. Upgrade or try again at Nov 20th, 2026 4:20 AM."}}}});});
      return {turn:{id:'t'}};
    }
    throw new Error(`unexpected ${method}`);
  },
  async notify(){},
  onNotification(l:any){notifications.add(l);return()=>notifications.delete(l);},
  onDisconnect(){return()=>true;},
  waitForDisconnect(){return new Promise<void>(()=>{});},
};
const run=()=>runCodexTurn({prompt:'fixture',cwd:scratch,additionalDirs:[],sessionUUID:'fixture-thread',appServerClient:client,requestTimeoutMs:1_000,
  clientUserMessageId:'slack-concierge:turn:1:attempt:1'});

try{
  const refused:any=await run().then(()=>null,error=>error);
  assert.ok(refused instanceof ProviderDispatchError);
  assert.equal(refused.clearsAtMs,resetSeconds*1000,'the refusal carries Codex\'s own reset');
  assert.match(refused.message,/^You've hit your usage limit/,'the message is kept');
  assert.equal(refused.terminalConfirmed,true);
  const before=requests.filter(method=>method==='turn/start').length;
  const cached:any=await run().then(()=>null,error=>error);
  assert.ok(cached instanceof ProviderDispatchError&&cached.clearsAtMs===resetSeconds*1000,'the next turn is refused with the reset');
  assert.equal(requests.filter(method=>method==='turn/start').length,before,'and is refused before sending');
  console.log('codex usage refusal: a zero-work refusal carries the reset and later turns are refused before sending');

  const make=(title:string,meta:Record<string,unknown>,create?:{origin:'human'|'agent';payload:Record<string,unknown>})=>{
    const session=createNativeSession('codex',{title,summary:undefined,purpose:'develop',origin:'native',...meta});
    if(create)retainSessionInput({id:`create-${title}`,sessionId:session.id,scope:'fixture',actionId:`create-${title}`,kind:'create',origin:create.origin,payload:create.payload});
    return session;
  };
  const cases:[string,ReturnType<typeof make>,boolean][]=[
    ['agent --provider codex',make('agent',{},{origin:'agent',payload:{provider:'codex'}}),false],
    ['owner transfer',make('transfer',{recovery:{sourceAddress:'x',reason:'claude_usage_exhausted'}}),false],
    ['automatic human create',make('auto',{automaticProviderChoice:true},{origin:'human',payload:{provider:'auto'}}),false],
    ['his provider',make('his-provider',{},{origin:'human',payload:{provider:'codex'}}),true],
    ['his model',make('his-model',{},{origin:'human',payload:{provider:'auto',model:'gpt-6.1-sol'}}),true],
    ['recorded choice',make('recorded',{providerChosenBy:'tejas'}),true],
    ['his model control',make('control',{automaticProviderChoice:false}),true],
  ];
  const sqlPinned=new Set((db.query(`SELECT session.id FROM sessions session WHERE ${PINNED_SQL}`).all() as {id:number}[]).map(row=>row.id));
  for(const [name,session,expected] of cases){
    assert.equal(pinned(session),expected,`${name}: pinned`);
    assert.equal(sqlPinned.has(session.id),expected,`${name}: the candidate filter matches the rule`);
  }
  console.log('held-work failover: only a session Tejas chose is pinned, in code and in the candidate filter');

  const model=(alias:Parameters<typeof resolveProviderAlias>[0])=>resolveProviderAlias(alias).model;
  const pairs:[string,'claude-code'|'codex'|'antigravity',string][]=[
    [model('cx-sol'),'claude-code',model('cc-opus')],[model('cx-astra'),'claude-code',model('cc-opus')],
    [model('cx-luna'),'claude-code',model('cc-sonnet')],[model('cx-terra'),'claude-code',model('cc-haiku')],
    [model('cc-opus'),'codex',model('cx-sol')],[model('cc-fable'),'codex',model('cx-sol')],
    [model('cc-sonnet'),'codex',model('cx-luna')],[model('cc-haiku'),'codex',model('cx-terra')],
    [model('cc-sonnet'),'antigravity',model('google')]];
  for(const [from,to,expected] of pairs)assert.equal(model(aliasKeepingTier(to,from)),expected,`${from} → ${to}`);
  assert.equal(model(aliasKeepingTier('claude-code',null)),model('cc-opus'),'an unknown model takes the automatic default');
  assert.equal(modelTier('unknown-model'),null);
  console.log('held-work failover: the successor keeps the predecessor\'s model tier');
}finally{rmSync(scratch,{recursive:true,force:true});}
