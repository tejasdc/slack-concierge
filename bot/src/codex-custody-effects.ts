import {CodexAppServerClientError,type CodexAppServerClientLike} from './codex-app-server-client';
import {db,getSessionById} from './state';
import type {CodexLeftoverProcess} from './codex-leftover-processes';

export type CustodyPredecessorEffectsReceipt={
  format:'codex-custody-predecessor-effects-v1';
  sessionId:number;
  threadId:string;
  selectedTurnId:number;
  threadStatus:'idle'|'notLoaded';
  queuedSubmissionIds:string[];
  goal:{status:'absent'|'complete'|'feature-disabled';objective?:string};
  backgroundTerminals:{status:'observed'|'thread-not-loaded';ids:string[]};
  currentProcesses:CodexLeftoverProcess[];
  owner:{activeExecutions:0;unresolvedTurnIds:number[];recheckedProcessSightingTurnIds:number[];unsettledProcessSightingTurnIds:number[]};
};

const refuse=(message:string):never=>{throw new Error(`Predecessor effect reconciliation refused: ${message}`);};
function exactNativeRefusal(error:unknown,method:string,detail:string){
  return error instanceof CodexAppServerClientError&&error.code===-32600
    &&error.message===`Codex app-server ${method} failed: ${detail}`;
}

async function allPages(client:CodexAppServerClientLike,method:string,threadId:string):Promise<any[]> {
  const rows:any[]=[],seen=new Set<string>();let cursor:string|null=null;
  do {
    const page=await client.request(method,{threadId,cursor,limit:100});
    if(!page||!Array.isArray(page.data)||!(page.nextCursor===null||typeof page.nextCursor==='string'))
      refuse(`${method} returned no complete data page.`);
    rows.push(...page.data);
    const next=page.nextCursor;
    if(next!==null&&(!next||seen.has(next)))refuse(`${method} returned an invalid or repeated pagination cursor.`);
    if(next)seen.add(next);
    cursor=next;
  }while(cursor!==null);
  return rows;
}

function ownerFacts(sessionId:number,selectedTurnId:number,threadId:string,current:CodexLeftoverProcess[]) {
  const selected=db.query('SELECT session_id,status FROM turns WHERE id=?').get(selectedTurnId) as {session_id:number;status:string}|null;
  if(!selected||selected.session_id!==sessionId||!['done','error','cancelled','parked'].includes(selected.status))
    refuse('the selected owner turn is missing, belongs to another session, or is not terminal.');
  const unresolved=db.query(`SELECT id FROM turns WHERE session_id=? AND status IN ('running','delivering') ORDER BY id`)
    .all(sessionId) as {id:number}[];
  if(unresolved.length)refuse(`owner turns remain unresolved (${unresolved.map(row=>row.id).join(', ')}).`);
  const steering=db.query(`SELECT s.id FROM turn_steering_messages s JOIN turns t ON t.id=s.turn_id
    WHERE t.session_id=? AND s.status IN ('sending','ambiguous') ORDER BY s.id`).all(sessionId) as {id:number}[];
  if(steering.length)refuse(`owner steering effects remain unresolved (${steering.map(row=>row.id).join(', ')}).`);
  const lifecycle=db.query(`SELECT json_extract(native_metadata_json,'$.codexLifecycle.state') AS state FROM sessions WHERE id=?`)
    .get(sessionId) as {state:string|null}|null;
  if(lifecycle?.state==='running'||lifecycle?.state==='uncertain')refuse(`owner Codex lifecycle remains ${lifecycle.state}.`);
  const activeExecutions=db.query(`SELECT execution_id FROM executions WHERE session_id=? AND state IN ('intended','live','exited')`)
    .all(sessionId) as {execution_id:string}[];
  if(activeExecutions.length)refuse(`owner execution records remain active (${activeExecutions.map(row=>row.execution_id).join(', ')}).`);

  const sightings=db.query(`SELECT turn_id,payload_json FROM session_owner_events
    WHERE session_id=? AND kind='process_audit' AND event_id>='codex-process-sighting:' AND event_id<'codex-process-sighting;'
    ORDER BY turn_id`).all(sessionId) as {turn_id:number;payload_json:string}[];
  const pending:number[]=[];
  const rechecked:number[]=[];
  const currentKeys=new Set(current.map(processKey));
  for(const sighting of sightings){
    let payload:any;try{payload=JSON.parse(sighting.payload_json);}catch{refuse(`process sighting for turn ${sighting.turn_id} is malformed.`);}
    if(payload?.threadId!==threadId||!Array.isArray(payload?.processes))
      refuse(`process sighting for turn ${sighting.turn_id} is not bound to the exact predecessor thread.`);
    const settled=db.query(`SELECT payload_json FROM session_owner_events WHERE event_id=? AND session_id=? AND turn_id=? AND kind='process_audit'`)
      .get(`codex-process-sighting-settled:${sighting.turn_id}`,sessionId,sighting.turn_id) as {payload_json:string}|null;
    let settledOutcome:string|undefined;
    if(settled){try{settledOutcome=JSON.parse(settled.payload_json)?.outcome;}catch{refuse('a process sighting settlement is malformed.');}}
    if(settledOutcome&&settledOutcome!=='exited')refuse('a prior process sighting has an unknown settlement outcome.');
    if(payload.processes.some((row:unknown)=>!validProcess(row)))refuse(`process sighting for turn ${sighting.turn_id} has unknown process identity.`);
    const stillPresent=(payload.processes as CodexLeftoverProcess[]).some(row=>currentKeys.has(processKey(row)));
    rechecked.push(sighting.turn_id);
    if(stillPresent)pending.push(sighting.turn_id);
  }
  if(current.length)refuse(`fresh owner process observation found ${current.length} process(es) attached to this native thread.`);
  if(pending.length)refuse(`fresh owner process observation still contains previously sighted process identities (turns ${pending.join(', ')}).`);
  return {activeExecutions:0 as const,unresolvedTurnIds:unresolved.map(row=>row.id),recheckedProcessSightingTurnIds:rechecked,
    unsettledProcessSightingTurnIds:pending};
}

function validProcess(value:unknown):value is CodexLeftoverProcess {
  if(!value||typeof value!=='object')return false;
  const row=value as Partial<CodexLeftoverProcess>;
  return Number.isSafeInteger(row.pid)&&typeof row.name==='string'&&typeof row.startTicks==='string'
    &&/^\d+$/.test(row.startTicks)&&typeof row.cgroup==='string';
}
const processKey=(row:CodexLeftoverProcess)=>`${row.pid}:${row.startTicks}`;

/** Reconcile post-cutoff effects for one exact predecessor. Process evidence is freshly
 * obtained by the execution host; this receipt is not a transport cutoff or writer-exclusion proof. */
export async function reconcileCodexCustodyPredecessorEffects(client:CodexAppServerClientLike,
  input:{predecessorSessionId:number;threadId:string;selectedTurnId:number},
  observeProcesses:(threadId:string)=>Promise<CodexLeftoverProcess[]>):Promise<CustodyPredecessorEffectsReceipt>{
  const session=getSessionById(input.predecessorSessionId);
  if(!session||session.provider_id!=='codex'||session.agent_session_uuid!==input.threadId)
    refuse('the predecessor no longer has the exact retained Codex thread binding.');

  const read=await client.request('thread/read',{threadId:input.threadId,includeTurns:false});
  const thread=read?.thread;
  if(!thread||thread.id!==input.threadId||!thread.status||typeof thread.status!=='object'||typeof thread.status.type!=='string')
    refuse('thread/read did not return the exact thread and pinned status shape.');
  const status=thread.status.type;
  if(status!=='idle'&&status!=='notLoaded')refuse(`thread/read reports ${status}; the predecessor is not known idle.`);

  const queue=await allPages(client,'thread/queue/list',input.threadId);
  const queuedSubmissionIds:string[]=[];
  for(const item of queue){
    if(typeof item?.id!=='string'||!item.id||!Array.isArray(item.input)||typeof item.clientUserMessageId!=='string')
      refuse('thread/queue/list returned an unknown queued-submission shape.');
    queuedSubmissionIds.push(item.id);
  }
  if(queuedSubmissionIds.length)refuse(`native queue has ${queuedSubmissionIds.length} retained submission(s).`);

  let goalResponse:any,goalFeatureDisabled=false;
  try{goalResponse=await client.request('thread/goal/get',{threadId:input.threadId});}
  catch(error){
    if(!exactNativeRefusal(error,'thread/goal/get','goals feature is disabled'))throw error;
    if(status!=='notLoaded')refuse('goal inspection is disabled for a resident thread; its retained goal needs a supported disposition.');
    goalFeatureDisabled=true;goalResponse={goal:null};
  }
  if(!goalResponse||!Object.prototype.hasOwnProperty.call(goalResponse,'goal'))refuse('thread/goal/get returned an unknown response shape.');
  const nativeGoal=goalResponse.goal;
  let goal:CustodyPredecessorEffectsReceipt['goal'];
  if(goalFeatureDisabled)goal={status:'feature-disabled'};
  else if(nativeGoal===null)goal={status:'absent'};
  else if(nativeGoal&&nativeGoal.threadId===input.threadId&&typeof nativeGoal.objective==='string'
    &&typeof nativeGoal.status==='string'&&Number.isSafeInteger(nativeGoal.tokensUsed)&&Number.isSafeInteger(nativeGoal.timeUsedSeconds)){
    if(nativeGoal.status!=='complete')refuse(`native goal remains ${nativeGoal.status}.`);
    goal={status:'complete',objective:nativeGoal.objective};
  }else refuse('thread/goal/get returned an unknown goal shape.');

  let terminals:any[],backgroundStatus:'observed'|'thread-not-loaded'='observed';
  try{terminals=await allPages(client,'thread/backgroundTerminals/list',input.threadId);}
  catch(error){
    const detail=`thread not found: ${input.threadId}`;
    if(status!=='notLoaded'||!exactNativeRefusal(error,'thread/backgroundTerminals/list',detail))throw error;
    // In the pinned server this list loads the CodexThread through ThreadManager and returns
    // this exact invalid-request error when the recorded thread is not currently loaded.
    // Current process observation below remains mandatory before accepting this disposition.
    terminals=[];backgroundStatus='thread-not-loaded';
  }
  const backgroundTerminalIds:string[]=[];
  for(const terminal of terminals){
    if(typeof terminal?.itemId!=='string'||!terminal.itemId||typeof terminal.processId!=='string'||!terminal.processId
      ||typeof terminal.command!=='string'||typeof terminal.cwd!=='string')refuse('background-terminal response has an unknown shape.');
    backgroundTerminalIds.push(terminal.itemId);
  }
  if(backgroundTerminalIds.length)refuse(`native thread has ${backgroundTerminalIds.length} background terminal process(es).`);

  const current=await observeProcesses(input.threadId);
  if(!Array.isArray(current)||current.some(row=>!validProcess(row)))refuse('fresh owner process observation returned an unknown result shape.');
  const owner=ownerFacts(input.predecessorSessionId,input.selectedTurnId,input.threadId,current);
  return {format:'codex-custody-predecessor-effects-v1',sessionId:input.predecessorSessionId,threadId:input.threadId,
    selectedTurnId:input.selectedTurnId,threadStatus:status as 'idle'|'notLoaded',queuedSubmissionIds,goal,
    backgroundTerminals:{status:backgroundStatus,ids:backgroundTerminalIds},currentProcesses:current,owner};
}
