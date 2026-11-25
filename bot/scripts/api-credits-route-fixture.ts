// The Claude API-credit route (docs/architecture/PROVIDER-USAGE.md#claude-api-credit-route): its aliases,
// the route fixed on the session at creation, the credit cycle, the spend ledger, when Concierge chooses
// the route by itself, and how its refusals read. Runs in a disposable ledger; starts no provider.
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readdirSync,readlinkSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {API_CREDITS_ROUTE_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-api-credits-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=API_CREDITS_ROUTE_TEST_AUTHORIZATION;

const [{db,getSessionById},{SessionOwner},{sessionMetadata,updateSessionMetadata},aliases,{implementationAlias},route,{apiRouteFailure},{bankedApiRoute},{isRefreshableAuthFailure,ProviderDispatchError}]=await Promise.all([
  import('../src/state'),import('../src/session-owner'),import('../src/session-inputs'),import('../src/aliases'),import('../src/implementation-models'),
  import('../src/claude-api-route'),import('../src/turn-execution'),import('../src/saved-work'),import('../src/provider-failures')]);

try{
  // 1. Aliases pick a model and the route; the model pickers and project defaults never offer a route.
  const api=aliases.resolveProviderAlias(aliases.parseProviderSelector('cc-api')!.alias);
  assert.deepEqual([api.provider,api.model,api.route],['claude-code','claude-opus-5-5','api-credits']);
  const sonnet=aliases.resolveProviderAlias(aliases.parseProviderSelector('cc-api-sonnet')!.alias);
  assert.deepEqual([sonnet.model,sonnet.route],['claude-sonnet-5-5','api-credits']);
  assert.equal(aliases.parseProviderSelector('cc-api-sonnet-high')?.effort,'high');
  assert.equal(aliases.resolveProviderAlias('cc-opus').route,undefined);
  const catalogue=aliases.modelCatalogue('claude-code');
  assert.ok(catalogue.every(entry=>!entry.alias.startsWith('cc-api')),'a route alias must not replace a model in the picker');
  assert.equal(catalogue.find(entry=>entry.id==='claude-opus-5-5')?.alias,'cc');
  assert.equal(catalogue.find(entry=>entry.id==='claude-sonnet-5-5')?.alias,'cc-medium');
  assert.ok(aliases.providerSelectorCatalogue().every(entry=>!entry.key.startsWith('cc-api')));
  assert.equal(aliases.configuredProviderDefault('cc-api'),aliases.DEFAULT_PROVIDER_ALIAS);
  assert.equal(implementationAlias('claude-code','cc-api-sonnet'),'cc-api-sonnet');
  assert.equal(implementationAlias('claude-code','cc-api'),'cc-api');

  // 2. The route is fixed on the session when it is created; subscription aliases carry none.
  const owner=new SessionOwner({available:()=>true,wake:()=>{},stop:async()=>false,steer:()=>false},scratch);
  const here={name:'fixture',path:'',cwd:scratch,runner:null};
  const create=(requestId:string,provider:string,extra:Record<string,unknown>={})=>owner.createRequestTarget({requestId,provider,project:scratch,projectLocation:here,
    title:requestId,firstInput:{text:'Say hello.'},...extra} as any);
  const onApi=getSessionById(create('api-sonnet','cc-api-sonnet').session_id)!;
  assert.equal(sessionMetadata(onApi).claudeRoute,'api-credits');
  assert.equal(sessionMetadata(onApi).model,'claude-sonnet-5-5');
  const onSubscription=getSessionById(create('subscription','cc-sonnet').session_id)!;
  assert.equal(sessionMetadata(onSubscription).claudeRoute,undefined);
  // Runner placement is allowed: the runner reads its own key file and refuses plainly when it has none.
  const placed=getSessionById(create('runner','cc-api',{projectLocation:{...here,runner:'ax41'}}).session_id)!;
  assert.equal(sessionMetadata(placed).claudeRoute,'api-credits');
  assert.equal(route.apiRouteRunnerHasKey(null,'ax41'),true);
  assert.equal(route.apiRouteRunnerHasKey('ax41','ax41'),true);
  assert.equal(route.apiRouteRunnerHasKey('mac','ax41'),false,'Concierge never picks the route for a machine without the key');

  // 3. The cycle: granted on the 22nd, expiring at the end of the 32nd day after (Console, 2026-11-25).
  const nov25=Date.parse('2026-11-25T18:00:00Z');
  const grant=route.apiCreditsGrant(nov25);
  assert.equal(new Date(grant.grantedAt).toISOString(),'2026-11-22T00:00:00.000Z');
  assert.equal(new Date(grant.expiresAt).toISOString(),'2026-12-25T00:00:00.000Z');
  assert.equal(route.formatEasternInstant(grant.expiresAt),'Dec 24, 7:00 PM ET');
  assert.equal(new Date(route.apiCreditsGrant(Date.parse('2026-01-05T00:00:00Z')).grantedAt).toISOString(),'2025-12-22T00:00:00.000Z');
  // Grants overlap: until the older one expires it is the cycle, since it is the one about to be lost.
  assert.equal(new Date(route.apiCreditsGrant(Date.parse('2026-12-23T12:00:00Z')).grantedAt).toISOString(),'2026-11-22T00:00:00.000Z');
  assert.equal(new Date(route.apiCreditsGrant(Date.parse('2026-12-25T00:00:00Z')).grantedAt).toISOString(),'2026-12-22T00:00:00.000Z');
  assert.equal(new Date(route.apiCreditsNextGrantAt(nov25)).toISOString(),'2026-12-22T00:00:00.000Z');
  assert.equal(new Date(route.apiCreditsNextGrantAt(Date.parse('2026-12-23T00:00:00Z'))).toISOString(),'2027-01-22T00:00:00.000Z');
  assert.equal(route.apiRouteDecision('banked',{...route.apiCreditsCycle(db,Date.parse('2026-12-23T12:00:00Z')),remainingUsd:100},Date.parse('2026-12-23T12:00:00Z')).use,true,
    'the expiring grant is still spent by banked work after the next one arrives');

  // 4. The ledger counts each reading's increase per conversation; Claude's figure is cumulative across resumes.
  const at=Date.parse('2026-11-23T00:00:00Z');
  const spend=(uuid:string|null,totalUsd:number,tokens:number,firstInProcess:boolean)=>route.recordApiCreditSpend(db,{sessionId:onApi.id,turnId:null,conversationUuid:uuid,totalUsd,tokens,firstInProcess,nowMs:at});
  assert.equal(spend('a',0.5,1000,true),0.5);
  assert.ok(Math.abs(spend('a',0.8,1600,false)-0.3)<1e-9,'later readings in one process count their increase');
  assert.equal(spend('a',0.8,1600,false),0,'a repeated reading adds nothing');
  assert.ok(Math.abs(spend('a',1.1,2400,true)-0.3)<1e-9,'a resume that restored the earlier total counts its increase');
  assert.equal(spend('a',0.9,900,true),0.9,'a resume that started its count afresh counts in full, even above the old total');
  assert.equal(spend('b',0.3,500,true),0.3);
  route.recordApiCreditSpend(db,{sessionId:onApi.id,turnId:null,conversationUuid:'old',totalUsd:50,nowMs:Date.parse('2026-11-20T00:00:00Z')});
  const cycle=route.apiCreditsCycle(db,nov25);
  assert.ok(Math.abs(cycle.spentUsd-2.3)<1e-9,'spend before the grant belongs to the previous cycle');
  assert.ok(Math.abs(cycle.remainingUsd-197.7)<1e-9);
  assert.match(route.apiCreditsLine(cycle),/^API credits route: \$2\.30 of \$200 spent this cycle by Concierge \(Console is the authority\); expires Dec 24, 7:00 PM ET$/);

  // 5. When Concierge picks the route itself.
  const full={...cycle,spentUsd:0,remainingUsd:200};
  assert.equal(route.apiRouteDecision('overflow',full,nov25).use,true);
  assert.equal(route.apiRouteDecision('banked',full,nov25).use,false,'banked waits outside the last week');
  assert.equal(route.apiRouteDecision('banked',full,Date.parse('2026-12-20T00:00:00Z')).use,true);
  assert.equal(route.apiRouteDecision('overflow',{...full,remainingUsd:5},nov25).use,false);
  assert.equal(route.apiRouteDecision('overflow',full,grant.expiresAt).use,false);
  assert.equal(route.apiRouteDecision('overflow',full,nov25,false).use,false);

  // 6. Banked work: a session already on the route uses it while credit remains (when the key exists);
  // another takes it only before its first conversation and in the last week.
  const configured=route.apiCreditsConfigured();
  assert.equal(!!bankedApiRoute(onApi,'claude-sonnet-5-5',nov25),configured);
  assert.equal(bankedApiRoute(onSubscription,'claude-sonnet-5-5',nov25),null);
  assert.equal(!!bankedApiRoute(onSubscription,'claude-sonnet-5-5',Date.parse('2026-12-20T00:00:00Z')),configured);
  updateSessionMetadata(onSubscription.id,{standingRole:'todo'} as any);
  assert.equal(bankedApiRoute(getSessionById(onSubscription.id)!,'claude-sonnet-5-5',Date.parse('2026-12-20T00:00:00Z')),null,'standing agents keep their subscription pin');

  // 7. The launch environment reads the key file each time and pins no account for the agent's shell.
  const keyFile=join(scratch,'key.json');
  assert.throws(()=>route.apiCreditsEnvironment({keyFile,home:scratch}),route.ApiCreditsUnavailableError);
  writeFileSync(keyFile,JSON.stringify({api_key:'sk-ant-fixture'}),{mode:0o600});
  // The folder links the shared Claude set like every account folder, keeps per-login state private,
  // and moves a private copy of a shared entry aside rather than deleting it.
  const shared=join(scratch,'.claude');
  mkdirSync(join(shared,'projects'),{recursive:true});
  writeFileSync(join(shared,'settings.json'),'{}');writeFileSync(join(shared,'.credentials.json'),'{}');
  const apiDir=join(scratch,'.claude-accounts','.api-credits');
  mkdirSync(join(apiDir,'projects','old'),{recursive:true});
  const environment=route.apiCreditsEnvironment({keyFile,home:scratch});
  assert.equal(readlinkSync(join(apiDir,'settings.json')),join(shared,'settings.json'));
  assert.equal(readlinkSync(join(apiDir,'projects')),join(shared,'projects'));
  assert.ok(!existsSync(join(apiDir,'.credentials.json')),'per-login state is never linked');
  assert.ok(readdirSync(apiDir).some(name=>name.startsWith('.unlinked-')&&existsSync(join(apiDir,name,'projects','old'))),'a private copy is kept aside');
  route.apiCreditsEnvironment({keyFile,home:scratch});
  assert.deepEqual(Object.keys(environment).sort(),['ANTHROPIC_API_KEY','CLAUDE_CODE_ENTRYPOINT','CLAUDE_CONFIG_DIR','CONCIERGE_CLAUDE_ROUTE']);
  assert.equal(environment.CLAUDE_CODE_ENTRYPOINT,'sdk-ts');
  assert.equal(environment.CLAUDE_CONFIG_DIR,join(scratch,'.claude-accounts','.api-credits'));
  assert.ok(existsSync(environment.CLAUDE_CONFIG_DIR!));

  // 8. Refusals: a spent credit ends the turn in plain words and never reads as a subscription hold or sign-in.
  const spent=apiRouteFailure(new ProviderDispatchError({message:'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
    terminalConfirmed:true,providerSessionId:'conv'})) as InstanceType<typeof ProviderDispatchError>;
  assert.ok(spent instanceof ProviderDispatchError);
  assert.equal(spent.failureClass,'parked_terminal');
  assert.equal(spent.clearsAtMs,null);
  assert.equal(spent.threadScoped,true);
  assert.equal(spent.providerSessionId,'conv');
  assert.match(spent.message,/monthly Anthropic API credit/);
  assert.ok(!spent.message.startsWith('Claude usage is exhausted'));
  assert.equal(isRefreshableAuthFailure(spent.message),false);
  const key=apiRouteFailure(new Error('Invalid API key · Fix external API key')) as Error;
  assert.equal(isRefreshableAuthFailure(key.message),false,'a rejected key is not a sign-in to renew');
  const transient=new Error('API Error: 529 overloaded');
  assert.equal(apiRouteFailure(transient),transient,'transient errors keep their normal retry');
  console.log('api-credits-route fixture passed');
}finally{
  db.close();
  rmSync(scratch,{recursive:true,force:true});
}
