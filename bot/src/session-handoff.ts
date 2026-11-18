import {createHash,randomUUID} from 'node:crypto';
import {readFile,readdir,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {db,executionChanged,finishTurn,getSessionById,settleTurnDependencies} from './state';
import {createNativeSession,enqueueSessionInput,getAcceptedSessionInput,nativeRunId,recordSessionEvent,retainSessionInput,sessionInputProvenance,sessionMetadata,stablePayload,updateSessionMetadata} from './session-inputs';
import {lastLaunchedConversationHome} from './session-runner-home';
import {safeTurn,type WaitingTurn} from './provider-exhaustion-recovery';
import {isAstraModel,parseProviderSelector,resolveProviderSelector,normalizeReasoningEffort} from './aliases';
import {escalationReason,topModel} from './model-escalation';
import {humanChoseTopModel} from './model-escalation-custody';
import {sessionAddress} from './session-address';
import {transferChatGptAnswerOwnership} from './chatgpt-obligations';
import {takeInboxRouterRole} from './standing-agents';
import {assertInboxMove} from './inbox-session-pin';
import {requesterPlacesHeldBy} from './requester-place';
import {claudeConfigDir,locateClaudeTranscript} from './claude-transcript-watch';
import {runnerMachineCall,RunnerMachineCallError,RunnerUnreachableError,type RunnerMachineAnswerIdentity} from './runner-machine-calls';
import {resolveRunnerProjectLocation,type RunnerProjectLocation} from './runner-project-location';
import {undeliveredRequestState} from './request-prerequisite-hold';
import {resolveUsageHoldNoticesForSettledTurn,type UsageProvider} from './provider-usage';

const run=promisify(execFile);
type Item={id:string;kind:'sent'|'owed'|'answer'|'queued'|'watch'|'lab'|'worktree';ref:string;holder:string;[key:string]:unknown};
type Inventory={items:Item[];omissions:string[];dispositions?:{kind:string;source:string;reason:string;preservedSourcePath:string;namespace:Record<string,unknown>;effect:string}[]};
type HandoffRow={id:string;predecessor_session_id:number;successor_session_id:number;state:string;action_id:string;caller_session_id:number;requesting_input_id:string;inventory_json:string;inventory_digest:string;handoff_kind?:string;canonical_input_id?:string|null};
const digest=(value:Inventory)=>createHash('sha256').update(stablePayload(value)).digest('hex');
const RECOVERY_HANDOFF_AUTHORITY=Symbol('owner-validated-codex-recovery-handoff');
const canonical=(id:number)=>`concierge:${id}`;
const row=(id:string)=>db.query('SELECT * FROM session_handoffs WHERE id=?').get(id) as HandoffRow|null;
const requestRow=(id:string)=>db.query('SELECT request_id,source_session_id,source_input_id,target_input_id,payload_json FROM session_communication_requests WHERE request_id=?')
  .get(id) as {request_id:string;source_session_id:number;source_input_id:string|null;target_input_id:string|null;payload_json:string};
const pending=(id:number)=>db.query("SELECT * FROM session_handoffs WHERE predecessor_session_id=? AND state='proposed'").get(id) as HandoffRow|null;

export function supersededBy(sessionId:number):string|null {
  const accepted=db.query("SELECT successor_session_id FROM session_handoffs WHERE predecessor_session_id=? AND state='accepted' ORDER BY accepted_at DESC LIMIT 1")
    .get(sessionId) as {successor_session_id:number}|null;
  return accepted?canonical(accepted.successor_session_id):null;
}

export function supersededAddress(sessionId:number):string|null {
  const successor=supersededBy(sessionId);
  const row=successor?getSessionById(Number(successor.slice('concierge:'.length))):null;
  return row?sessionAddress(row):null;
}

export function withdrawnSuccessor(sessionId:number):boolean {
  return !!db.query("SELECT 1 FROM session_handoffs WHERE successor_session_id=? AND state='withdrawn'").get(sessionId);
}

export function handoffView(sessionId:number):{continues:string[];supersededBy:string|null;handoffId:string|null}|null {
  const previous:string[]=[];
  let current=sessionId,first:HandoffRow|null=null;
  const seen=new Set<number>([sessionId]);
  while(true){
    const found=db.query("SELECT * FROM session_handoffs WHERE successor_session_id=? AND state='accepted' ORDER BY accepted_at DESC LIMIT 1").get(current) as HandoffRow|null;
    if(!found||seen.has(found.predecessor_session_id))break;
    previous.unshift(canonical(found.predecessor_session_id));seen.add(found.predecessor_session_id);current=found.predecessor_session_id;
  }
  first=db.query("SELECT * FROM session_handoffs WHERE predecessor_session_id=? AND state IN ('proposed','accepted') ORDER BY created_at DESC LIMIT 1").get(sessionId) as HandoffRow|null;
  const incoming=db.query("SELECT * FROM session_handoffs WHERE successor_session_id=? AND state IN ('proposed','accepted') ORDER BY created_at DESC LIMIT 1").get(sessionId) as HandoffRow|null;
  if(!first&&!incoming)return null;
  return {continues:previous,supersededBy:first?.state==='accepted'?canonical(first.successor_session_id):null,handoffId:first?.id??incoming?.id??null};
}

function ledgerItems(sessionId:number):Item[] {
  const holder=canonical(sessionId),items:Item[]=[];
  for(const request of db.query(`SELECT request_id,target_session_id,target_input_id,status FROM session_communication_requests
    WHERE source_session_id=? AND outcome IS NULL ORDER BY created_at_ms,request_id`).all(sessionId) as any[]){
    const turn=request.target_input_id?db.query('SELECT t.provider_input_acknowledged_at,t.provider_turn_id,t.status FROM session_inputs i LEFT JOIN turns t ON t.id=i.turn_id WHERE i.id=?').get(request.target_input_id) as any:null;
    const target=getSessionById(request.target_session_id);
    items.push({id:`sent:${request.request_id}`,kind:'sent',ref:request.request_id,holder,target:canonical(request.target_session_id),status:request.status,
      doNotRedispatch:!!turn?.provider_input_acknowledged_at||!!turn?.provider_turn_id||target?.provider_id==='chatgpt',
      ...(undeliveredRequestState(requestRow(request.request_id))??{})});
  }
  // A worker can settle a request before its final return reaches the asker. That return is
  // still owed to whoever holds the asking work, so it moves with the handoff (Inbox 8785 →
  // 8876, 2026-11-06: two returns reached the suspended predecessor after acceptance).
  for(const [requests,events,target] of [
    ['session_communication_requests','session_communication_events',"'concierge:'||request.target_session_id"],
    ['session_peer_requests','session_peer_events',"request.peer||':'||request.remote_session_id"]] as const)
    for(const request of db.query(`SELECT request.request_id,${target} AS target FROM ${requests} request
      WHERE request.source_session_id=? AND request.outcome IS NOT NULL AND EXISTS (SELECT 1 FROM ${events} event
        WHERE event.request_id=request.request_id AND event.kind='final' AND event.superseded_by_event_id IS NULL AND event.status NOT IN ('received','retained'))
      ORDER BY request.created_at_ms,request.request_id`).all(sessionId) as {request_id:string;target:string}[]){
      if(pendingReturnInputs(request.request_id).some(input=>input.state==='delivered'))continue;
      items.push({id:`sent:${request.request_id}`,kind:'sent',ref:request.request_id,holder,target:request.target,status:'settled',
        pendingReturn:true,doNotRedispatch:true});
    }
  for(const request of db.query('SELECT request_id,peer,remote_session_id,status FROM session_peer_requests WHERE source_session_id=? AND outcome IS NULL ORDER BY created_at_ms,request_id').all(sessionId) as any[])
    items.push({id:`sent:${request.request_id}`,kind:'sent',ref:request.request_id,holder,target:`${request.peer}:${request.remote_session_id}`,status:request.status,doNotRedispatch:true});
  for(const answer of db.query(`SELECT obligation_id,state,answer_event_id,answer_return_input_id FROM session_chatgpt_obligations
    WHERE asker_session_id=? AND state NOT IN ('resolved','withdrawn_by_tejas') ORDER BY created_at_ms,obligation_id`).all(sessionId) as any[])
    items.push({id:`answer:${answer.obligation_id}`,kind:'answer',ref:answer.obligation_id,holder,state:answer.state,
      answerEventId:answer.answer_event_id,answerReturnInputId:answer.answer_return_input_id});
  for(const [table,kind] of [['session_communication_requests','local'],['session_peer_deliveries','peer'],['session_external_requests','outside']] as const){
    const where=table==='session_peer_deliveries'?'closed_at_ms IS NULL':'outcome IS NULL';
    for(const request of db.query(`SELECT request_id,target_input_id FROM ${table} WHERE target_session_id=? AND ${where} ORDER BY rowid`).all(sessionId) as any[])
      // A local request that never reached a run is not work this session can do: reply refuses it,
      // and a held one waits on its requester's decision. Say so on the row instead of hiding it,
      // because a handoff must still move it.
      items.push({id:`owed:${request.request_id}`,kind:'owed',ref:request.request_id,holder,source:kind,targetInputId:request.target_input_id,
        ...(kind==='local'?undeliveredRequestState(requestRow(request.request_id))??{}:{})});
  }
  for(const input of db.query(`SELECT i.id AS input_id,i.turn_id,t.* FROM session_inputs i JOIN turns t ON t.id=i.turn_id
    WHERE i.session_id=? AND t.session_id=? AND t.status='queued' AND t.accepted_input_id=i.id ORDER BY t.id`).all(sessionId,sessionId) as any[]){
    // The answer duty represents its service repair input. Transfer withdraws an unstarted
    // repair, then the current holder receives a fresh prompt for the same exact answer.
    if(input.input_id.startsWith('chatgpt-repair:')&&safeTurn(input as WaitingTurn,getAcceptedSessionInput(input.input_id)!))continue;
    // A request's target input is already represented by its owed item; it is still a queued
    // execution and is shown here so the successor can see whether it is safe to move.
    const accepted=getAcceptedSessionInput(input.input_id)!;
    items.push({id:`queued:${input.input_id}`,kind:'queued',ref:input.input_id,holder,turnId:input.turn_id,
      movable:movableQueuedTurn(input as WaitingTurn,accepted),obsolete:obsoleteQueuedTurn(accepted)});
  }
  for(const repair of db.query(`SELECT i.id AS input_id,i.turn_id FROM session_inputs i JOIN turns t ON t.id=i.turn_id
    WHERE i.session_id=? AND t.session_id=? AND i.id GLOB 'chatgpt-repair:*'
      AND t.status='running' AND t.accepted_input_id=i.id ORDER BY t.id`).all(sessionId,sessionId) as any[])
    items.push({id:`queued:${repair.input_id}`,kind:'queued',ref:repair.input_id,holder,turnId:repair.turn_id,movable:false});
  for(const watch of db.query("SELECT watch_id,state FROM watches WHERE session_id=? AND (state IN ('accepted','observing') OR delivery_state='pending') ORDER BY created_at_ms,watch_id").all(sessionId) as any[])
    items.push({id:`watch:${watch.watch_id}`,kind:'watch',ref:watch.watch_id,holder,state:watch.state});
  return items;
}

/** Whether acceptance could move every queued input: the same rule `acceptHandoff` enforces, read
 * before a proposal so an automatic move never proposes a handoff its successor must refuse. */
export function queuedWorkMovable(sessionId:number):{queued:number;movable:boolean} {
  const queued=ledgerItems(sessionId).filter(item=>item.kind==='queued');
  return {queued:queued.length,movable:queued.every(item=>item.movable||item.obsolete)};
}

/**
 * Where each undelivered final return of a settled request stands on its asker's side.
 * unadmitted: nothing was written to the asker yet; unstarted: an accepted input with no turn
 * or steering; queued: waiting in a queued turn (moved by the queued item when safe);
 * delivered: already handed to a run, so the predecessor has it and it is never taken back.
 */
function pendingReturnInputs(requestId:string):{inputId:string|null;state:'unadmitted'|'unstarted'|'queued'|'delivered'}[] {
  return (db.query(`SELECT accepted_input_id FROM session_communication_events WHERE request_id=? AND kind='final'
    AND superseded_by_event_id IS NULL AND status NOT IN ('received','retained')
    UNION ALL SELECT accepted_input_id FROM session_peer_events WHERE request_id=? AND kind='final'
    AND superseded_by_event_id IS NULL AND status NOT IN ('received','retained')`).all(requestId,requestId) as {accepted_input_id:string|null}[]).map(event=>{
    if(!event.accepted_input_id)return {inputId:null,state:'unadmitted' as const};
    const input=getAcceptedSessionInput(event.accepted_input_id);
    if(!input||input.steering_id!==null||(input.receipt_json&&JSON.parse(input.receipt_json).state))return {inputId:event.accepted_input_id,state:'delivered' as const};
    if(input.turn_id===null)return {inputId:input.id,state:'unstarted' as const};
    const turn=db.query('SELECT status FROM turns WHERE id=?').get(input.turn_id) as {status:string}|null;
    return {inputId:input.id,state:turn?.status==='queued'?'queued' as const:'delivered' as const};
  });
}

/**
 * Whether a ChatGPT answer's not-yet-acknowledged return input waits in a queued turn this handoff
 * moves (never started, no dependencies; see movableQueuedTurn). The answer duty can
 * then move too, and the receipt is recorded when the successor's provider acknowledges that input.
 * Waiting for the predecessor to acknowledge it deadlocked every handoff whose predecessor could not
 * run (concierge:9772 → 9874, 2026-11-16: Codex allowance exhausted with a review answer queued).
 */
function answerReturnTravels(answerEventId:string,movable:Set<string>):boolean {
  const event=(db.query(`SELECT accepted_input_id,status FROM session_communication_events WHERE event_id=?`).get(answerEventId)
    ??db.query(`SELECT accepted_input_id,status FROM session_peer_events WHERE event_id=?`).get(answerEventId)) as
    {accepted_input_id:string|null;status:string}|null;
  if(!event?.accepted_input_id||event.status==='received'||event.status==='retained')return false;
  const input=getAcceptedSessionInput(event.accepted_input_id);
  if(!input||input.steering_id!==null||(input.receipt_json&&JSON.parse(input.receipt_json).state))return false;
  return movable.has(input.id);
}

function movableQueuedTurn(turn:WaitingTurn,input:NonNullable<ReturnType<typeof getAcceptedSessionInput>>):boolean {
  // An unfired or replay-safe held schedule has no provider effects. Keep its turn and firing identity when
  // ownership moves: repeating schedules use that identity to book exactly one successor.
  return safeTurn(turn.saved_kind==='scheduled'?{...turn,saved_kind:null}:turn,input);
}

function obsoleteQueuedTurn(input:ReturnType<typeof getAcceptedSessionInput>):boolean {
  if(!input)return false;
  if(input.origin==='service'&&input.id.startsWith('thread-upkeep:')&&input.request_id){
    return !!db.query("SELECT 1 FROM inbox_requests WHERE request_id=? AND state='closed'").get(input.request_id);
  }
  if(input.scope==='turn-continuation'||input.id.startsWith('turn-continuation:')){
    return true;
  }
  return false;
}

/**
 * Codex writes each conversation to sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<thread id>.jsonl under
 * its home. The file is found by that exact thread-id suffix, newest day first. The first version
 * shelled out to `rg`, which the service has no binary for, so every Codex handoff missed its
 * worktrees (acceptance test, 2026-10-14).
 */
async function codexRollout(thread:string):Promise<string|null> {
  const root=join(process.env.CODEX_HOME??join(homedir(),'.codex'),'sessions'),suffix=`-${thread}.jsonl`;
  const names=async(path:string)=>(await readdir(path).catch(()=>[] as string[])).sort().reverse();
  for(const year of await names(root))for(const month of await names(join(root,year)))for(const day of await names(join(root,year,month))){
    const found=(await names(join(root,year,month,day))).find(name=>name.startsWith('rollout-')&&name.endsWith(suffix));
    if(found)return join(root,year,month,day,found);
  }
  return null;
}

async function worktrees(sessionId:number):Promise<{items:Item[];omissions:string[]}> {
  const session=getSessionById(sessionId)!;const meta=sessionMetadata(session);
  let runner=typeof meta.providerRunner==='string'?meta.providerRunner:null;
  let runnerSelection=meta.providerRunner===undefined?'unrecorded':meta.providerRunner===null?'metadata-null':'metadata';
  if(meta.providerRunner===undefined&&session.provider_id==='codex'){
    runner=process.env.CONCIERGE_CODEX_RUNNER?.trim()||null;runnerSelection='codex-config-fallback';
  }
  if(meta.providerRunner===undefined&&session.provider_id==='claude-code'&&session.agent_session_uuid){
    const prior=lastLaunchedConversationHome(db,sessionId,'claude-code');
    if(prior?.supervisor==='runner'){
      if(!prior.runner)return {items:[],omissions:['The exact runner lease for this conversation is unavailable; worktrees were not inspected.']};
      runner=prior.runner;
      runnerSelection='retained-conversation-lease';
    }
  }
  if(runner&&session.agent_session_uuid&&['codex','claude-code'].includes(session.provider_id)) {
    let phase='project-resolution',location:RunnerProjectLocation|null=null,answeringRunner:RunnerMachineAnswerIdentity|null=null;
    const observeAnswer=(identity:RunnerMachineAnswerIdentity|null)=>{answeringRunner=identity;};
    try {
      location=await resolveRunnerProjectLocation(runner,meta,observeAnswer);
      if(!location.project)return {items:[],omissions:['This conversation has no registered runner project for worktree inspection.']};
      phase='runner-worktree-query';
      const remote=await runnerMachineCall<{items:{path:string;branch:string;head:string;uncommittedFiles:number}[];transcriptAvailable:boolean}>(
        runner,'projects.worktrees',{project:location.project,provider:session.provider_id as 'codex'|'claude-code',sessionUUID:session.agent_session_uuid,
          account:typeof meta.providerAccount==='string'?meta.providerAccount:null},undefined,observeAnswer);
      phase='worktree-response-parse';
      if(!remote||!Array.isArray(remote.items)||typeof remote.transcriptAvailable!=='boolean'||remote.items.some(item=>
        !item||typeof item.path!=='string'||!item.path.startsWith('/')||typeof item.branch!=='string'||typeof item.head!=='string'
        ||!Number.isSafeInteger(item.uncommittedFiles)||item.uncommittedFiles<0))
        throw new Error('The runner returned a malformed projects.worktrees response.');
      return {items:remote.items.map(item=>({id:`worktree:${item.path}`,kind:'worktree',ref:item.path,holder:canonical(sessionId),
        branch:item.branch,head:item.head,uncommittedFiles:item.uncommittedFiles})),
        omissions:remote.transcriptAvailable?[]:['Provider transcript unavailable on its runner; worktree references were omitted.']};
    } catch(error) {
      const failure=error instanceof RunnerMachineCallError?error:null;
      const facts={phase,runner,runnerSelection,retainedRunner:meta.providerRunner===undefined?'undefined':meta.providerRunner,
        requestedLocation:{projectName:meta.projectName??null,projectPath:meta.projectPath??null,project:meta.project??null,cwd:meta.cwd??null},
        resolvedLocation:location,provider:session.provider_id,nativeConversationId:session.agent_session_uuid,
        retainedAccount:meta.providerAccount===undefined?'undefined':meta.providerAccount,
        answeringRunner:error instanceof RunnerUnreachableError?null:failure?.answeringRunner??answeringRunner,
        error:{name:error instanceof Error?error.name:'Error',code:failure?.code??(error as any)?.code??null,
          method:failure?.method??null,phase:failure?.phase??null,message:error instanceof Error?error.message:String(error)}};
      return {items:[],omissions:[`Runner worktree inventory failed: ${JSON.stringify(facts)}`]};
    }
  }
  const roots=[meta.cwd,...(meta.additionalDirs??[])].filter((value):value is string=>typeof value==='string'&&!!value);
  const items:Item[]=[],omissions:string[]=[];
  let transcript:string|null=null;
  if(session.agent_session_uuid){
    try{
      const path=session.provider_id==='claude-code'
        ?await locateClaudeTranscript(claudeConfigDir(),session.agent_session_uuid)
        :session.provider_id==='codex'?await codexRollout(session.agent_session_uuid):null;
      if(path){const size=(await stat(path)).size;if(size<=64*1024*1024)transcript=await readFile(path,'utf8');
        else omissions.push('Provider transcript exceeds the bounded worktree inventory read; inspect it in sessions context.');}
      else omissions.push('Provider transcript was unavailable for worktree discovery; inspect the predecessor conversation.');
    }catch{omissions.push('Provider transcript was unavailable for worktree discovery; inspect the predecessor conversation.');}
  }
  if(transcript&&meta.cwd){
    try{
      const {stdout}=await run('git',['-C',meta.cwd,'worktree','list','--porcelain'],{timeout:5000});
      for(const match of stdout.matchAll(/^worktree (.+)$/gm))if(transcript.includes(match[1]!))roots.push(match[1]!);
    }catch{omissions.push('Git worktree list could not be inspected.');}
  }
  for(const path of [...new Set(roots)]){
    try{
      const {stdout:root}=await run('git',['-C',path,'rev-parse','--show-toplevel'],{timeout:5000});
      const at=root.trim();if(items.some(item=>item.ref===at))continue;
      const [{stdout:branch},{stdout:head},{stdout:status}]=await Promise.all([
        run('git',['-C',at,'branch','--show-current'],{timeout:5000}),
        run('git',['-C',at,'rev-parse','HEAD'],{timeout:5000}),
        run('git',['-C',at,'status','--porcelain'],{timeout:5000})]);
      items.push({id:`worktree:${at}`,kind:'worktree',ref:at,holder:canonical(sessionId),branch:branch.trim(),head:head.trim(),uncommittedFiles:status.trim()?status.trimEnd().split('\n').length:0});
    }catch{omissions.push(`Worktree at ${path} could not be inspected.`);}
  }
  return {items,omissions};
}

async function labItems(sessionId:number,source:{inputId:string;runId:string}):Promise<{items:Item[];omissions:string[]}> {
  if(process.env.CONCIERGE_PEER_NAME==='mac')return {items:[],omissions:['Lab inventory is unavailable on this Mac; the server holds the Lab read key.']};
  try{
    const key=(await readFile(process.env.THINKERING_AGENT_TEST_KEY_FILE??'/root/.local/state/thinkering/agent-test-device.key','utf8')).trim();
    const response=await fetch(`${process.env.THINKERING_ORIGIN_URL??'https://thnkr.ing'}/api/lab`,{signal:AbortSignal.timeout(10000),headers:{authorization:`Bearer ${key}`,'x-concierge-agent-source':`${source.inputId} ${source.runId}`}});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const data=await response.json() as {threads?:any[]};
    const who=canonical(sessionId);
    return {items:(data.threads??[]).filter(thread=>!thread.closed&&(thread.owner===who||thread.decider===who||thread.members?.includes(who)))
      .map(thread=>({id:`lab:${thread.handle}`,kind:'lab' as const,ref:thread.handle,holder:who,role:[thread.owner===who?'owner':null,thread.decider===who?'decider':null,thread.members?.includes(who)?'member':null].filter(Boolean),state:thread})),omissions:[]};
  }catch(error){return {items:[],omissions:[`Lab inventory unavailable: ${error instanceof Error?error.message:String(error)}`]};}
}

async function inventory(sessionId:number,source:{inputId:string;runId:string},recovery?:{preservedSourcePath:string}):Promise<Inventory> {
  const [lab,git]=await Promise.all([labItems(sessionId,source),worktrees(sessionId)]);
  const items=[...ledgerItems(sessionId),...lab.items,...git.items],omissions=[...lab.omissions],dispositions:NonNullable<Inventory['dispositions']> = [];
  if(!recovery)omissions.push(...git.omissions);
  else {
    const session=getSessionById(sessionId)!,metadata=sessionMetadata(session);
    const namespace={sessionId,threadId:session.agent_session_uuid,cwd:metadata.cwd??null,additionalDirs:metadata.additionalDirs??[]};
    const disposition=(source:'transcript'|'git',reason:string)=>dispositions.push({kind:'discovery-limit',source,reason,
      preservedSourcePath:recovery.preservedSourcePath,namespace,
      effect:'The original source and retained namespace stay in place; no rewrite or remap occurs. This inventory is not exhaustive.'});
    for(const omission of git.omissions){
      if(omission.startsWith('Provider transcript unavailable')||omission.startsWith('Provider transcript exceeds the bounded worktree inventory read')){
        disposition('transcript',omission);continue;
      }
      if(omission==='Git worktree list could not be inspected.'){
        disposition('git',omission);continue;
      }
      const inaccessible=omission.match(/^Worktree at (.+) could not be inspected\.$/);
      if(inaccessible){
        try{
          const value=await stat(inaccessible[1]!);
          if(value.isDirectory()){
            if(!items.some(item=>item.kind==='worktree'&&item.ref===inaccessible[1]))items.push({id:`worktree:${inaccessible[1]}`,kind:'worktree',ref:inaccessible[1]!,holder:canonical(sessionId)});
            disposition('git',`${omission} The exact referenced directory is accessible and retained without Git inspection.`);continue;
          }
        }catch{/* keep the concrete omission below */}
      }
      omissions.push(omission);
    }
  }
  return {items:items.sort((a,b)=>a.id.localeCompare(b.id)),omissions:omissions.sort(),...(dispositions.length?{dispositions}: {})};
}

async function assertRecoveryResources(sessionId:number,preservedSourcePath:string,items:Item[]=[]):Promise<void> {
  if(!preservedSourcePath.startsWith('/'))throw new Error('Recovery source path must be absolute.');
  const source=await stat(preservedSourcePath);
  if(!source.isFile())throw new Error('The preserved native conversation source is unavailable.');
  const session=getSessionById(sessionId);if(!session)throw new Error('Recovery predecessor is unavailable.');
  const metadata=sessionMetadata(session),roots=[metadata.cwd,...(metadata.additionalDirs??[])].filter((value):value is string=>typeof value==='string');
  if(!metadata.cwd||roots.some(path=>!path.startsWith('/')))throw new Error('Recovery workspace namespace is incomplete.');
  for(const path of [...new Set([...roots,...items.filter(item=>item.kind==='worktree').map(item=>item.ref)])]){
    const resource=await stat(path);if(!resource.isDirectory())throw new Error(`Recovery resource directory is unavailable: ${path}`);
  }
}

export async function handoffObligations(sessionId:number,addressId?:number,source?:{inputId:string;runId:string}) {
  const target=addressId??sessionId;
  if(target!==sessionId&&!db.query(`SELECT 1 FROM session_handoffs WHERE (predecessor_session_id=? AND successor_session_id=?)
    OR (predecessor_session_id=? AND successor_session_id=?)`).get(sessionId,target,target,sessionId))
    throw new Error('Obligations can be read for this session or its handoff partner.');
  const current=source?await inventory(target,source):{items:ledgerItems(target),omissions:['Lab and worktree inventory needs a live source.']};
  const audit=db.query('SELECT kind,ref,from_session_id,to_session_id FROM session_handoff_items WHERE from_session_id=? OR to_session_id=? ORDER BY rowid').all(target,target) as any[];
  const successor=supersededBy(target);
  const items=current.items.map(item=>successor&&(item.kind==='lab'||item.kind==='worktree')?{...item,holder:successor,originalHolder:item.holder}:item);
  return {sessionId:canonical(target),handoff:handoffView(target),items,omissions:current.omissions,
    transferred:audit.map(item=>({...item,from:canonical(item.from_session_id),to:canonical(item.to_session_id)}))};
}

export async function proposeHandoff(input:{actorSession:number;inputId:string;runId:string;predecessorId:number;provider:string;model?:string;effort?:string;reason:string;sessionName?:string;actionId:string}) {
  const source=getSessionById(input.predecessorId);
  if(!source||source.status==='archived'||supersededBy(source.id))throw new Error('The predecessor is unavailable or already superseded.');
  const selector=parseProviderSelector(input.provider);
  if(!selector)throw new Error('Choose a supported coding provider alias for a handoff.');
  const selected=resolveProviderSelector(selector);
  assertInboxMove(source,{provider:selected.provider},input.inputId);
  const refused=escalationReason(input.model??selected.model,input.reason,humanChoseTopModel(input.inputId,input.model??selected.model??''));
  if(refused)throw new Error(refused);
  if(selected.provider==='chatgpt')throw new Error('ChatGPT cannot acknowledge a handoff.');
  const effort=input.effort?normalizeReasoningEffort(input.effort):selector.effort;
  if(input.effort&&!effort)throw new Error('Invalid reasoning effort.');
  const places=requesterPlacesHeldBy(input.actorSession);
  if(input.actorSession!==source.id&&!db.query(`SELECT 1 FROM session_communication_requests WHERE source_session_id IN (${places.map(()=>'?').join(',')})
      AND target_session_id=? AND outcome IS NULL LIMIT 1`).get(...places,source.id))
    throw new Error('Only the predecessor or the holder of an open requester’s place (the requester, its accepted handoff successor or the current Inbox router for an earlier router’s request) may propose this handoff.');
  if(!input.reason?.trim()||!input.actionId)throw new Error('A reason and stable action ID are required.');
  const snapshot=await inventory(source.id,{inputId:input.inputId,runId:input.runId});
  return db.transaction(()=>{
    const prior=db.query('SELECT * FROM session_handoffs WHERE requesting_input_id=? AND action_id=?').get(input.inputId,input.actionId) as HandoffRow|null;
    if(prior){if(prior.predecessor_session_id!==source.id||prior.handoff_kind!=='ordinary')throw new Error('Handoff action identity conflicts with another handoff kind or predecessor.');return {handoffId:prior.id,successor:canonical(prior.successor_session_id),inventory:JSON.parse(prior.inventory_json),digest:prior.inventory_digest,state:prior.state,duplicate:true};}
    if(supersededBy(source.id))throw new Error('The predecessor was superseded while preparing handoff.');
    assertInboxMove(getSessionById(source.id)!,{provider:selected.provider},input.inputId);
    const open=pending(source.id);if(open)throw new Error(`Handoff ${open.id} is already proposed for ${canonical(source.id)}.`);
    const now=inventoryLocalWithExternal(source.id,snapshot);
    const id=randomUUID(),hash=digest(now),meta=sessionMetadata(source);
    const successor=createNativeSession(selected.provider,{title:input.sessionName?.trim()||`${meta.title??'Agent session'} (continued)`,
      summary:meta.summary??`Continue ${meta.title??canonical(source.id)} on ${input.provider}.`,purpose:meta.purpose??'develop',
      cwd:meta.cwd,project:meta.project??null,additionalDirs:meta.additionalDirs,origin:'native',model:input.model??selected.model??null,
      reasoningEffort:effort??selected.reasoning_effort??undefined});
    const human=sessionInputProvenance(getAcceptedSessionInput(input.inputId)!)?.originatingHuman??null;
    db.query(`INSERT INTO session_handoffs(id,predecessor_session_id,successor_session_id,state,action_id,caller_session_id,reason,
      requesting_input_id,requesting_run_id,originating_human_json,inventory_json,inventory_digest)
      VALUES(?,?,?,'proposed',?,?,?,?,?,?,?,?)`).run(id,source.id,successor.id,input.actionId,input.actorSession,input.reason.trim(),input.inputId,input.runId,
        human?JSON.stringify(human):null,JSON.stringify(now),hash);
    const brief=`You continue ${canonical(source.id)} on ${input.provider}. The reason is: ${input.reason.trim()} Read its conversation with sessions context ${sessionAddress(source)} before acting. `+
      `Its exact open inventory and omissions follow. Do not re-ask a sent request: its answer will return to you after acceptance. `+
      `Acknowledge the current set with sessions handoff accept ${id} --digest ${hash} --source-input <this input> --source-run <this run>. `+
      `If the digest changed, read the new inventory and acknowledge that exact digest.\n\n${JSON.stringify(now,null,2)}`;
    const first=retainSessionInput({id:`handoff:${id}`,sessionId:successor.id,scope:`handoff:${id}`,actionId:'brief',kind:'input',origin:'agent',payload:{text:brief},
      sourceInputId:input.inputId,sourceRunId:input.runId}).input;
    if(topModel(input.model??selected.model))recordSessionEvent({eventId:`model-escalation:handoff:${id}`,sessionId:successor.id,
      inputId:first.id,kind:'model_escalation',payload:{model:input.model??selected.model,reason:input.reason,sourceInputId:input.inputId}});
    enqueueSessionInput(first.id);
    executionChanged();
    return {handoffId:id,successor:canonical(successor.id),address:sessionAddress(successor),inventory:now,digest:hash,state:'proposed'};
  }).immediate();
}

/** Stage a passive Astra continuation. This API is intended for the recovery engine only;
 * it derives the binding from the retained predecessor and never accepts caller model/effort. */
export async function stageRecoveryHandoff(input:{actorSession:number;inputId:string;runId:string;predecessorId:number;
  actionId:string;reason:string;selectedInputId:string;preservedSourcePath:string}) {
  const source=getSessionById(input.predecessorId);
  const selected=getAcceptedSessionInput(input.selectedInputId);
  const sourceInput=getAcceptedSessionInput(input.inputId);
  if(!source||source.status==='archived'||supersededBy(source.id)||sessionMetadata(source).suspended)
    throw new Error('The predecessor is unavailable or already excluded.');
  const metadata=sessionMetadata(source);
  if(source.provider_id!=='codex'||!isAstraModel(metadata.model)||metadata.reasoningEffort!=='medium'
    ||!source.agent_session_uuid||!selected||selected.session_id!==source.id||!sourceInput||sourceInput.session_id!==input.actorSession)
    throw new Error('Recovery staging requires the retained Astra Medium Codex binding and exact selected input.');
  if(!input.reason.trim()||!input.actionId)throw new Error('A reason and stable action ID are required.');
  await assertRecoveryResources(source.id,input.preservedSourcePath);
  const snapshot=await inventory(source.id,{inputId:input.inputId,runId:input.runId},{preservedSourcePath:input.preservedSourcePath});
  if(snapshot.omissions.length)throw new Error(`Recovery custody inventory has unresolved omissions: ${snapshot.omissions.join(' ')}`);
  await assertRecoveryResources(source.id,input.preservedSourcePath,snapshot.items);
  return db.transaction(()=>{
    const prior=db.query('SELECT * FROM session_handoffs WHERE requesting_input_id=? AND action_id=?').get(input.inputId,input.actionId) as HandoffRow|null;
    if(prior){
      if(prior.predecessor_session_id!==source.id||prior.handoff_kind!=='codex-custody-successor'||prior.canonical_input_id!==selected.id)
        throw new Error('Recovery action identity conflicts with another handoff kind, selected input or predecessor.');
      const successor=getSessionById(prior.successor_session_id);
      const linked=db.query('SELECT canonical_input_id,placement_input_id,placement_turn_id FROM codex_custody_successors WHERE handoff_id=?').get(prior.id) as any;
      if(linked&&linked.canonical_input_id!==selected.id)throw new Error('Recovery handoff is bound to a different canonical input.');
      if(!linked&&(!successor||!sessionMetadata(successor).suspended||successor.agent_session_uuid!==null
        ||db.query('SELECT 1 FROM session_inputs WHERE session_id=? LIMIT 1').get(prior.successor_session_id)
        ||db.query('SELECT 1 FROM turns WHERE session_id=? LIMIT 1').get(prior.successor_session_id)))
        throw new Error('Unlinked recovery handoff is not a passive staging successor.');
      return {
      handoffId:prior.id,successor:canonical(prior.successor_session_id),digest:prior.inventory_digest,
      inventory:JSON.parse(prior.inventory_json) as Inventory,state:prior.state,duplicate:true};}
    if(supersededBy(source.id)||pending(source.id))throw new Error('The predecessor already has a competing handoff.');
    const now=inventoryLocalWithExternal(source.id,snapshot),id=randomUUID(),hash=digest(now);
    const successor=createNativeSession('codex',{title:`${metadata.title??canonical(source.id)} (continued)`,
      summary:metadata.summary??`Continue ${metadata.title??canonical(source.id)}.`,purpose:metadata.purpose??'develop',
      cwd:metadata.cwd,project:metadata.project??null,additionalDirs:metadata.additionalDirs,origin:'native',model:metadata.model,
      reasoningEffort:metadata.reasoningEffort,providerAccount:metadata.providerAccount,providerRunner:metadata.providerRunner,
      projectName:metadata.projectName,projectPath:metadata.projectPath,suspended:true,interactionPolicy:metadata.interactionPolicy,
      nativeBinding:metadata.nativeBinding});
    const human=sessionInputProvenance(sourceInput)?.originatingHuman??null;
    db.query(`INSERT INTO session_handoffs(id,predecessor_session_id,successor_session_id,state,action_id,handoff_kind,canonical_input_id,caller_session_id,reason,
      requesting_input_id,requesting_run_id,originating_human_json,inventory_json,inventory_digest)
      VALUES(?,?,?,'proposed',?,'codex-custody-successor',?,?,?,?,?,?,?,?)`).run(id,source.id,successor.id,input.actionId,selected.id,input.actorSession,input.reason.trim(),input.inputId,input.runId,
        human?JSON.stringify(human):null,JSON.stringify(now),hash);
    executionChanged();
    return {handoffId:id,successor:canonical(successor.id),digest:hash,inventory:now,state:'proposed',duplicate:false};
  }).immediate();
}

/** Commit engine-owned recovery placement and the exact current obligation inventory together. */
export async function commitRecoveryHandoff(input:{actorSession:number;inputId:string;runId:string;handoffId:string;digest:string;
  placementInputId:string;placementTurnId:number;validateAuthority:()=>void}) {
  if(typeof input.validateAuthority!=='function')throw new Error('Recovery custody requires its current owner authority validator.');
  const proposed=row(input.handoffId);if(!proposed||proposed.handoff_kind!=='codex-custody-successor')
    throw new Error('Recovery handoff is not the exact engine-owned operation kind.');
  const relation=db.query(`SELECT canonical_input_id,predecessor_session_id,successor_session_id,placement_input_id,placement_turn_id,state,snapshot_json
    FROM codex_custody_successors WHERE handoff_id=? AND placement_input_id=? AND placement_turn_id=?`)
    .get(input.handoffId,input.placementInputId,input.placementTurnId) as any;
  if(!relation||relation.canonical_input_id!==proposed.canonical_input_id||relation.predecessor_session_id!==proposed.predecessor_session_id
    ||relation.successor_session_id!==proposed.successor_session_id||relation.state!=='staged')
    throw new Error('Recovery placement is not bound to this staged custody successor.');
  const selected=getAcceptedSessionInput(relation.canonical_input_id);
  if(!selected||selected.session_id!==proposed.predecessor_session_id)
    throw new Error('Canonical selected input changed before custody commit.');
  const snapshot=JSON.parse(relation.snapshot_json) as {path?:unknown};
  if(typeof snapshot.path!=='string')throw new Error('Recovery source path is not retained by the owner.');
  await assertRecoveryResources(proposed.predecessor_session_id,snapshot.path);
  return acceptHandoffInternal(input,{placementInputId:input.placementInputId,placementTurnId:input.placementTurnId,
    authority:RECOVERY_HANDOFF_AUTHORITY,preservedSourcePath:snapshot.path,validateAuthority:input.validateAuthority});
}

function inventoryLocalWithExternal(sessionId:number,snapshot:Inventory):Inventory {
  return {items:[...ledgerItems(sessionId),...snapshot.items.filter(item=>item.kind==='lab'||item.kind==='worktree')].sort((a,b)=>a.id.localeCompare(b.id)),omissions:snapshot.omissions,
    ...(snapshot.dispositions?.length?{dispositions:snapshot.dispositions}:{})};
}

export async function acceptHandoff(input:{actorSession:number;inputId:string;runId:string;handoffId:string;digest:string}) {
  return acceptHandoffInternal(input,null);
}

async function acceptHandoffInternal(input:{actorSession:number;inputId:string;runId:string;handoffId:string;digest:string},
  recovery:{placementInputId:string;placementTurnId:number;authority:symbol;preservedSourcePath:string;validateAuthority:()=>void}|null) {
  const proposed=row(input.handoffId);if(!proposed)throw new Error('Unknown handoff.');
  if(recovery?.authority!==RECOVERY_HANDOFF_AUTHORITY&&proposed.successor_session_id!==input.actorSession)
    throw new Error('Only the successor’s live run may accept this handoff.');
  if(proposed.state==='accepted'){
    if(input.digest!==proposed.inventory_digest)throw new Error('This handoff was already accepted with a different inventory digest.');
    return {accepted:true,duplicate:true,handoffId:proposed.id,predecessor:canonical(proposed.predecessor_session_id),
      successor:canonical(proposed.successor_session_id),inventory:JSON.parse(proposed.inventory_json),digest:proposed.inventory_digest};
  }
  if(proposed.state!=='proposed')throw new Error('This handoff is not proposed.');
  assertInboxMove(getSessionById(proposed.predecessor_session_id)!,{id:proposed.successor_session_id,
    provider:getSessionById(proposed.successor_session_id)!.provider_id},proposed.requesting_input_id);
  const observed=await inventory(proposed.predecessor_session_id,{inputId:input.inputId,runId:input.runId},recovery?{preservedSourcePath:recovery.preservedSourcePath}:undefined);
  const current=inventoryLocalWithExternal(proposed.predecessor_session_id,observed),currentDigest=digest(current);
  if(recovery)await assertRecoveryResources(proposed.predecessor_session_id,recovery.preservedSourcePath,current.items);
  if(recovery&&current.omissions.length)
    throw new Error(`Recovery custody inventory has unresolved omissions: ${current.omissions.join(' ')}`);
  if(input.digest!==currentDigest) return {accepted:false,handoffId:input.handoffId,inventory:current,digest:currentDigest,reason:'Inventory changed; acknowledge this exact digest.'};
  const movableNow=new Set(current.items.filter(item=>item.kind==='queued'&&item.movable).map(item=>item.ref));
  if(current.items.some(item=>item.kind==='answer'&&item.answerEventId&&!item.answerReturnInputId
    &&!answerReturnTravels(item.answerEventId,movableNow)))
    return {accepted:false,handoffId:input.handoffId,inventory:current,digest:currentDigest,reason:'A ChatGPT answer has not reached its asking session yet. Let the exact return receipt settle before handing off its duty.'};
  if(current.items.some(item=>item.kind==='queued'&&!item.movable&&!item.obsolete))
    return {accepted:false,handoffId:input.handoffId,inventory:current,digest:currentDigest,reason:'A queued input may have reached its provider or has dependencies. Let its exact outcome settle before accepting ownership.'};
  const result=db.transaction(()=>{
    recovery?.validateAuthority();
    const state=row(input.handoffId);if(!state||state.state!=='proposed')throw new Error('This handoff changed while it was being accepted.');
    const verified=inventoryLocalWithExternal(state.predecessor_session_id,current),verifiedDigest=digest(verified);
    if(verifiedDigest!==input.digest)return {accepted:false,handoffId:input.handoffId,inventory:verified,digest:verifiedDigest,reason:'Ledger obligations changed; acknowledge this exact digest.'};
    const from=state.predecessor_session_id,to=state.successor_session_id;
    const moved:{kind:string;ref:string}[]=[];
    const record=(kind:string,ref:string)=>{db.query('INSERT INTO session_handoff_items(handoff_id,kind,ref,from_session_id,to_session_id) VALUES(?,?,?,?,?)').run(state.id,kind,ref,from,to);moved.push({kind,ref});};
    const successorInputId=recovery?.placementInputId??`handoff:${state.id}`;
    const successorTurnId=recovery?.placementTurnId??getAcceptedSessionInput(successorInputId)?.turn_id;
    if(!successorTurnId)throw new Error('Successor handoff brief was not queued.');
    if(recovery){
      const placement=getAcceptedSessionInput(successorInputId);
      const turn=db.query(`SELECT id,session_id,accepted_input_id,status,owner_instance_id,provider_admission_intended_at,
        provider_started_at,provider_turn_id,provider_input_acknowledged_at FROM turns WHERE id=?`).get(successorTurnId) as any;
      if(!placement||placement.session_id!==state.successor_session_id||placement.turn_id!==successorTurnId
        ||!turn||turn.session_id!==state.successor_session_id||turn.accepted_input_id!==successorInputId
        ||turn.status!=='queued'||turn.owner_instance_id!==null||turn.provider_admission_intended_at!==null
        ||turn.provider_started_at!==null||turn.provider_turn_id!==null||turn.provider_input_acknowledged_at!==null)
        throw new Error('Recovery placement is not an unstarted exact queued turn on the staged successor.');
      const running=db.query("SELECT 1 FROM turns WHERE session_id=? AND status IN ('running','delivering') LIMIT 1")
        .get(state.predecessor_session_id);
      const execution=db.query("SELECT 1 FROM executions WHERE session_id=? AND state IN ('intended','live','exited') LIMIT 1")
        .get(state.predecessor_session_id);
      const ambiguous=db.query(`SELECT 1 FROM turn_steering_messages steering JOIN turns turn ON turn.id=steering.turn_id
        WHERE turn.session_id=? AND steering.status IN ('sending','ambiguous') LIMIT 1`).get(state.predecessor_session_id);
      const predecessor=getSessionById(state.predecessor_session_id);
      if(running||execution||ambiguous||!predecessor||sessionMetadata(predecessor).suspended||predecessor.status==='archived')
        throw new Error('Predecessor exclusion is not established; custody cannot commit.');
    }
    const movable=new Set(verified.items.filter(item=>item.kind==='queued'&&item.movable).map(item=>item.ref));
    // A ChatGPT answer duty moves its own active request with it, so its sent request must move
    // first; inventory order (answer:… sorts before sent:…) refused every handoff holding both
    // (concierge:9767 → 9847, 2026-11-16).
    // Read before any queued item moves: moving it re-points the answer event at the successor's copy.
    const travellingAnswers=new Set(verified.items.filter(item=>item.kind==='answer'&&item.answerEventId&&!item.answerReturnInputId
      &&answerReturnTravels(item.answerEventId,movable)).map(item=>item.ref));
    const transferOrder=[...verified.items].sort((a,b)=>Number(a.kind==='answer')-Number(b.kind==='answer'));
    for(const item of transferOrder){
      if(item.kind==='sent'){
        const table=db.query('SELECT 1 FROM session_communication_requests WHERE request_id=?').get(item.ref)?'session_communication_requests':'session_peer_requests';
        const changed=db.query(`UPDATE ${table} SET source_session_id=? WHERE request_id=? AND source_session_id=? AND ${item.pendingReturn?'outcome IS NOT NULL':'outcome IS NULL'}`).run(to,item.ref,from);
        if(changed.changes!==1)throw new Error(`Sent request ${item.ref} changed during handoff.`);
        // An unstarted return input carries its exact ID to the successor; delivery then dispatches it there.
        // A queued one moves with its queued item below.
        // One answer can carry several requests through a single return input; it moves once.
        if(item.pendingReturn)for(const pendingReturn of pendingReturnInputs(item.ref)){
          if(pendingReturn.state==='delivered')throw new Error(`The return for ${item.ref} reached the predecessor during handoff.`);
          if(pendingReturn.state==='unstarted'&&db.query(`UPDATE session_inputs SET session_id=?,updated_at=CURRENT_TIMESTAMP
            WHERE id=? AND session_id<>? AND turn_id IS NULL AND steering_id IS NULL`).run(to,pendingReturn.inputId,to).changes!==1
            &&getAcceptedSessionInput(pendingReturn.inputId!)?.session_id!==to)
            throw new Error(`The return input for ${item.ref} changed during handoff.`);
        }
        record(item.kind,item.ref);
      }else if(item.kind==='answer'){
        if(!transferChatGptAnswerOwnership(item.ref,from,to,Date.now(),travellingAnswers.has(item.ref)))
          throw new Error(`ChatGPT answer ${item.ref} changed during handoff.`);
        record(item.kind,item.ref);
      }else if(item.kind==='owed'){
        const table=item.source==='peer'?'session_peer_deliveries':item.source==='outside'?'session_external_requests':'session_communication_requests';
        const open=table==='session_peer_deliveries'?'closed_at_ms IS NULL':'outcome IS NULL';
        const movesInput=movable.has(String(item.targetInputId));
        const changed=table==='session_communication_requests'
          ?db.query(`UPDATE ${table} SET target_session_id=?,target_input_id=?,target_turn_id=? WHERE request_id=? AND target_session_id=? AND ${open}`)
            .run(to,movesInput?item.targetInputId:successorInputId,movesInput?item.turnId??null:successorTurnId,item.ref,from)
          :table==='session_external_requests'
          // Each outside request owns a unique accepted input. Keep that custody key until
          // its exact queued input is cloned below; many requests cannot share the brief ID.
          ?db.query(`UPDATE ${table} SET target_session_id=? WHERE request_id=? AND target_session_id=? AND ${open} AND target_input_id=?`)
            .run(to,item.ref,from,item.targetInputId)
          :db.query(`UPDATE ${table} SET target_session_id=?,target_input_id=? WHERE request_id=? AND target_session_id=? AND ${open}`)
            .run(to,movesInput?item.targetInputId:successorInputId,item.ref,from);
        if(changed.changes!==1)throw new Error(`Owed request ${item.ref} changed during handoff.`);record(item.kind,item.ref);
      }else if(item.kind==='queued'&&item.obsolete){
        const original=getAcceptedSessionInput(item.ref);
        const turn=original?.turn_id?db.query('SELECT status,accepted_input_id FROM turns WHERE id=?').get(original.turn_id) as {status:string;accepted_input_id:string}|null:null;
        if(!original||!turn||turn.status!=='queued'||turn.accepted_input_id!==original.id||!obsoleteQueuedTurn(original))
          throw new Error(`Obsolete queued item ${item.ref} changed during handoff.`);
        // The request has its own final receipt. This reminder has no remaining work to transfer.
        // Retire its exact queued turn; never submit its words to another provider.
        const isContinuation=original.scope==='turn-continuation'||original.id.startsWith('turn-continuation:');
        finishTurn(original.turn_id!,'cancelled',isContinuation?'Continuation superseded by handoff.':'The exact Inbox request closed before this reminder ran.');
        settleTurnDependencies(original.turn_id!);
        db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
          .run(JSON.stringify({state:'canceled',reason:isContinuation?'continuation_superseded':'inbox_request_closed'}),original.id);
      }else if(item.kind==='queued'&&item.movable){
        const original=getAcceptedSessionInput(item.ref)!;
        const turn=db.query(`SELECT id,session_id,accepted_input_id,status,dispatch_attempt,dispatch_hold,provider_admission_intended_at,
          provider_started_at,provider_turn_id,provider_input_acknowledged_at,saved_kind FROM turns WHERE id=?`).get(original.turn_id) as WaitingTurn|null;
        if(!turn||!movableQueuedTurn(turn,original))throw new Error(`Queued input ${item.ref} is no longer safe to move.`);
        if(turn.saved_kind==='scheduled'){
          const successor=sessionMetadata(getSessionById(to)!);
          const movedTurn=db.query(`UPDATE turns SET session_id=?,provider_model=?,reasoning_effort=?
            WHERE id=? AND session_id=? AND status='queued' AND saved_kind='scheduled' AND accepted_input_id=?`)
            .run(to,successor.model??null,successor.reasoningEffort??null,turn.id,from,original.id);
          const movedInput=db.query(`UPDATE session_inputs SET session_id=?,updated_at=CURRENT_TIMESTAMP
            WHERE id=? AND session_id=? AND turn_id=?`).run(to,original.id,from,turn.id);
          if(movedTurn.changes!==1||movedInput.changes!==1)throw new Error(`Scheduled input ${item.ref} changed during handoff.`);
          db.query(`UPDATE session_communication_requests SET target_turn_id=?
            WHERE target_input_id=? AND target_session_id=? AND outcome IS NULL`).run(turn.id,original.id,to);
          record(item.kind,item.ref);
          continue;
        }
        finishTurn(turn.id,'cancelled','Continued in another agent session.');
        settleTurnDependencies(turn.id);
        const originalPayload=JSON.parse(original.payload_json);
        const cloned=retainSessionInput({id:`handoff-input:${state.id}:${original.id}`,sessionId:to,scope:`handoff:${state.id}`,actionId:original.id,
          kind:'input',origin:original.origin,payload:original.kind==='create'?originalPayload.firstInput:originalPayload,
          ...(original.source_input_id?{sourceInputId:original.source_input_id}:{}),
          ...(original.source_run_id?{sourceRunId:original.source_run_id}:{}),
          ...(original.request_id?{requestId:original.request_id}:{})}).input;
        const moved=enqueueSessionInput(cloned.id);
        if(moved.turn_id===null)throw new Error(`Queued input ${item.ref} could not be admitted on the successor.`);
        db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
          .run(JSON.stringify({state:'canceled',movedTo:canonical(to),continuedAs:cloned.id}),original.id);
        db.query('UPDATE session_communication_requests SET target_input_id=?,target_turn_id=? WHERE target_input_id=? AND target_session_id=? AND outcome IS NULL')
          .run(cloned.id,moved.turn_id,item.ref,to);
        db.query('UPDATE session_external_requests SET target_input_id=? WHERE target_input_id=? AND target_session_id=? AND outcome IS NULL')
          .run(cloned.id,item.ref,to);
        // A queued return now travels as the clone; its delivery state follows that exact input.
        for(const events of ['session_communication_events','session_peer_events'])
          db.query(`UPDATE ${events} SET accepted_input_id=? WHERE accepted_input_id=? AND status NOT IN ('received','retained')`)
            .run(cloned.id,item.ref);
        record(item.kind,item.ref);
      }else if(item.kind==='watch'){
        const changed=db.query("UPDATE watches SET session_id=? WHERE watch_id=? AND session_id=? AND (state IN ('accepted','observing') OR delivery_state='pending')").run(to,item.ref,from);
        if(changed.changes!==1)throw new Error(`Watch ${item.ref} changed during handoff.`);record(item.kind,item.ref);
      }
    }
    // Lab records and worktrees are referenced. Their authorship and bytes stay where they are.
    for(const item of verified.items.filter(item=>item.kind==='lab'||item.kind==='worktree'))record(item.kind,item.ref);
    if(recovery){
      const custody=db.query(`UPDATE codex_custody_successors SET state='custody'
        WHERE handoff_id=? AND predecessor_session_id=? AND successor_session_id=? AND placement_input_id=?
          AND placement_turn_id=? AND state='staged'`).run(state.id,from,to,successorInputId,successorTurnId);
      if(custody.changes!==1)throw new Error('Recovery custody reservation changed during transfer.');
    }
    db.query("UPDATE session_handoffs SET state='accepted',accepted_at=CURRENT_TIMESTAMP,inventory_json=?,inventory_digest=? WHERE id=?")
      .run(JSON.stringify(verified),verifiedDigest,state.id);
    // The Inbox is one logical router across provider sessions. Promote its role only
    // after acceptance, so a proposed successor cannot receive captures prematurely.
    const predecessorMeta=sessionMetadata(getSessionById(from)!);
    if(predecessorMeta.inboxRole==='project-router'||predecessorMeta.standingRole==='inbox'){
      assertInboxMove(getSessionById(from)!,{provider:getSessionById(to)!.provider_id},state.requesting_input_id);
      takeInboxRouterRole(to,predecessorMeta,state.requesting_input_id);
    }
    // Any other standing role (journal keeper, repair agent, …) follows the work the same way. Left
    // on the superseded predecessor, the role kept receiving saved journal entries and check-ins
    // after concierge:4571 → 9752 (2026-11-15), and no turn ever ran them.
    else if(typeof predecessorMeta.standingRole==='string'&&predecessorMeta.standingRole){
      db.query(`UPDATE sessions SET native_metadata_json=json_remove(native_metadata_json,'$.standingRole') WHERE id=?`).run(from);
      updateSessionMetadata(to,{standingRole:predecessorMeta.standingRole});
    }
    // The repair agent's marker (its purpose text and repair-notice delivery) follows the role too.
    if(predecessorMeta.repairAgent)updateSessionMetadata(to,{repairAgent:true});
    // Suspension prevents the next turn. It does not interrupt an already admitted run;
    // that run receives a direct notice after this transaction commits.
    updateSessionMetadata(from,{suspended:true});
    executionChanged();
    return {accepted:true,handoffId:state.id,predecessor:canonical(from),successor:canonical(to),moved,inventory:verified,digest:verifiedDigest};
  }).immediate();
  return result;
}

/** Withdrawal revokes future execution, never an earlier provider attempt's evidence. */
function settleWithdrawnSuccessor(current:HandoffRow):number {
  updateSessionMetadata(current.successor_session_id,{suspended:true});
  const queued=db.query(`SELECT turn.*,input.receipt_json,input.id AS input_id,
    (EXISTS (SELECT 1 FROM turn_steering_messages WHERE turn_id=turn.id AND status IN ('sent','sending','ambiguous'))
      OR EXISTS (SELECT 1 FROM turn_artifact_deliveries WHERE turn_id=turn.id)
      OR EXISTS (SELECT 1 FROM turn_artifact_batches WHERE turn_id=turn.id AND status<>'collecting')) AS effect_possible
    FROM turns turn LEFT JOIN session_inputs input ON input.id=turn.accepted_input_id
    WHERE turn.session_id=? AND turn.status='queued' ORDER BY turn.id`).all(current.successor_session_id) as any[];
  const reason='The proposed handoff was withdrawn; this successor will not resume the waiting work.';
  for(const turn of queued){
    const prior=JSON.parse(turn.receipt_json??'{}');
    const uncertain=!!(turn.provider_admission_intended_at||turn.provider_started_at||turn.provider_turn_id
      ||turn.provider_input_acknowledged_at||turn.effect_possible||prior.state==='uncertain');
    finishTurn(turn.id,'cancelled',reason);
    db.query(`UPDATE turns SET dispatch_hold=NULL,dispatch_failure_class=NULL,dispatch_next_attempt_ms=NULL WHERE id=?`).run(turn.id);
    settleTurnDependencies(turn.id);
    const provider=getSessionById(current.successor_session_id)?.provider_id;
    if(provider&&['codex','claude-code','antigravity'].includes(provider))
      resolveUsageHoldNoticesForSettledTurn(provider as UsageProvider,turn.id,'request_withdrawn');
    if(turn.input_id)db.query(`UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(JSON.stringify({...prior,state:uncertain?'uncertain':'canceled',reason:'handoff_withdrawn',
        handoffId:current.id,turnId:turn.id,cancellationDetail:reason,
        ...(uncertain?{error:{code:'HANDOFF_WITHDRAWN_WITH_PRIOR_PROVIDER_ATTEMPT',
          message:'Future execution was withdrawn; an earlier provider attempt may have taken effect.'}}:{})}),turn.input_id);
    recordSessionEvent({eventId:`handoff-withdrawn:${current.id}:turn:${turn.id}`,sessionId:current.successor_session_id,
      turnId:turn.id,...(turn.input_id?{inputId:turn.input_id}:{}),kind:'handoff_withdrawn',
      payload:{handoffId:current.id,reason,couldHaveReachedProvider:uncertain}});
  }
  return queued.length;
}

/** The normal owner startup repairs old withdrawals, using the same transition as new ones. */
export function reconcileWithdrawnHandoffQueues():number {
  return db.transaction(()=>{
    const withdrawn=db.query(`SELECT handoff.* FROM session_handoffs handoff WHERE handoff.state='withdrawn'
      AND EXISTS (SELECT 1 FROM turns WHERE session_id=handoff.successor_session_id AND status='queued')`).all() as HandoffRow[];
    let settled=0;
    for(const current of withdrawn)settled+=settleWithdrawnSuccessor(current);
    if(settled)executionChanged();
    return settled;
  }).immediate();
}

export function withdrawHandoff(input:{actorSession:number;handoffId:string}) {
  return db.transaction(()=>{
    const current=row(input.handoffId);if(!current||current.state!=='proposed')throw new Error('This handoff is not proposed.');
    if(input.actorSession!==current.caller_session_id&&input.actorSession!==current.predecessor_session_id)
      throw new Error('Only the proposing caller or predecessor may withdraw this handoff.');
    if(current.handoff_kind==='codex-custody-successor'
      &&db.query('SELECT 1 FROM codex_custody_successors WHERE handoff_id=?').get(current.id))
      throw new Error('This canonical recovery owns a retained native cutoff. Pause or Stop its work; ordinary handoff withdrawal cannot release that custody reservation.');
    db.query("UPDATE session_handoffs SET state='withdrawn',withdrawn_at=CURRENT_TIMESTAMP WHERE id=? AND state='proposed'").run(current.id);
    settleWithdrawnSuccessor(current);
    executionChanged();return {withdrawn:true,handoffId:current.id,predecessor:canonical(current.predecessor_session_id)};
  }).immediate();
}
