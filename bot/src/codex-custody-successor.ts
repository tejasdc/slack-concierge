import {createHash} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {db,getSessionById,executionChanged} from './state';
import {getAcceptedSessionInput,retainSessionInput,nativeRunId,sessionMetadata,updateSessionMetadata,recordSessionEvent} from './session-inputs';
import {stageRecoveryHandoff,commitRecoveryHandoff,supersededBy} from './session-handoff';
import {CodexSuccessorNativeAdapter,CodexSuccessorConstructionMismatchError,type CodexSuccessorPlan,type CodexSuccessorConstruction} from './codex-successor-native';
import {isAstraModel} from './aliases';
import {codexOwnedThreadConfig} from './codex';
import {providerOwnerEnvironment} from './provider-owner-environment';
import {requireCustodyReader,assertInstalledCustodyController} from './codex-custody-compatibility';
import {sessionInputInstructions} from './session-input-context';
import {isWritingSession,WRITING_SESSION_STANDING} from './session-roles';
import type {CodexAppServerClientLike} from './codex-app-server-client';
import {proveCodexInputNeverAcknowledged} from './codex-unacknowledged-proof';
import {ledgerDurable} from './ledger-durability-barrier';
import {custodyConnection} from './codex-custody-connection';
import {assertCustodyRunnerBinding,custodyProcessEndpoint} from './codex-custody-colocation';
import {withoutMachinePaths} from './runner-machine';
import {freezeManagedCodexTarget,type ManagedCodexCustodyCutoff} from './codex-app-server-client';
import {reconcileCodexCustodyPredecessorEffects} from './codex-custody-effects';
import {custodySelectedTerminalConfirmed} from './codex-custody-terminal';
import {observeCodexCustodyProcesses,type CodexLeftoverProcess} from './codex-leftover-processes';

export interface CustodySuccessorRow {
  canonical_input_id:string; predecessor_session_id:number; successor_session_id:number; handoff_id:string;
  placement_input_id:string; placement_turn_id:number; request_id:string; source_input_id:string; source_run_id:string;
  state:string; plan_json:string; snapshot_json:string; construction_intended_at:string|null; native_thread_id:string|null;
  construction_json:string|null; attempt_spent_at:string|null; dispatch_attempt:number|null; native_turn_id:string|null;
  acknowledged_at:string|null; error:string|null; created_at:string;
}
export function custodySuccessor(canonical:string):CustodySuccessorRow|null {
  return db.query('SELECT * FROM codex_custody_successors WHERE canonical_input_id=?').get(canonical) as CustodySuccessorRow|null;
}
export function custodyPlacement(turnId:number):CustodySuccessorRow|null {
  return db.query('SELECT * FROM codex_custody_successors WHERE placement_turn_id=?').get(turnId) as CustodySuccessorRow|null;
}
export function custodySuccessorSession(sessionId:number):CustodySuccessorRow|null {
  return db.query('SELECT * FROM codex_custody_successors WHERE successor_session_id=?').get(sessionId) as CustodySuccessorRow|null;
}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const fail=(message:string):never=>{throw new Error(message);};
const nativeCutoffs=new Map<string,ManagedCodexCustodyCutoff>();
function assertNativeCutoff(canonical:string){
  const cutoff=nativeCutoffs.get(canonical);
  if(!cutoff)fail('No current owner-managed native cutoff is retained; consequential recovery remains held.');
  cutoff.assertCurrentHold();
  if(cutoff.unresolved.length||cutoff.barriers.length===0)
    fail(`The native cutoff has unresolved sender generations or no acknowledged prefix: ${cutoff.unresolved.join('; ')}`);
}
async function sourceFingerprint(path:string) {
  const before=await stat(path),digest=createHash('sha256');let bytes=0;
  for await(const chunk of createReadStream(path)){digest.update(chunk);bytes+=chunk.length;}
  const after=await stat(path);
  if(bytes!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.dev!==after.dev||before.ino!==after.ino)
    fail('Original source changed while its current boundary was read.');
  return {bytes,digest:digest.digest('hex'),sourceDevice:before.dev,sourceInode:before.ino};
}

function selectedFacts(requestId:string,client:CodexAppServerClientLike) {
  const request=db.query('SELECT * FROM session_communication_requests WHERE request_id=?').get(requestId) as any;
  const selected=getAcceptedSessionInput(`report-back:${requestId}`);
  const session=selected?getSessionById(selected.session_id):null;
  const retained=selected?custodySuccessor(selected.id):null;
  const transferred=!!retained&&!!db.query(`SELECT 1 FROM session_handoffs WHERE id=? AND state='accepted'
    AND predecessor_session_id=? AND successor_session_id=?`).get(retained.handoff_id,retained.predecessor_session_id,retained.successor_session_id);
  const targetMatches=!!session&&(request?.target_session_id===session.id
    ||transferred&&request?.target_session_id===retained!.successor_session_id&&retained!.predecessor_session_id===session.id);
  if(!request||request.outcome!==null||JSON.parse(request.payload_json).requestedEffect!=='work'||!session
    ||!targetMatches||session.provider_id!=='codex'||!session.agent_session_uuid||!selected||selected.session_id!==session.id
    ||selected.origin!=='service'||selected.request_id!==requestId||selected.turn_id===null||selected.steering_id!==null)
    return fail('Recovery needs the exact retained service reminder of an open work request.');
  const metadata=sessionMetadata(session),receipt=JSON.parse(selected.receipt_json??'{}');
  const turn=db.query('SELECT * FROM turns WHERE id=? AND accepted_input_id=? AND session_id=?')
    .get(selected.turn_id,selected.id,session.id) as any;
  assertCustodyRunnerBinding(metadata.providerRunner,client.nativeEndpoint);
  const admission=receipt.admission;
  const effort=admission?.reasoningEffort??(db.query(`SELECT json_extract(payload_json,'$.effort') AS effort
    FROM session_owner_events WHERE event_id=? AND session_id=? AND turn_id=? AND kind='prompt_cache_identity'`)
    .get(`prompt-cache-identity:${turn?.id}:${turn?.dispatch_attempt}`,session.id,turn?.id) as any)?.effort;
  if(!isAstraModel(metadata.model)||metadata.reasoningEffort!=='medium'||metadata.outside||metadata.interactionPolicy
    ||session.status==='archived'||(metadata.suspended&&!transferred)||!turn
    ||!['done','parked','error'].includes(turn.status)||turn.owner_instance_id!==null||turn.stop_requested_at!==null
    ||turn.provider_input_acknowledged_at!==null||turn.dispatch_attempt<1
    ||admission?.provider!=='codex'||admission.model!==metadata.model||effort!=='medium'
    ||admission.inputId!==selected.id||admission.runId!==turn.native_run_id
    ||admission.bindingGeneration!==session.binding_generation)
    return fail('Retained admission does not establish this exact unacknowledged Astra Medium continuation.');
  if(db.query('SELECT 1 FROM codex_unacknowledged_recoveries WHERE accepted_input_id=?').get(selected.id))
    return fail('The canonical reminder already reserved its additional attempt.');
  assertExcluded(session.id);
  return {request,selected,session,metadata,turn};
}

/** Current owner records, not a caller assertion of process absence. Native reconciliation
 * independently rejects active native turns before the custody transition. */
function assertExcluded(sessionId:number) {
  if(db.query(`SELECT 1 FROM turns WHERE session_id=? AND status IN ('running','delivering') LIMIT 1`).get(sessionId)
    ||db.query(`SELECT 1 FROM executions WHERE session_id=? AND state IN ('intended','live','exited') LIMIT 1`).get(sessionId)
    ||db.query(`SELECT 1 FROM turn_steering_messages s JOIN turns t ON t.id=s.turn_id
      WHERE t.session_id=? AND s.status IN ('sending','ambiguous') LIMIT 1`).get(sessionId))
    fail('A predecessor execution or relevant effect remains unresolved.');
}

async function pages(client:CodexAppServerClientLike,method:string,params:Record<string,unknown>):Promise<any[]> {
  const all:any[]=[],seen=new Set<string>();let cursor:string|null=null;
  do {
    const page=await client.request(method,{...params,cursor,limit:100,sortDirection:'asc'});
    if(!Array.isArray(page?.data))fail('Native observation returned no complete page.');
    all.push(...page.data);
    cursor=page.nextCursor??null;
    if(cursor!==null&&(typeof cursor!=='string'||seen.has(cursor)))fail('Native observation repeated an invalid cursor.');
    if(cursor)seen.add(cursor);
  }while(cursor);
  return all;
}

async function reconcileSelected(client:CodexAppServerClientLike,facts:ReturnType<typeof selectedFacts>) {
  const {session,turn,selected}=facts;
  const retained=db.query(`SELECT kind,payload_json FROM session_owner_events
    WHERE turn_id=? AND session_id=? AND kind IN ('provider_turn_attempt','result') ORDER BY sequence`)
    .all(turn.id,session.id) as {kind:string;payload_json:string}[];
  const attempts=new Map<number,string>();
  for(const event of retained){const value=JSON.parse(event.payload_json);
    const attempt=value.dispatchAttempt??(event.kind==='result'&&turn.dispatch_attempt===1?1:null);
    if(!Number.isInteger(attempt)||typeof value.providerTurnId!=='string')continue;
    if(attempts.has(attempt)&&attempts.get(attempt)!==value.providerTurnId)fail('Conflicting immutable native attempt mapping.');
    attempts.set(attempt,value.providerTurnId);
  }
  if(attempts.size!==turn.dispatch_attempt)fail('Every original attempt must have an owner-retained native identity.');
  const summaries=await pages(client,'thread/turns/list',{threadId:session.agent_session_uuid,itemsView:'notLoaded'});
  if(summaries.some(value=>!['completed','failed','interrupted'].includes(value.status)))
    fail('The predecessor still has an unresolved native execution.');
  const native=[];
  for(let index=1;index<=turn.dispatch_attempt;index++){
    const id=attempts.get(index);const summary=summaries.find(value=>value.id===id);
    if(!id||!summary)fail('An owner-recorded attempt is absent from complete native observation.');
    const items=await pages(client,'thread/items/list',{threadId:session.agent_session_uuid,turnId:id});
    if(items.some(value=>value.turnId!==id))fail('Native item page has a different turn identity.');
    native.push({...summary,items:items.map(value=>value.item)});
  }
  const proof=proveCodexInputNeverAcknowledged({thread:{thread:{id:session.agent_session_uuid,turns:native}},
    threadId:session.agent_session_uuid!,attempts:[...attempts].map(([dispatchAttempt,providerTurnId])=>({dispatchAttempt,providerTurnId}))});
  if(!proof)fail('Complete native observation does not prove all selected attempts empty and terminal.');
  return {canonicalInputId:selected.id,attempts:proof.attempts};
}

async function sourceSnapshot(client:CodexAppServerClientLike,facts:ReturnType<typeof selectedFacts>,referenceOnly=false) {
  const read=await client.request('thread/read',{threadId:facts.session.agent_session_uuid,includeTurns:false});
  const thread=read?.thread;
  if(thread?.id!==facts.session.agent_session_uuid||typeof thread.path!=='string'||!thread.path.startsWith('/'))
    return fail('The original conversation source path is unavailable.');
  const referenced=await stat(thread.path);
  if(!referenced.isFile())fail('The original native source is not an accessible regular file.');
  const source=referenceOnly?{bytes:referenced.size,digest:'',sourceDevice:referenced.dev,sourceInode:referenced.ino}
    :await sourceFingerprint(thread.path);
  const roots=[...new Set([facts.metadata.cwd,...(facts.metadata.additionalDirs??[])])];
  if(roots.some(root=>typeof root!=='string'||!root.startsWith('/')))fail('Owner workspace roots are incomplete.');
  const resources=await Promise.all((roots as string[]).map(async path=>{const value=await stat(path);
    if(!value.isDirectory())fail('A retained workspace root is no longer a directory.');return {path,dev:value.dev,ino:value.ino};}));
  if(typeof thread.modelProvider!=='string'||!thread.modelProvider)fail('The retained native provider identity is unavailable.');
  return {path:thread.path as string,...source,sourceBoundary:referenceOnly?'reference':'post-cutoff',resources,
    provider:thread.modelProvider as string,payloadHash:hash(facts.selected.payload_json),
    bindingGeneration:facts.session.binding_generation,threadId:facts.session.agent_session_uuid};
}
async function verifyResources(snapshot:Awaited<ReturnType<typeof sourceSnapshot>>) {
  if(snapshot.sourceBoundary!=='post-cutoff'||!snapshot.digest)
    fail('No validated post-cutoff source boundary is retained.');
  const source=await sourceFingerprint(snapshot.path);
  if(source.bytes!==snapshot.bytes||source.digest!==snapshot.digest||source.sourceDevice!==snapshot.sourceDevice||source.sourceInode!==snapshot.sourceInode)
    fail('Original source changed during successor preparation.');
  for(const resource of snapshot.resources){const now=await stat(resource.path);
    if(!now.isDirectory()||now.dev!==resource.dev||now.ino!==resource.ino)fail('A retained resource was replaced or remapped.');}
}

export interface CustodySuccessorRequest {
  actorSession:number; sourceInputId:string; sourceRunId:string; requestId:string; actionId:string;
  authorityInputId?:string;
  validateSource():void;
}

/** Action identity remains distinct from canonical deduplication. A later repair may
 * inspect the same operation without rebudgeting it, but cannot repurpose an old action. */
function recoveryAction(input:CustodySuccessorRequest,relation?:CustodySuccessorRow) {
  const eventId=`custody-recovery-action:${hash(JSON.stringify([input.sourceInputId,input.actionId]))}`;
  const selected=`report-back:${input.requestId}`;
  const expected={kind:'codex-custody-successor',actionId:input.actionId,requestId:input.requestId,
    canonicalInputId:selected,sourceInputId:input.sourceInputId,sourceRunId:input.sourceRunId,
    actorSession:input.actorSession,authorityInputId:input.authorityInputId??input.sourceInputId};
  const prior=db.query('SELECT payload_json FROM session_owner_events WHERE event_id=?').get(eventId) as {payload_json:string}|null;
  if(db.query('SELECT 1 FROM session_inputs WHERE session_id=? AND scope=? AND action_id=?')
    .get(input.actorSession,`communication:${input.sourceInputId}`,input.actionId))
    fail('This admitted action already names a different communication operation.');
  if(prior){
    const value=JSON.parse(prior.payload_json);
    if(Object.entries(expected).some(([key,valueExpected])=>value[key]!==valueExpected)
      ||relation&&(value.handoffId!==relation.handoff_id||value.predecessorSession!==relation.predecessor_session_id))
      fail('This admitted action already names another recovery operation or authority basis.');
  }
  const handoff=db.query('SELECT id,handoff_kind,canonical_input_id FROM session_handoffs WHERE requesting_input_id=? AND action_id=?')
    .get(input.sourceInputId,input.actionId) as {id:string;handoff_kind:string;canonical_input_id:string|null}|null;
  if(handoff&&(handoff.handoff_kind!=='codex-custody-successor'||handoff.canonical_input_id!==selected
    ||relation&&handoff.id!==relation.handoff_id))fail('This admitted action already names a different handoff kind or target.');
  if(relation&&!prior)recordSessionEvent({eventId,sessionId:input.actorSession,inputId:input.sourceInputId,
    kind:'custody_recovery_action',payload:{...expected,handoffId:relation.handoff_id,
      predecessorSession:relation.predecessor_session_id,successorSession:relation.successor_session_id,
      binding:JSON.parse(relation.snapshot_json).bindingGeneration,planDigest:hash(relation.plan_json)}});
}

/** Called only behind the owner's authenticated live-work entrance. No model, effort,
 * assessment, diagnostic proof or native identity can be supplied by that caller. */
export async function recoverCustodySuccessor(input:CustodySuccessorRequest,client:CodexAppServerClientLike,
  observeProcesses?:(threadId:string)=>Promise<CodexLeftoverProcess[]>) {
  client=custodyConnection(client);
  input.validateSource();
  recoveryAction(input);
  await custodyConnection(client).witness();
  const currentProcesses=observeProcesses??(async(threadId:string)=>{
    const association=await custodyConnection(client).witness();
    const endpoint=custodyProcessEndpoint(association.endpoint??undefined);
    const result=await observeCodexCustodyProcesses(threadId,endpoint.socketPath,endpoint.nativePid);
    await custodyConnection(client).assert(association);
    return result;
  });
  const prior=custodySuccessor(`report-back:${input.requestId}`);
  if(prior){
    db.transaction(()=>{input.validateSource();recoveryAction(input,prior);}).immediate();
    const handoff=db.query('SELECT caller_session_id,inventory_digest FROM session_handoffs WHERE id=?').get(prior.handoff_id) as any;
    if(!handoff)fail('The retained recovery lost its exact handoff relation.');
    if(prior.state==='staged'){
      await refreshStagedCustody(input,prior,client,currentProcesses);
      input.validateSource();
      let accepted=await commitRecoveryHandoff({actorSession:input.actorSession,inputId:input.sourceInputId,runId:input.sourceRunId,
        handoffId:prior.handoff_id,digest:handoff.inventory_digest,placementInputId:prior.placement_input_id,placementTurnId:prior.placement_turn_id,validateAuthority:()=>{input.validateSource();selectedFacts(input.requestId,client);assertNativeCutoff(`report-back:${input.requestId}`);}});
      // A changed inventory is read from the owner, then checked again inside the transfer transaction.
      if(!accepted.accepted&&'digest' in accepted)accepted=await commitRecoveryHandoff({actorSession:input.actorSession,
        inputId:input.sourceInputId,runId:input.sourceRunId,handoffId:prior.handoff_id,digest:accepted.digest,
        placementInputId:prior.placement_input_id,placementTurnId:prior.placement_turn_id,validateAuthority:()=>{input.validateSource();selectedFacts(input.requestId,client);assertNativeCutoff(`report-back:${input.requestId}`);}});
      if(!accepted.accepted)fail('Current inventory could not be committed; successor remains passive.');
    }
    const current=custodySuccessor(prior.canonical_input_id)!;
    if(current.state==='custody'&&current.construction_intended_at===null){
      await refreshStagedCustody(input,current,client,currentProcesses);
      return constructCustodySuccessor(input,current,client);
    }
    return current;
  }
  const facts=selectedFacts(input.requestId,client);
  // This initial read obtains preserved source/namespace references, not eligibility evidence.
  // Terminal/effect reconciliation happens only after the durable target hold and barriers.
  const snapshot=await sourceSnapshot(client,facts,true);
  input.validateSource();
  requireCustodyReader(process.env.CONCIERGE_STATE_DIR!,process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT||'/var/lib/slack-concierge-deployment');
  const staged=await stageRecoveryHandoff({actorSession:input.actorSession,inputId:input.sourceInputId,runId:input.sourceRunId,
    predecessorId:facts.session.id,actionId:input.actionId,selectedInputId:facts.selected.id,
    preservedSourcePath:snapshot.path,
    reason:'Preserve the exact accepted continuation under owner-committed successor custody.'});
  const successorId=Number(staged.successor.slice('concierge:'.length));
  for(const item of staged.inventory.items.filter(item=>item.kind==='worktree')){
    if(snapshot.resources.some(resource=>resource.path===item.ref))continue;
    const resource=await stat(item.ref);
    if(!resource.isDirectory())fail('A source-owned worktree is no longer accessible.');
    snapshot.resources.push({path:item.ref,dev:resource.dev,ino:resource.ino});
  }
  const latest=selectedFacts(input.requestId,client);
  if(latest.selected.payload_json!==facts.selected.payload_json||latest.session.binding_generation!==snapshot.bindingGeneration)
    fail('Canonical input or retained binding changed while staging custody.');
  const nativeConnection=await custodyConnection(client).witness();
  const relation=db.transaction(()=>{
    input.validateSource();
    selectedFacts(input.requestId,client);
    const raced=custodySuccessor(facts.selected.id);if(raced)return raced;
    const currentHandoff=db.query("SELECT 1 FROM session_handoffs WHERE id=? AND state='proposed' AND handoff_kind='codex-custody-successor' AND canonical_input_id=?")
      .get(staged.handoffId,facts.selected.id);
    const passive=getSessionById(successorId);
    if(!currentHandoff||!passive||passive.status==='archived'||passive.agent_session_uuid!==null||!sessionMetadata(passive).suspended)
      fail('Passive recovery staging changed or was withdrawn before canonical reservation.');
    if(db.query('SELECT 1 FROM codex_unacknowledged_recoveries WHERE accepted_input_id=?').get(facts.selected.id))
      fail('The canonical reminder acquired a different recovery reservation while staging.');
    const placement=retainSessionInput({id:`custody-placement:${facts.selected.id}`,sessionId:successorId,
      scope:`custody-successor:${facts.selected.id}`,actionId:'placement',kind:'input',origin:facts.selected.origin,
      payload:JSON.parse(facts.selected.payload_json),sourceInputId:facts.selected.id,sourceRunId:nativeRunId(facts.turn.id),requestId:input.requestId}).input;
    const payload=JSON.parse(placement.payload_json);
    const turn=db.query(`INSERT INTO turns(session_id,user_text,status,turn_kind,accepted_input_id,requested_by_user_id,
      provider_model,reasoning_effort,replay_text) VALUES(?,?,'queued','native',?,'service',?,'medium',?)`)
      .run(successorId,payload.text,placement.id,facts.metadata.model,payload.text);
    const turnId=Number(turn.lastInsertRowid);nativeRunId(turnId);
    db.query('UPDATE session_inputs SET turn_id=? WHERE id=?').run(turnId,placement.id);
    const ownerEnvironment=providerOwnerEnvironment();
    const {CONCIERGE_COMMIT_PROVENANCE:_provenance,CONCIERGE_COMMIT_INPUT:_commitInput,...shellEnvironment}=ownerEnvironment;
    const plan:CodexSuccessorPlan={operationId:staged.handoffId,ownerSessionId:successorId,model:facts.metadata.model!,provider:snapshot.provider,
      cwd:facts.metadata.cwd!,runtimeWorkspaceRoots:[...new Set([facts.metadata.cwd!,...(facts.metadata.additionalDirs??[])])],environmentId:'local',
      config:codexOwnedThreadConfig(nativeConnection.endpoint?.relayRunner?withoutMachinePaths(shellEnvironment):shellEnvironment),
      approvalPolicy:'never',sandbox:'danger-full-access',custodyCommitted:true,predecessorExcluded:true,nativeConnection,
      additionalContext:{instructions:{kind:'application',value:sessionInputInstructions({standing:isWritingSession(facts.session)?WRITING_SESSION_STANDING:null})},
        custody:{kind:'application',value:`Continue the preserved duties of concierge:${facts.session.id}. Read its retained conversation through sessions context. Original source: ${snapshot.path}. Existing accepted work must not be replayed. Resource access is preservation, not productive write ownership. Preserve separately assigned productive custodians: do not edit or reset their retained worktrees. Read the repair coordinator's retained source for current scope: ${input.sourceInputId}. Exact obligation inventory: ${JSON.stringify(staged.inventory??{})}`}}};
    db.query(`INSERT INTO codex_custody_successors(canonical_input_id,predecessor_session_id,successor_session_id,handoff_id,
      placement_input_id,placement_turn_id,request_id,source_input_id,source_run_id,state,plan_json,snapshot_json)
      VALUES(?,?,?,?,?,?,?,?,?,'staged',?,?)`).run(facts.selected.id,facts.session.id,successorId,staged.handoffId,
        placement.id,turnId,input.requestId,input.sourceInputId,input.sourceRunId,JSON.stringify(plan),JSON.stringify(snapshot));
    const created=custodySuccessor(facts.selected.id)!;
    recoveryAction(input,created);
    return created;
  }).immediate();
  await refreshStagedCustody(input,relation,client,currentProcesses);
  db.transaction(()=>{input.validateSource();recoveryAction(input,relation);}).immediate();
  const committed=await commitRecoveryHandoff({actorSession:input.actorSession,inputId:input.sourceInputId,runId:input.sourceRunId,
    handoffId:relation.handoff_id,digest:staged.digest,placementInputId:relation.placement_input_id,placementTurnId:relation.placement_turn_id,validateAuthority:()=>{input.validateSource();selectedFacts(input.requestId,client);assertNativeCutoff(`report-back:${input.requestId}`);}});
  if(!committed.accepted)fail('Custody inventory changed; native construction remains withheld.');
  return constructCustodySuccessor(input,relation,client);
}

async function refreshStagedCustody(input:CustodySuccessorRequest,relation:CustodySuccessorRow,
  client:CodexAppServerClientLike,observeProcesses:(threadId:string)=>Promise<CodexLeftoverProcess[]>) {
  input.validateSource();
  const before=JSON.parse(relation.snapshot_json) as Awaited<ReturnType<typeof sourceSnapshot>>;
  if(relation.state==='custody')await verifyResources(before);
  await ledgerDurable();
  const association=await custodyConnection(client).witness();
  if(!association.endpoint)fail('Native recovery has no actual endpoint association.');
  const cutoffHandle=freezeManagedCodexTarget({ownerSessionId:relation.predecessor_session_id,threadId:before.threadId!,
    endpoint:association.endpoint,sourcePath:before.path,bindingGeneration:before.bindingGeneration!});
  const cutoff=await cutoffHandle.reconcile();
  nativeCutoffs.set(relation.canonical_input_id,cutoffHandle);
  db.query("UPDATE codex_custody_successors SET snapshot_json=?,error=? WHERE canonical_input_id=? AND state='staged'")
    .run(JSON.stringify({...before,cutoff}),cutoff.unresolved.length?cutoff.unresolved.join('; '):null,relation.canonical_input_id);
  assertNativeCutoff(relation.canonical_input_id);
  const effects=await reconcileCodexCustodyPredecessorEffects(client,{predecessorSessionId:relation.predecessor_session_id,
    threadId:before.threadId!,selectedTurnId:getAcceptedSessionInput(relation.canonical_input_id)!.turn_id!},observeProcesses);
  const facts=selectedFacts(input.requestId,client),proof=await reconcileSelected(client,facts);
  const fresh=await sourceSnapshot(client,facts);
  if(fresh.threadId!==before.threadId||fresh.bindingGeneration!==before.bindingGeneration
    ||fresh.path!==before.path||fresh.sourceDevice!==before.sourceDevice||fresh.sourceInode!==before.sourceInode)
    fail('The retained native binding or source namespace changed under the target hold.');
  for(const resource of before.resources){
    const current=await stat(resource.path);
    if(!current.isDirectory()||current.dev!==resource.dev||current.ino!==resource.ino)
      fail('A preserved resource was replaced under the target hold.');
    if(!fresh.resources.some(value=>value.path===resource.path))fresh.resources.push(resource);
  }
  const nativeConnection=await custodyConnection(client).witness();
  db.transaction(()=>{
    assertNativeCutoff(relation.canonical_input_id);
    input.validateSource();selectedFacts(input.requestId,client);
    const current=custodySuccessor(relation.canonical_input_id);
    if(!current||!['staged','custody'].includes(current.state)||current.state!==relation.state
      ||current.construction_intended_at!==null||current.handoff_id!==relation.handoff_id)
      fail('The staged operation changed while its native cutoff was established.');
    const plan={...JSON.parse(current.plan_json),nativeConnection};
    const snapshot={...fresh,proof,effects,cutoff};
    db.query("UPDATE codex_custody_successors SET snapshot_json=?,plan_json=? WHERE canonical_input_id=? AND state=? AND construction_intended_at IS NULL")
      .run(JSON.stringify(snapshot),JSON.stringify(plan),relation.canonical_input_id,current.state);
    relation.snapshot_json=JSON.stringify(snapshot);relation.plan_json=JSON.stringify(plan);
    recordSessionEvent({eventId:`custody-cutoff:${relation.canonical_input_id}:${hash(JSON.stringify(cutoff))}`,
      sessionId:relation.predecessor_session_id,inputId:relation.canonical_input_id,kind:'custody_native_cutoff',
      payload:{canonicalInputId:relation.canonical_input_id,handoffId:relation.handoff_id,cutoff,effects}});
  }).immediate();
  await ledgerDurable();
}

async function constructCustodySuccessor(input:CustodySuccessorRequest,relation:CustodySuccessorRow,client:CodexAppServerClientLike) {
  const snapshot=JSON.parse(relation.snapshot_json) as Awaited<ReturnType<typeof sourceSnapshot>>;
  const successorId=relation.successor_session_id,canonical=relation.canonical_input_id;
  let ownsIntent=false,constructed:CodexSuccessorConstruction|null=null;
  try {
    input.validateSource();await verifyResources(snapshot);
    input.validateSource();
    assertInstalledCustodyController(process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT||'/var/lib/slack-concierge-deployment');
    await custodyConnection(client).assert(JSON.parse(relation.plan_json).nativeConnection);
    const marked=db.transaction(()=>{
      assertNativeCutoff(canonical);
      input.validateSource();
      assertExcluded(relation.predecessor_session_id);
      const source=getSessionById(relation.predecessor_session_id),successor=getSessionById(successorId);
      const sourceMetadata=source?sessionMetadata(source):null,successorMetadata=successor?sessionMetadata(successor):null;
      const accepted=db.query(`SELECT inventory_json FROM session_handoffs WHERE id=? AND state='accepted'
        AND predecessor_session_id=? AND successor_session_id=?`).get(relation.handoff_id,relation.predecessor_session_id,successorId) as any;
      const original=getAcceptedSessionInput(canonical);
      const placement=db.query(`SELECT 1 FROM turns WHERE id=? AND session_id=? AND accepted_input_id=?
        AND status='queued' AND stop_requested_at IS NULL AND owner_instance_id IS NULL`)
        .get(relation.placement_turn_id,successorId,relation.placement_input_id);
      const obligation=db.query(`SELECT 1 FROM session_communication_requests WHERE request_id=? AND target_session_id=?
        AND outcome IS NULL AND json_extract(payload_json,'$.requestedEffect')='work'`).get(relation.request_id,successorId);
      if(!placement||!obligation||!accepted||!source||!successor||source.binding_generation!==snapshot.bindingGeneration
        ||source.agent_session_uuid!==snapshot.threadId||!isAstraModel(sourceMetadata?.model)||sourceMetadata.reasoningEffort!=='medium'
        ||!sourceMetadata.suspended||!successorMetadata?.suspended||successorMetadata.model!==sourceMetadata.model
        ||successorMetadata.reasoningEffort!=='medium'||successor.agent_session_uuid!==null
        ||!original||hash(original.payload_json)!==snapshot.payloadHash||supersededBy(source.id)!==`concierge:${successorId}`)
        fail('Current custody, accepted binding or source changed before native construction.');
      const plan=JSON.parse(relation.plan_json) as CodexSuccessorPlan;
      const value=plan.additionalContext?.custody;
      const currentPlan={...plan,additionalContext:{...plan.additionalContext,...(value?{custody:{...value,
        value:`${value.value.split('Exact obligation inventory:')[0]}Exact obligation inventory: ${accepted.inventory_json}`}}:{})}};
      relation.plan_json=JSON.stringify(currentPlan);
      return db.query(`UPDATE codex_custody_successors SET state='constructing',construction_intended_at=CURRENT_TIMESTAMP
        ,plan_json=? WHERE canonical_input_id=? AND state='custody' AND construction_intended_at IS NULL`).run(relation.plan_json,relation.canonical_input_id).changes===1;
    }).immediate();
    if(!marked)fail('Construction intent already exists or custody is not committed.');
    ownsIntent=true;
    await ledgerDurable();
    assertNativeCutoff(canonical);
    input.validateSource();
    constructed=await new CodexSuccessorNativeAdapter(client).construct(JSON.parse(relation.plan_json));
    // The native identity is an observed side effect as soon as thread/start returns. Persist it
    // synchronously before resource revalidation or any other await can fail or lose the response.
    db.transaction(()=>{
      if(db.query(`UPDATE codex_custody_successors SET native_thread_id=?,construction_json=?
        WHERE canonical_input_id=? AND state='constructing' AND native_thread_id IS NULL AND construction_json IS NULL`)
        .run(constructed!.threadId,JSON.stringify(constructed),canonical).changes!==1)
        fail('The returned native construction identity could not be retained.');
    }).immediate();
    if(constructed.threadId===snapshot.threadId)throw new CodexSuccessorConstructionMismatchError(constructed.threadId,
      constructed.response,'Native construction returned the original conversation identity.');
    await verifyResources(snapshot);
    db.transaction(()=>{
      assertExcluded(relation.predecessor_session_id);
      if(supersededBy(relation.predecessor_session_id)!==`concierge:${successorId}`)fail('Successor custody changed during construction.');
      if(db.query(`UPDATE codex_custody_successors SET state='constructed'
        WHERE canonical_input_id=? AND state='constructing' AND native_thread_id=? AND construction_json=?`)
        .run(canonical,constructed!.threadId,JSON.stringify(constructed)).changes!==1)
        fail('Construction reservation changed before its returned identity was bound.');
      if(db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=? AND agent_session_uuid IS NULL').run(constructed.threadId,successorId).changes!==1)
        fail('Successor native identity changed before binding.');
      const latest=getSessionById(successorId)!;
      updateSessionMetadata(successorId,{suspended:sessionMetadata(latest).custodyUserPaused===true});
      recordSessionEvent({eventId:`custody-successor:${canonical}`,sessionId:successorId,inputId:relation.placement_input_id,
        turnId:relation.placement_turn_id,kind:'custody_successor',payload:{basis:'codex_successor_custody_v1',canonicalInputId:canonical,
          handoffId:relation.handoff_id,threadId:constructed.threadId}});
    }).immediate();
    executionChanged();
  }catch(error){
    if(!ownsIntent)throw error;
    db.query(`UPDATE codex_custody_successors SET state='held',error=?,native_thread_id=COALESCE(?,native_thread_id),
      construction_json=COALESCE(?,construction_json) WHERE canonical_input_id=? AND state='constructing'`)
      .run(error instanceof Error?error.message:String(error),constructed?.threadId??(error instanceof CodexSuccessorConstructionMismatchError?error.threadId:null),
        constructed?JSON.stringify(constructed):error instanceof CodexSuccessorConstructionMismatchError?JSON.stringify(error.response):null,canonical);
    throw error;
  }
  return custodySuccessor(canonical)!;
}

/** One durable allowance across caller action IDs, successors, queue retries and reconnects. */
export async function consumeCustodyAttempt(turnId:number,ownerInstanceId:string,dispatchAttempt:number) {
  const row=custodyPlacement(turnId);if(!row)fail('No canonical successor placement.');
  await verifyResources(JSON.parse(row.snapshot_json));
  assertInstalledCustodyController(process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT||'/var/lib/slack-concierge-deployment');
  db.transaction(()=>{
    assertNativeCutoff(row.canonical_input_id);
    const current=custodyPlacement(turnId)!;
    const placement=getAcceptedSessionInput(current.placement_input_id),original=getAcceptedSessionInput(current.canonical_input_id);
    const session=getSessionById(current.successor_session_id)!;
    const plan=JSON.parse(current.plan_json) as CodexSuccessorPlan;
    const snapshot=JSON.parse(current.snapshot_json) as Awaited<ReturnType<typeof sourceSnapshot>>;
    const metadata=sessionMetadata(session);
    assertCustodyRunnerBinding(metadata.providerRunner,plan.nativeConnection?.endpoint??undefined);
    const owned=db.query(`SELECT 1 FROM turns WHERE id=? AND owner_instance_id=? AND dispatch_attempt=?
      AND status='running' AND stop_requested_at IS NULL`).get(turnId,ownerInstanceId,dispatchAttempt);
    const obligation=db.query(`SELECT 1 FROM session_communication_requests WHERE request_id=? AND target_session_id=?
      AND outcome IS NULL AND json_extract(payload_json,'$.requestedEffect')='work'`).get(current.request_id,current.successor_session_id);
    assertExcluded(current.predecessor_session_id);
    if(!owned||!obligation||current.state!=='constructed'||current.attempt_spent_at!==null||!placement||!original
      ||placement.payload_json!==original.payload_json||hash(original.payload_json)!==snapshot.payloadHash
      ||session.agent_session_uuid!==current.native_thread_id
      ||supersededBy(current.predecessor_session_id)!==`concierge:${current.successor_session_id}`
      ||metadata.model!==plan.model||metadata.reasoningEffort!=='medium'||metadata.suspended||metadata.outside
      ||metadata.cwd!==plan.cwd||JSON.stringify([...new Set([metadata.cwd,...(metadata.additionalDirs??[])])])!==JSON.stringify(plan.runtimeWorkspaceRoots))
      fail('Canonical successor attempt is spent, changed, stopped, or no longer exclusively owned.');
    if(db.query(`UPDATE codex_custody_successors SET state='admitting',attempt_spent_at=CURRENT_TIMESTAMP,dispatch_attempt=?
      WHERE canonical_input_id=? AND attempt_spent_at IS NULL AND state='constructed'`).run(dispatchAttempt,current.canonical_input_id).changes!==1)
      fail('Canonical attempt allowance was consumed concurrently.');
  }).immediate();
  await ledgerDurable();
  assertNativeCutoff(row.canonical_input_id);
  if(!db.query(`SELECT 1 FROM turns WHERE id=? AND owner_instance_id=? AND dispatch_attempt=?
    AND status='running' AND stop_requested_at IS NULL`).get(turnId,ownerInstanceId,dispatchAttempt))
    fail('The selected execution stopped while its consumed allowance became durable.');
}

export function protectedCustodyRun(turnId:number,ownerInstanceId:string,dispatchAttempt:number,
  native?:{client:CodexAppServerClientLike;observeProcesses?:(threadId:string)=>Promise<CodexLeftoverProcess[]>}) {
  const turn=db.query('SELECT session_id FROM turns WHERE id=?').get(turnId) as {session_id:number}|null;
  const row=custodyPlacement(turnId)??(turn?custodySuccessorSession(turn.session_id):null);if(!row)return null;
  if(!row.native_thread_id||!row.construction_json)fail('Successor construction is not confirmed.');
  return {plan:JSON.parse(row.plan_json) as CodexSuccessorPlan,construction:JSON.parse(row.construction_json) as CodexSuccessorConstruction,
    beforeAdmission:async()=>{
      const retainedPlan=JSON.parse(row.plan_json) as CodexSuccessorPlan;
      if(native)await custodyConnection(native.client).assert(retainedPlan.nativeConnection);
      if(row.placement_turn_id===turnId){
        await consumeCustodyAttempt(turnId,ownerInstanceId,dispatchAttempt);
        if(native)await custodyConnection(native.client).assert(retainedPlan.nativeConnection);
        return;
      }
      assertNativeCutoff(row.canonical_input_id);
      assertInstalledCustodyController(process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT||'/var/lib/slack-concierge-deployment');
      const session=getSessionById(row.successor_session_id)!;
      const live=db.query(`SELECT 1 FROM turns WHERE id=? AND session_id=? AND owner_instance_id=? AND dispatch_attempt=?
        AND status='running' AND stop_requested_at IS NULL`).get(turnId,row.successor_session_id,ownerInstanceId,dispatchAttempt);
      const metadata=sessionMetadata(session);
      const plan=JSON.parse(row.plan_json) as CodexSuccessorPlan;
      const current=custodySuccessor(row.canonical_input_id)!;
      assertCustodyRunnerBinding(metadata.providerRunner,plan.nativeConnection?.endpoint??undefined);
      if(!live||!['admitted','acknowledged'].includes(current.state)||session.agent_session_uuid!==row.native_thread_id||metadata.suspended||metadata.model!==plan.model
        ||metadata.reasoningEffort!=='medium'||metadata.cwd!==plan.cwd
        ||JSON.stringify([...new Set([metadata.cwd,...(metadata.additionalDirs??[])])])!==JSON.stringify(plan.runtimeWorkspaceRoots)
        ||supersededBy(row.predecessor_session_id)!==`concierge:${session.id}`)
        fail('The subsequent input lost its protected successor binding.');
      assertExcluded(row.predecessor_session_id);
      const selected=db.query('SELECT status FROM turns WHERE id=?').get(row.placement_turn_id) as {status:string};
      if(!['done','error','cancelled'].includes(selected.status))
        fail('The selected attempt has no terminal owner outcome; later work remains held.');
      if(selected.status==='error'||selected.status==='cancelled'){
        if(!native||!custodySelectedTerminalConfirmed(row.canonical_input_id))
          fail('Later work remains held until the acknowledged selected attempt has exact native terminal evidence.');
        const connection=custodyConnection(native.client);
        await connection.assert(plan.nativeConnection);
        const receipt=await reconcileCodexCustodyPredecessorEffects(connection,{predecessorSessionId:row.successor_session_id,
          threadId:row.native_thread_id!,selectedTurnId:row.placement_turn_id,admittingTurnId:turnId},
          native.observeProcesses??(async threadId=>{
            const association=await connection.witness();
            const endpoint=custodyProcessEndpoint(association.endpoint??undefined);
            const result=await observeCodexCustodyProcesses(threadId,endpoint.socketPath,endpoint.nativePid);
            await connection.assert(association);
            return result;
          }));
        await connection.assert(plan.nativeConnection);
        assertNativeCutoff(row.canonical_input_id);
        const latest=getSessionById(row.successor_session_id)!;
        const latestMetadata=sessionMetadata(latest),latestRelation=custodySuccessor(row.canonical_input_id)!;
        if(latestMetadata.suspended||latest.agent_session_uuid!==row.native_thread_id||latestMetadata.model!==plan.model
          ||latestMetadata.reasoningEffort!=='medium'||latestMetadata.cwd!==plan.cwd
          ||JSON.stringify([...new Set([latestMetadata.cwd,...(latestMetadata.additionalDirs??[])])])!==JSON.stringify(plan.runtimeWorkspaceRoots)
          ||latestRelation.plan_json!==row.plan_json||latestRelation.state!=='acknowledged'
          ||supersededBy(row.predecessor_session_id)!==`concierge:${latest.id}`
          ||!custodySelectedTerminalConfirmed(row.canonical_input_id)
          ||!db.query(`SELECT 1 FROM turns WHERE id=? AND owner_instance_id=? AND dispatch_attempt=?
            AND status='running' AND stop_requested_at IS NULL`).get(turnId,ownerInstanceId,dispatchAttempt))
          fail('The successor changed while terminal effects were reconciled; later work remains held.');
        assertExcluded(row.predecessor_session_id);
        recordSessionEvent({eventId:`custody-terminal-effects:${turnId}:${dispatchAttempt}`,sessionId:row.successor_session_id,
          turnId,kind:'custody_terminal_effects',payload:{canonicalInputId:row.canonical_input_id,nativeConnection:plan.nativeConnection,receipt}});
      }
    }};
}
