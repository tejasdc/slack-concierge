import {createHash,randomUUID} from 'node:crypto';
import {readFile,readdir,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {db,executionChanged,finishTurn,getSessionById,settleTurnDependencies} from './state';
import {createNativeSession,enqueueSessionInput,getAcceptedSessionInput,nativeRunId,retainSessionInput,sessionInputProvenance,sessionMetadata,stablePayload,updateSessionMetadata} from './session-inputs';
import {safeTurn,type WaitingTurn} from './provider-exhaustion-recovery';
import {parseProviderSelector,resolveProviderSelector,normalizeReasoningEffort} from './aliases';
import {sessionAddress} from './session-address';
import {claudeConfigDir,locateClaudeTranscript} from './claude-transcript-watch';

const run=promisify(execFile);
type Item={id:string;kind:'sent'|'owed'|'queued'|'watch'|'lab'|'worktree';ref:string;holder:string;[key:string]:unknown};
type Inventory={items:Item[];omissions:string[]};
type HandoffRow={id:string;predecessor_session_id:number;successor_session_id:number;state:string;action_id:string;caller_session_id:number;requesting_input_id:string;inventory_json:string;inventory_digest:string};
const digest=(value:Inventory)=>createHash('sha256').update(stablePayload(value)).digest('hex');
const canonical=(id:number)=>`concierge:${id}`;
const row=(id:string)=>db.query('SELECT * FROM session_handoffs WHERE id=?').get(id) as HandoffRow|null;
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
      doNotRedispatch:!!turn?.provider_input_acknowledged_at||!!turn?.provider_turn_id||target?.provider_id==='chatgpt'});
  }
  for(const request of db.query('SELECT request_id,peer,remote_session_id,status FROM session_peer_requests WHERE source_session_id=? AND outcome IS NULL ORDER BY created_at_ms,request_id').all(sessionId) as any[])
    items.push({id:`sent:${request.request_id}`,kind:'sent',ref:request.request_id,holder,target:`${request.peer}:${request.remote_session_id}`,status:request.status,doNotRedispatch:true});
  for(const [table,kind] of [['session_communication_requests','local'],['session_peer_deliveries','peer'],['session_external_requests','outside']] as const){
    const where=table==='session_peer_deliveries'?'closed_at_ms IS NULL':'outcome IS NULL';
    for(const request of db.query(`SELECT request_id,target_input_id FROM ${table} WHERE target_session_id=? AND ${where} ORDER BY rowid`).all(sessionId) as any[])
      items.push({id:`owed:${request.request_id}`,kind:'owed',ref:request.request_id,holder,source:kind,targetInputId:request.target_input_id});
  }
  for(const input of db.query(`SELECT i.id AS input_id,i.turn_id,t.* FROM session_inputs i JOIN turns t ON t.id=i.turn_id
    WHERE i.session_id=? AND t.session_id=? AND t.status='queued' AND t.accepted_input_id=i.id ORDER BY t.id`).all(sessionId,sessionId) as any[]){
    // A request's target input is already represented by its owed item; it is still a queued
    // execution and is shown here so the successor can see whether it is safe to move.
    items.push({id:`queued:${input.input_id}`,kind:'queued',ref:input.input_id,holder,turnId:input.turn_id,movable:safeTurn(input as WaitingTurn,getAcceptedSessionInput(input.input_id)!)});
  }
  for(const watch of db.query("SELECT watch_id,state FROM watches WHERE session_id=? AND (state IN ('accepted','observing') OR delivery_state='pending') ORDER BY created_at_ms,watch_id").all(sessionId) as any[])
    items.push({id:`watch:${watch.watch_id}`,kind:'watch',ref:watch.watch_id,holder,state:watch.state});
  return items;
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

async function inventory(sessionId:number,source:{inputId:string;runId:string}):Promise<Inventory> {
  const [lab,git]=await Promise.all([labItems(sessionId,source),worktrees(sessionId)]);
  return {items:[...ledgerItems(sessionId),...lab.items,...git.items].sort((a,b)=>a.id.localeCompare(b.id)),omissions:[...lab.omissions,...git.omissions].sort()};
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
  if(selected.provider==='chatgpt')throw new Error('ChatGPT cannot acknowledge a handoff.');
  const effort=input.effort?normalizeReasoningEffort(input.effort):selector.effort;
  if(input.effort&&!effort)throw new Error('Invalid reasoning effort.');
  if(input.actorSession!==source.id&&!db.query('SELECT 1 FROM session_communication_requests WHERE source_session_id=? AND target_session_id=? AND outcome IS NULL LIMIT 1').get(input.actorSession,source.id))
    throw new Error('Only the predecessor or an open requester to it may propose this handoff.');
  if(!input.reason?.trim()||!input.actionId)throw new Error('A reason and stable action ID are required.');
  const snapshot=await inventory(source.id,{inputId:input.inputId,runId:input.runId});
  return db.transaction(()=>{
    const prior=db.query('SELECT * FROM session_handoffs WHERE requesting_input_id=? AND action_id=?').get(input.inputId,input.actionId) as HandoffRow|null;
    if(prior){if(prior.predecessor_session_id!==source.id)throw new Error('Handoff action identity conflicts with another predecessor.');return {handoffId:prior.id,successor:canonical(prior.successor_session_id),inventory:JSON.parse(prior.inventory_json),digest:prior.inventory_digest,state:prior.state,duplicate:true};}
    if(supersededBy(source.id))throw new Error('The predecessor was superseded while preparing handoff.');
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
    const brief=`You continue ${canonical(source.id)} on ${input.provider}. Read its conversation with sessions context ${sessionAddress(source)} before acting. `+
      `Its exact open inventory and omissions follow. Do not re-ask a sent request: its answer will return to you after acceptance. `+
      `Acknowledge the current set with sessions handoff accept ${id} --digest ${hash} --source-input <this input> --source-run <this run>. `+
      `If the digest changed, read the new inventory and acknowledge that exact digest.\n\n${JSON.stringify(now,null,2)}`;
    const first=retainSessionInput({id:`handoff:${id}`,sessionId:successor.id,scope:`handoff:${id}`,actionId:'brief',kind:'input',origin:'agent',payload:{text:brief},
      sourceInputId:input.inputId,sourceRunId:input.runId}).input;
    enqueueSessionInput(first.id);
    executionChanged();
    return {handoffId:id,successor:canonical(successor.id),address:sessionAddress(successor),inventory:now,digest:hash,state:'proposed'};
  }).immediate();
}

function inventoryLocalWithExternal(sessionId:number,snapshot:Inventory):Inventory {
  return {items:[...ledgerItems(sessionId),...snapshot.items.filter(item=>item.kind==='lab'||item.kind==='worktree')].sort((a,b)=>a.id.localeCompare(b.id)),omissions:snapshot.omissions};
}

export async function acceptHandoff(input:{actorSession:number;inputId:string;runId:string;handoffId:string;digest:string}) {
  const proposed=row(input.handoffId);if(!proposed)throw new Error('Unknown handoff.');
  if(proposed.successor_session_id!==input.actorSession)throw new Error('Only the successor’s live run may accept this handoff.');
  if(proposed.state==='accepted'){
    if(input.digest!==proposed.inventory_digest)throw new Error('This handoff was already accepted with a different inventory digest.');
    return {accepted:true,duplicate:true,handoffId:proposed.id,predecessor:canonical(proposed.predecessor_session_id),
      successor:canonical(proposed.successor_session_id),inventory:JSON.parse(proposed.inventory_json),digest:proposed.inventory_digest};
  }
  if(proposed.state!=='proposed')throw new Error('This handoff is not proposed.');
  const observed=await inventory(proposed.predecessor_session_id,{inputId:input.inputId,runId:input.runId});
  const current=inventoryLocalWithExternal(proposed.predecessor_session_id,observed),currentDigest=digest(current);
  if(input.digest!==currentDigest) return {accepted:false,handoffId:input.handoffId,inventory:current,digest:currentDigest,reason:'Inventory changed; acknowledge this exact digest.'};
  if(current.items.some(item=>item.kind==='queued'&&!item.movable))
    return {accepted:false,handoffId:input.handoffId,inventory:current,digest:currentDigest,reason:'A queued input may have reached its provider or has dependencies. Let its exact outcome settle before accepting ownership.'};
  const result=db.transaction(()=>{
    const state=row(input.handoffId);if(!state||state.state!=='proposed')throw new Error('This handoff changed while it was being accepted.');
    const verified=inventoryLocalWithExternal(state.predecessor_session_id,current),verifiedDigest=digest(verified);
    if(verifiedDigest!==input.digest)return {accepted:false,handoffId:input.handoffId,inventory:verified,digest:verifiedDigest,reason:'Ledger obligations changed; acknowledge this exact digest.'};
    const from=state.predecessor_session_id,to=state.successor_session_id;
    const moved:{kind:string;ref:string}[]=[];
    const record=(kind:string,ref:string)=>{db.query('INSERT INTO session_handoff_items(handoff_id,kind,ref,from_session_id,to_session_id) VALUES(?,?,?,?,?)').run(state.id,kind,ref,from,to);moved.push({kind,ref});};
    const successorInputId=`handoff:${state.id}`;
    const successorTurnId=getAcceptedSessionInput(successorInputId)?.turn_id;
    if(!successorTurnId)throw new Error('Successor handoff brief was not queued.');
    const movable=new Set(verified.items.filter(item=>item.kind==='queued'&&item.movable).map(item=>item.ref));
    for(const item of verified.items){
      if(item.kind==='sent'){
        const table=db.query('SELECT 1 FROM session_communication_requests WHERE request_id=?').get(item.ref)?'session_communication_requests':'session_peer_requests';
        const changed=db.query(`UPDATE ${table} SET source_session_id=? WHERE request_id=? AND source_session_id=? AND outcome IS NULL`).run(to,item.ref,from);
        if(changed.changes!==1)throw new Error(`Sent request ${item.ref} changed during handoff.`);record(item.kind,item.ref);
      }else if(item.kind==='owed'){
        const table=item.source==='peer'?'session_peer_deliveries':item.source==='outside'?'session_external_requests':'session_communication_requests';
        const open=table==='session_peer_deliveries'?'closed_at_ms IS NULL':'outcome IS NULL';
        const movesInput=movable.has(String(item.targetInputId));
        const changed=table==='session_communication_requests'
          ?db.query(`UPDATE ${table} SET target_session_id=?,target_input_id=?,target_turn_id=? WHERE request_id=? AND target_session_id=? AND ${open}`)
            .run(to,movesInput?item.targetInputId:successorInputId,movesInput?item.turnId??null:successorTurnId,item.ref,from)
          :db.query(`UPDATE ${table} SET target_session_id=?,target_input_id=? WHERE request_id=? AND target_session_id=? AND ${open}`)
            .run(to,movesInput?item.targetInputId:successorInputId,item.ref,from);
        if(changed.changes!==1)throw new Error(`Owed request ${item.ref} changed during handoff.`);record(item.kind,item.ref);
      }else if(item.kind==='queued'&&item.movable){
        const original=getAcceptedSessionInput(item.ref)!;
        const turn=db.query(`SELECT id,session_id,accepted_input_id,status,dispatch_attempt,dispatch_hold,provider_admission_intended_at,
          provider_started_at,provider_turn_id,provider_input_acknowledged_at,saved_kind FROM turns WHERE id=?`).get(original.turn_id) as WaitingTurn|null;
        if(!turn||!safeTurn(turn,original))throw new Error(`Queued input ${item.ref} is no longer safe to move.`);
        finishTurn(turn.id,'cancelled',`Continued by ${canonical(to)} before provider admission.`);
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
        record(item.kind,item.ref);
      }else if(item.kind==='watch'){
        const changed=db.query("UPDATE watches SET session_id=? WHERE watch_id=? AND session_id=? AND (state IN ('accepted','observing') OR delivery_state='pending')").run(to,item.ref,from);
        if(changed.changes!==1)throw new Error(`Watch ${item.ref} changed during handoff.`);record(item.kind,item.ref);
      }
    }
    // Lab records and worktrees are referenced. Their authorship and bytes stay where they are.
    for(const item of verified.items.filter(item=>item.kind==='lab'||item.kind==='worktree'))record(item.kind,item.ref);
    db.query("UPDATE session_handoffs SET state='accepted',accepted_at=CURRENT_TIMESTAMP,inventory_json=?,inventory_digest=? WHERE id=?")
      .run(JSON.stringify(verified),verifiedDigest,state.id);
    // Suspension prevents the next turn. It does not interrupt an already admitted run;
    // that run receives a direct notice after this transaction commits.
    updateSessionMetadata(from,{suspended:true});
    executionChanged();
    return {accepted:true,handoffId:state.id,predecessor:canonical(from),successor:canonical(to),moved,inventory:verified,digest:verifiedDigest};
  }).immediate();
  return result;
}

export function withdrawHandoff(input:{actorSession:number;handoffId:string}) {
  return db.transaction(()=>{
    const current=row(input.handoffId);if(!current||current.state!=='proposed')throw new Error('This handoff is not proposed.');
    if(input.actorSession!==current.caller_session_id&&input.actorSession!==current.predecessor_session_id)
      throw new Error('Only the proposing caller or predecessor may withdraw this handoff.');
    db.query("UPDATE session_handoffs SET state='withdrawn',withdrawn_at=CURRENT_TIMESTAMP WHERE id=? AND state='proposed'").run(current.id);
    updateSessionMetadata(current.successor_session_id,{suspended:true});
    executionChanged();return {withdrawn:true,handoffId:current.id,predecessor:canonical(current.predecessor_session_id)};
  }).immediate();
}
