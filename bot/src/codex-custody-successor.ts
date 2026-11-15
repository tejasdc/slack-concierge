import {createHash} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {db,getSessionById,executionChanged} from './state';
import {getAcceptedSessionInput,retainSessionInput,nativeRunId,sessionMetadata,updateSessionMetadata,recordSessionEvent} from './session-inputs';
import {stageRecoveryHandoff,commitRecoveryHandoff,supersededBy} from './session-handoff';
import {CodexSuccessorNativeAdapter,CodexSuccessorConstructionMismatchError,type CodexSuccessorPlan,type CodexSuccessorConstruction} from './codex-successor-native';
import {codexOwnedThreadConfig} from './codex';
import {providerOwnerEnvironment} from './provider-owner-environment';
import {requireCustodyReader,assertInstalledCustodyController} from './codex-custody-compatibility';
import {sessionInputInstructions} from './session-input-context';
import {isWritingSession,WRITING_SESSION_STANDING} from './session-roles';
import type {CodexAppServerClientLike} from './codex-app-server-client';
import {proveCodexInputNeverAcknowledged} from './codex-unacknowledged-proof';
import {ledgerDurable} from './ledger-durability-barrier';

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
async function sourceFingerprint(path:string) {
  const before=await stat(path),digest=createHash('sha256');let bytes=0;
  for await(const chunk of createReadStream(path)){digest.update(chunk);bytes+=chunk.length;}
  const after=await stat(path);
  if(bytes!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.dev!==after.dev||before.ino!==after.ino)
    fail('Original source changed while its current boundary was read.');
  return {bytes,digest:digest.digest('hex'),sourceDevice:before.dev,sourceInode:before.ino};
}

function selectedFacts(requestId:string) {
  const request=db.query('SELECT * FROM session_communication_requests WHERE request_id=?').get(requestId) as any;
  const selected=getAcceptedSessionInput(`report-back:${requestId}`);
  const session=request?getSessionById(request.target_session_id):null;
  if(!request||request.outcome!==null||JSON.parse(request.payload_json).requestedEffect!=='work'||!session
    ||session.provider_id!=='codex'||!session.agent_session_uuid||!selected||selected.session_id!==session.id
    ||selected.origin!=='service'||selected.request_id!==requestId||selected.turn_id===null||selected.steering_id!==null)
    return fail('Recovery needs the exact retained service reminder of an open work request.');
  const metadata=sessionMetadata(session),receipt=JSON.parse(selected.receipt_json??'{}');
  const turn=db.query('SELECT * FROM turns WHERE id=? AND accepted_input_id=? AND session_id=?')
    .get(selected.turn_id,selected.id,session.id) as any;
  const admission=receipt.admission;
  const effort=admission?.reasoningEffort??(db.query(`SELECT json_extract(payload_json,'$.effort') AS effort
    FROM session_owner_events WHERE event_id=? AND session_id=? AND turn_id=? AND kind='prompt_cache_identity'`)
    .get(`prompt-cache-identity:${turn?.id}:${turn?.dispatch_attempt}`,session.id,turn?.id) as any)?.effort;
  if(metadata.model!=='gpt-6-astra'||metadata.reasoningEffort!=='medium'||metadata.outside||metadata.interactionPolicy
    ||metadata.providerRunner||session.status==='archived'||metadata.suspended||!turn
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

async function sourceSnapshot(client:CodexAppServerClientLike,facts:ReturnType<typeof selectedFacts>) {
  const read=await client.request('thread/read',{threadId:facts.session.agent_session_uuid,includeTurns:false});
  const thread=read?.thread;
  if(thread?.id!==facts.session.agent_session_uuid||typeof thread.path!=='string'||!thread.path.startsWith('/'))
    return fail('The original conversation source path is unavailable.');
  const source=await sourceFingerprint(thread.path);
  const roots=[...new Set([facts.metadata.cwd,...(facts.metadata.additionalDirs??[])])];
  if(roots.some(root=>typeof root!=='string'||!root.startsWith('/')))fail('Owner workspace roots are incomplete.');
  const resources=await Promise.all((roots as string[]).map(async path=>{const value=await stat(path);
    if(!value.isDirectory())fail('A retained workspace root is no longer a directory.');return {path,dev:value.dev,ino:value.ino};}));
  if(typeof thread.modelProvider!=='string'||!thread.modelProvider)fail('The retained native provider identity is unavailable.');
  return {path:thread.path as string,...source,resources,
    provider:thread.modelProvider as string,payloadHash:hash(facts.selected.payload_json),
    bindingGeneration:facts.session.binding_generation,threadId:facts.session.agent_session_uuid};
}
async function verifyResources(snapshot:Awaited<ReturnType<typeof sourceSnapshot>>) {
  const source=await sourceFingerprint(snapshot.path);
  if(source.bytes!==snapshot.bytes||source.digest!==snapshot.digest||source.sourceDevice!==snapshot.sourceDevice||source.sourceInode!==snapshot.sourceInode)
    fail('Original source changed during successor preparation.');
  for(const resource of snapshot.resources){const now=await stat(resource.path);
    if(!now.isDirectory()||now.dev!==resource.dev||now.ino!==resource.ino)fail('A retained resource was replaced or remapped.');}
}

export interface CustodySuccessorRequest {
  actorSession:number; sourceInputId:string; sourceRunId:string; requestId:string; actionId:string;
  validateSource():void;
}

/** Called only behind the owner's authenticated live-work entrance. No model, effort,
 * assessment, diagnostic proof or native identity can be supplied by that caller. */
export async function recoverCustodySuccessor(input:CustodySuccessorRequest,client:CodexAppServerClientLike) {
  input.validateSource();
  const prior=custodySuccessor(`report-back:${input.requestId}`);
  if(prior){
    const handoff=db.query('SELECT caller_session_id,inventory_digest FROM session_handoffs WHERE id=?').get(prior.handoff_id) as any;
    if(handoff?.caller_session_id!==input.actorSession)fail('The retained recovery belongs to another repair custodian.');
    if(prior.state==='staged'){
      const facts=selectedFacts(input.requestId);
      await reconcileSelected(client,facts);
      await verifyResources(JSON.parse(prior.snapshot_json));
      input.validateSource();
      let accepted=await commitRecoveryHandoff({actorSession:input.actorSession,inputId:input.sourceInputId,runId:input.sourceRunId,
        handoffId:prior.handoff_id,digest:handoff.inventory_digest,placementInputId:prior.placement_input_id,placementTurnId:prior.placement_turn_id});
      // A changed inventory is read from the owner, then checked again inside the transfer transaction.
      if(!accepted.accepted&&'digest' in accepted)accepted=await commitRecoveryHandoff({actorSession:input.actorSession,
        inputId:input.sourceInputId,runId:input.sourceRunId,handoffId:prior.handoff_id,digest:accepted.digest,
        placementInputId:prior.placement_input_id,placementTurnId:prior.placement_turn_id});
      if(!accepted.accepted)fail('Current inventory could not be committed; successor remains passive.');
    }
    const current=custodySuccessor(prior.canonical_input_id)!;
    if(current.state==='custody'&&current.construction_intended_at===null)return constructCustodySuccessor(input,current,client);
    return current;
  }
  const facts=selectedFacts(input.requestId);
  const proof=await reconcileSelected(client,facts),snapshot=await sourceSnapshot(client,facts);
  input.validateSource();
  assertInstalledCustodyController(process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT||'/var/lib/slack-concierge-deployment');
  requireCustodyReader(process.env.CONCIERGE_STATE_DIR!);
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
  await verifyResources(snapshot);
  const latest=selectedFacts(input.requestId);
  if(latest.selected.payload_json!==facts.selected.payload_json||latest.session.binding_generation!==snapshot.bindingGeneration)
    fail('Canonical input or retained binding changed while staging custody.');
  const relation=db.transaction(()=>{
    const raced=custodySuccessor(facts.selected.id);if(raced)return raced;
    if(db.query('SELECT 1 FROM codex_unacknowledged_recoveries WHERE accepted_input_id=?').get(facts.selected.id))
      fail('The canonical reminder acquired a different recovery reservation while staging.');
    const placement=retainSessionInput({id:`custody-placement:${facts.selected.id}`,sessionId:successorId,
      scope:`custody-successor:${facts.selected.id}`,actionId:'placement',kind:'input',origin:facts.selected.origin,
      payload:JSON.parse(facts.selected.payload_json),sourceInputId:facts.selected.id,sourceRunId:nativeRunId(facts.turn.id),requestId:input.requestId}).input;
    const payload=JSON.parse(placement.payload_json);
    const turn=db.query(`INSERT INTO turns(session_id,user_text,status,turn_kind,accepted_input_id,requested_by_user_id,
      provider_model,reasoning_effort,replay_text) VALUES(?,?,'queued','native',?,'service','gpt-6-astra','medium',?)`)
      .run(successorId,payload.text,placement.id,payload.text);
    const turnId=Number(turn.lastInsertRowid);nativeRunId(turnId);
    db.query('UPDATE session_inputs SET turn_id=? WHERE id=?').run(turnId,placement.id);
    const ownerEnvironment=providerOwnerEnvironment();
    const {CONCIERGE_COMMIT_PROVENANCE:_provenance,CONCIERGE_COMMIT_INPUT:_commitInput,...shellEnvironment}=ownerEnvironment;
    const plan:CodexSuccessorPlan={operationId:staged.handoffId,model:'gpt-6-astra',provider:snapshot.provider,
      cwd:facts.metadata.cwd!,runtimeWorkspaceRoots:[...new Set([facts.metadata.cwd!,...(facts.metadata.additionalDirs??[])])],environmentId:'local',config:codexOwnedThreadConfig(shellEnvironment),
      approvalPolicy:'never',sandbox:'danger-full-access',custodyCommitted:true,predecessorExcluded:true,
      additionalContext:{instructions:{kind:'application',value:sessionInputInstructions({standing:isWritingSession(facts.session)?WRITING_SESSION_STANDING:null})},
        custody:{kind:'application',value:`Continue the preserved duties of concierge:${facts.session.id}. Read its retained conversation through sessions context. Original source: ${snapshot.path}. Existing accepted work must not be replayed. Resource access is preservation, not productive write ownership. Preserve separately assigned productive custodians: do not edit or reset their retained worktrees. Read the repair coordinator's retained source for current scope: ${input.sourceInputId}. Exact obligation inventory: ${JSON.stringify(staged.inventory??{})}`}}};
    db.query(`INSERT INTO codex_custody_successors(canonical_input_id,predecessor_session_id,successor_session_id,handoff_id,
      placement_input_id,placement_turn_id,request_id,source_input_id,source_run_id,state,plan_json,snapshot_json)
      VALUES(?,?,?,?,?,?,?,?,?,'staged',?,?)`).run(facts.selected.id,facts.session.id,successorId,staged.handoffId,
        placement.id,turnId,input.requestId,input.sourceInputId,input.sourceRunId,JSON.stringify(plan),JSON.stringify({...snapshot,proof}));
    return custodySuccessor(facts.selected.id)!;
  }).immediate();
  const committed=await commitRecoveryHandoff({actorSession:input.actorSession,inputId:input.sourceInputId,runId:input.sourceRunId,
    handoffId:relation.handoff_id,digest:staged.digest,placementInputId:relation.placement_input_id,placementTurnId:relation.placement_turn_id});
  if(!committed.accepted)fail('Custody inventory changed; native construction remains withheld.');
  return constructCustodySuccessor(input,relation,client);
}

async function constructCustodySuccessor(input:CustodySuccessorRequest,relation:CustodySuccessorRow,client:CodexAppServerClientLike) {
  const snapshot=JSON.parse(relation.snapshot_json) as Awaited<ReturnType<typeof sourceSnapshot>>;
  const successorId=relation.successor_session_id,canonical=relation.canonical_input_id;
  let ownsIntent=false;
  try {
    input.validateSource();await verifyResources(snapshot);
    input.validateSource();
    assertInstalledCustodyController(process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT||'/var/lib/slack-concierge-deployment');
    const marked=db.transaction(()=>{
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
        ||source.agent_session_uuid!==snapshot.threadId||sourceMetadata?.model!=='gpt-6-astra'||sourceMetadata.reasoningEffort!=='medium'
        ||!sourceMetadata.suspended||!successorMetadata?.suspended||successorMetadata.model!=='gpt-6-astra'
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
    input.validateSource();
    const constructed=await new CodexSuccessorNativeAdapter(client).construct(JSON.parse(relation.plan_json));
    if(constructed.threadId===snapshot.threadId)throw new CodexSuccessorConstructionMismatchError(constructed.threadId,
      constructed.response,'Native construction returned the original conversation identity.');
    await verifyResources(snapshot);
    db.transaction(()=>{
      assertExcluded(relation.predecessor_session_id);
      if(supersededBy(relation.predecessor_session_id)!==`concierge:${successorId}`)fail('Successor custody changed during construction.');
      if(db.query(`UPDATE codex_custody_successors SET state='constructed',native_thread_id=?,construction_json=?
        WHERE canonical_input_id=? AND state='constructing'`).run(constructed.threadId,JSON.stringify(constructed),canonical).changes!==1)
        fail('Construction reservation changed before its returned identity was bound.');
      if(db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=? AND agent_session_uuid IS NULL').run(constructed.threadId,successorId).changes!==1)
        fail('Successor native identity changed before binding.');
      updateSessionMetadata(successorId,{suspended:false});
      recordSessionEvent({eventId:`custody-successor:${canonical}`,sessionId:successorId,inputId:relation.placement_input_id,
        turnId:relation.placement_turn_id,kind:'custody_successor',payload:{basis:'codex_successor_custody_v1',canonicalInputId:canonical,
          handoffId:relation.handoff_id,threadId:constructed.threadId}});
    }).immediate();
    executionChanged();
  }catch(error){
    if(!ownsIntent)throw error;
    db.query(`UPDATE codex_custody_successors SET state='held',error=?,native_thread_id=COALESCE(?,native_thread_id),
      construction_json=COALESCE(?,construction_json) WHERE canonical_input_id=? AND state='constructing'`)
      .run(error instanceof Error?error.message:String(error),error instanceof CodexSuccessorConstructionMismatchError?error.threadId:null,
        error instanceof CodexSuccessorConstructionMismatchError?JSON.stringify(error.response):null,canonical);
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
    const current=custodyPlacement(turnId)!;
    const placement=getAcceptedSessionInput(current.placement_input_id),original=getAcceptedSessionInput(current.canonical_input_id);
    const session=getSessionById(current.successor_session_id)!;
    const plan=JSON.parse(current.plan_json) as CodexSuccessorPlan;
    const snapshot=JSON.parse(current.snapshot_json) as Awaited<ReturnType<typeof sourceSnapshot>>;
    const metadata=sessionMetadata(session);
    const owned=db.query(`SELECT 1 FROM turns WHERE id=? AND owner_instance_id=? AND dispatch_attempt=?
      AND status='running' AND stop_requested_at IS NULL`).get(turnId,ownerInstanceId,dispatchAttempt);
    const obligation=db.query(`SELECT 1 FROM session_communication_requests WHERE request_id=? AND target_session_id=?
      AND outcome IS NULL AND json_extract(payload_json,'$.requestedEffect')='work'`).get(current.request_id,current.successor_session_id);
    assertExcluded(current.predecessor_session_id);
    if(!owned||!obligation||current.state!=='constructed'||current.attempt_spent_at!==null||!placement||!original
      ||placement.payload_json!==original.payload_json||hash(original.payload_json)!==snapshot.payloadHash
      ||session.agent_session_uuid!==current.native_thread_id
      ||supersededBy(current.predecessor_session_id)!==`concierge:${current.successor_session_id}`
      ||metadata.model!=='gpt-6-astra'||metadata.reasoningEffort!=='medium'||metadata.suspended||metadata.outside||metadata.providerRunner
      ||metadata.cwd!==plan.cwd||JSON.stringify([...new Set([metadata.cwd,...(metadata.additionalDirs??[])])])!==JSON.stringify(plan.runtimeWorkspaceRoots))
      fail('Canonical successor attempt is spent, changed, stopped, or no longer exclusively owned.');
    if(db.query(`UPDATE codex_custody_successors SET state='admitting',attempt_spent_at=CURRENT_TIMESTAMP,dispatch_attempt=?
      WHERE canonical_input_id=? AND attempt_spent_at IS NULL AND state='constructed'`).run(dispatchAttempt,current.canonical_input_id).changes!==1)
      fail('Canonical attempt allowance was consumed concurrently.');
  }).immediate();
  await ledgerDurable();
  if(!db.query(`SELECT 1 FROM turns WHERE id=? AND owner_instance_id=? AND dispatch_attempt=?
    AND status='running' AND stop_requested_at IS NULL`).get(turnId,ownerInstanceId,dispatchAttempt))
    fail('The selected execution stopped while its consumed allowance became durable.');
}

export function protectedCustodyRun(turnId:number,ownerInstanceId:string,dispatchAttempt:number) {
  const turn=db.query('SELECT session_id FROM turns WHERE id=?').get(turnId) as {session_id:number}|null;
  const row=custodyPlacement(turnId)??(turn?custodySuccessorSession(turn.session_id):null);if(!row)return null;
  if(!row.native_thread_id||!row.construction_json)fail('Successor construction is not confirmed.');
  return {plan:JSON.parse(row.plan_json) as CodexSuccessorPlan,construction:JSON.parse(row.construction_json) as CodexSuccessorConstruction,
    beforeAdmission:async()=>{
      if(row.placement_turn_id===turnId)return consumeCustodyAttempt(turnId,ownerInstanceId,dispatchAttempt);
      assertInstalledCustodyController(process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT||'/var/lib/slack-concierge-deployment');
      const session=getSessionById(row.successor_session_id)!;
      const live=db.query(`SELECT 1 FROM turns WHERE id=? AND session_id=? AND owner_instance_id=? AND dispatch_attempt=?
        AND status='running' AND stop_requested_at IS NULL`).get(turnId,row.successor_session_id,ownerInstanceId,dispatchAttempt);
      const metadata=sessionMetadata(session);
      const plan=JSON.parse(row.plan_json) as CodexSuccessorPlan;
      if(!live||session.agent_session_uuid!==row.native_thread_id||metadata.suspended||metadata.model!=='gpt-6-astra'
        ||metadata.reasoningEffort!=='medium'||metadata.cwd!==plan.cwd
        ||JSON.stringify([...new Set([metadata.cwd,...(metadata.additionalDirs??[])])])!==JSON.stringify(plan.runtimeWorkspaceRoots)
        ||supersededBy(row.predecessor_session_id)!==`concierge:${session.id}`)
        fail('The subsequent input lost its protected successor binding.');
      assertExcluded(row.predecessor_session_id);
    }};
}
