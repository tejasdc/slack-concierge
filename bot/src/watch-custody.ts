import {createHash} from 'node:crypto';
import type {Database} from 'bun:sqlite';
import type {WatchRow} from './watches';

type Source={sessionId:number;inputId:string;runId:string};
type Pair={oldWatchId:string;newWatchId:string};
type Input={id:string;session_id:number;origin:string;kind:string;scope:string;source_input_id:string|null;source_run_id:string|null;request_id:string|null;turn_id:number|null};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const active=(row:WatchRow)=>['accepted','observing'].includes(row.state);
const denied=()=>new Error('Watch custody requires an exact retained work delegation and provider recovery lineage.');

export function initializeWatchCustody(database:Database){
  database.exec(`CREATE TABLE IF NOT EXISTS watch_custody_operations (
    source_input_id TEXT NOT NULL, action_id TEXT NOT NULL, session_id INTEGER NOT NULL,
    payload_hash TEXT NOT NULL, receipt_json TEXT NOT NULL,
    PRIMARY KEY(source_input_id,action_id))`);
}

/** All generations, without treating a common human, project, or title as custody. */
function lineage(database:Database,sessionId:number){
  return (database.query(`WITH RECURSIVE family(id) AS (SELECT ? UNION
    SELECT CASE WHEN r.source_session_id=f.id THEN r.successor_session_id ELSE r.source_session_id END
    FROM provider_recovery_sessions r JOIN family f
      ON r.source_session_id=f.id OR r.successor_session_id=f.id)
    SELECT id FROM family ORDER BY id`).all(sessionId) as {id:number}[]).map(row=>row.id);
}

/** Follow owner-retained edges, including recovered inputs whose request still names the predecessor. */
function delegation(database:Database,source:Source,targetSession:number){
  const read=(id:string)=>database.query('SELECT * FROM session_inputs WHERE id=?').get(id) as Input|null;
  let current=read(source.inputId);
  const run=current?.turn_id?database.query('SELECT session_id,native_run_id FROM turns WHERE id=?').get(current.turn_id) as {session_id:number;native_run_id:string}|null:null;
  if(!current||current.session_id!==source.sessionId||run?.native_run_id!==source.runId||run.session_id!==source.sessionId)throw denied();
  const seen=new Set<string>(),edges:unknown[]=[];
  let recoveryTarget:{id:string;session:number;requestId:string|null}|null=null;
  let reached=false;
  while(current&&!seen.has(current.id)){
    seen.add(current.id);
    if(current.session_id===targetSession)reached=true;
    const recovery=database.query(`SELECT r.* FROM provider_recovery_inputs r
      JOIN provider_recovery_sessions s ON s.source_session_id=r.source_session_id AND s.successor_session_id=r.successor_session_id
      WHERE r.successor_input_id=? AND r.successor_session_id=? AND r.successor_turn_id=?`)
      .get(current.id,current.session_id,current.turn_id) as {source_input_id:string;source_session_id:number;source_turn_id:number}|null;
    if(recovery){
      const parent=read(recovery.source_input_id);
      if(!parent||parent.session_id!==recovery.source_session_id||parent.turn_id!==recovery.source_turn_id)throw denied();
      edges.push({kind:'recovery',from:parent.id,to:current.id,sourceSession:parent.session_id,successorSession:current.session_id});
      recoveryTarget??={id:current.id,session:current.session_id,requestId:current.request_id};
      current=parent;continue;
    }
    if(current.scope.startsWith('provider-recovery:'))throw denied();
    if(current.origin==='human'){
      if(database.query('SELECT 1 FROM session_input_author_corrections WHERE input_id=?').get(current.id)||!reached)throw denied();
      return {humanInputId:current.id,edges};
    }
    if(current.origin!=='agent'||!current.source_input_id||!current.source_run_id)throw denied();
    const parent=read(current.source_input_id);
    const turn=parent?.turn_id?database.query('SELECT native_run_id,session_id FROM turns WHERE id=?').get(parent.turn_id) as {native_run_id:string;session_id:number}|null:null;
    if(!parent||turn?.native_run_id!==current.source_run_id||turn.session_id!==parent.session_id)throw denied();
    const request=database.query(`SELECT request_id,payload_json,target_input_id,target_session_id FROM session_communication_requests
      WHERE request_id=? AND ((target_input_id=? AND target_session_id=?) OR (target_input_id=? AND target_session_id=?))
        AND source_input_id=? AND source_session_id=? AND source_turn_id=?`)
      .get(current.request_id,current.id,current.session_id,
        recoveryTarget?.requestId===current.request_id?recoveryTarget.id:null,
        recoveryTarget?.requestId===current.request_id?recoveryTarget.session:null,
        parent.id,parent.session_id,parent.turn_id) as {request_id:string;payload_json:string;target_input_id:string;target_session_id:number}|null;
    if(!request)throw denied();
    const payload=JSON.parse(request.payload_json);
    if(payload.requestedEffect!=='work')throw denied();
    edges.push({kind:'work',requestId:request.request_id,sourceInputId:parent.id,targetInputId:request.target_input_id,
      sourceSession:parent.session_id,targetSession:request.target_session_id});
    recoveryTarget=null;
    // A source run can hold an earlier work input. Only the owner's retained grant names it.
    if(payload.authorityInputId&&payload.authorityInputId!==parent.id){
      const grant=read(payload.authorityInputId);
      if(!grant||grant.session_id!==parent.session_id)throw denied();
      edges.push({kind:'retained-work-grant',sourceInputId:parent.id,authorityInputId:grant.id});
      current=grant;
    }else current=parent;
  }
  throw denied();
}

function authorized(database:Database,source:Source,pair:Pair){
  if(!pair.oldWatchId||!pair.newWatchId||pair.oldWatchId===pair.newWatchId)throw denied();
  const read=(id:string)=>database.query('SELECT * FROM watches WHERE watch_id=?').get(id) as WatchRow|null;
  const old=read(pair.oldWatchId),next=read(pair.newWatchId);
  if(!old||!next)throw denied();
  const family=lineage(database,next.session_id);
  const ancestor=database.query(`WITH RECURSIVE predecessors(id) AS (SELECT source_session_id FROM provider_recovery_sessions WHERE successor_session_id=?
    UNION SELECT r.source_session_id FROM provider_recovery_sessions r JOIN predecessors p ON r.successor_session_id=p.id)
    SELECT 1 FROM predecessors WHERE id=?`).get(next.session_id,old.session_id);
  if(old.session_id===next.session_id||!ancestor)throw denied();
  const proof=delegation(database,source,next.session_id);
  const recovery=database.query(`SELECT source_session_id,successor_session_id,generation FROM provider_recovery_sessions
    WHERE source_session_id IN (${family.map(()=>'?').join(',')}) ORDER BY source_session_id,generation`).all(...family);
  return {old,next,family,proof:{...proof,recovery}};
}

const metadata=(row:WatchRow)=>({id:row.watch_id,sessionId:row.session_id,originInputId:row.origin_input_id,
  originRunId:row.origin_run_id,actionId:row.action_id,kind:row.kind,condition:JSON.parse(row.condition_json),runner:row.runner??null,
  state:row.state,baselineMode:row.baseline_mode,deadlineMs:row.deadline_ms,renewEveryMs:row.renew_ms,seriesId:row.series_id,
  registeredAtMs:row.created_at_ms,terminalEvent:row.terminal_event,endedAtMs:row.terminal_at_ms,
  delivery:row.delivery_state,deliveryInputId:row.delivery_input_id});

function snapshot(database:Database,source:Source,pair:Pair){
  const authorizedPair=authorized(database,source,pair),{old,next,family,proof}=authorizedPair;
  if(old.kind!=='file'||next.kind!=='file'||old.condition_json!==next.condition_json||(old.runner??null)!==(next.runner??null))
    throw new Error('Select two file watches with the exact same condition and machine.');
  const history=(row:WatchRow)=>database.query(`SELECT * FROM watches WHERE watch_id=? OR series_id=? ORDER BY created_at_ms,watch_id`)
    .all(row.series_id??row.watch_id,row.series_id??row.watch_id) as WatchRow[];
  const oldHistory=history(old),newHistory=history(next);
  const oldActive=oldHistory.filter(active);
  if(oldActive.some(row=>row.kind!=='file'||row.condition_json!==next.condition_json||(row.runner??null)!==(next.runner??null)
    ||!family.includes(row.session_id))||oldActive.length>1||oldActive.some(row=>newHistory.some(n=>n.watch_id===row.watch_id)))
    throw new Error('The selected old series changed or overlaps the successor.');
  const matches=database.query(`SELECT * FROM watches WHERE session_id IN (${family.map(()=>'?').join(',')})
    AND kind='file' AND condition_json=? AND runner IS ? AND state IN ('accepted','observing') ORDER BY watch_id`)
    .all(...family,next.condition_json,next.runner??null) as WatchRow[];
  const historyRows=[...oldHistory,...newHistory];
  const deliveryIds=[...new Set(historyRows.map(row=>row.delivery_input_id).filter((id):id is string=>!!id))];
  const queuedInputs=deliveryIds.length?(database.query(`SELECT input.id,input.session_id,input.turn_id,input.steering_id,
    input.source_input_id,input.source_run_id,input.request_id,input.payload_json,input.receipt_json,
    json_extract(input.receipt_json,'$.state') AS admissionState,turn.status AS turnState
    FROM session_inputs input LEFT JOIN turns turn ON turn.id=input.turn_id
    WHERE input.id IN (${deliveryIds.map(()=>'?').join(',')}) ORDER BY input.id`).all(...deliveryIds) as
      {payload_json:string;receipt_json:string|null;[key:string]:unknown}[])
    .map(({payload_json,receipt_json,...metadata})=>({...metadata,payloadHash:digest(payload_json),receiptHash:digest(receipt_json)})):[];
  const view={old:metadata(old),next:metadata(next),lineage:proof,activeMatches:matches.map(metadata),
    oldHistory:oldHistory.map(metadata),newHistory:newHistory.map(metadata),acceptedInputs:queuedInputs};
  // Bind reconciliation to the inspected rows, baseline and lease, without exposing their bytes.
  const inspection=digest({source,pair,view,baselines:historyRows.map(row=>[row.watch_id,row.baseline_json])});
  return {...authorizedPair,oldActive,view,inspection};
}

export function inspectWatchPair(database:Database,source:Source,pair:Pair){
  return database.transaction(()=>{const result=snapshot(database,source,pair);return {...result.view,inspection:result.inspection};})();
}

export function reconcileWatchPair(database:Database,source:Source,pair:Pair,actionId:string,inspection:string,now=Date.now()){
  if(!actionId||actionId.length>200||!inspection)throw new Error('Reconciliation needs a stable action id and the exact inspection.');
  return database.transaction(()=>{
    authorized(database,source,pair);
    const payloadHash=digest({source,pair,inspection});
    const prior=database.query('SELECT * FROM watch_custody_operations WHERE source_input_id=? AND action_id=?')
      .get(source.inputId,actionId) as {session_id:number;payload_hash:string;receipt_json:string}|null;
    if(prior){
      if(prior.session_id!==source.sessionId||prior.payload_hash!==payloadHash)throw new Error('Idempotency conflict: watch reconciliation payload changed.');
      return JSON.parse(prior.receipt_json);
    }
    const before=snapshot(database,source,pair);
    if(before.inspection!==inspection)throw new Error('Watch pair changed; inspect the exact pair again.');
    if(!active(before.next)||before.next.renew_ms===null)throw new Error('The selected successor must be an existing active renewing file watch.');
    const retiring=before.oldActive[0];
    if(before.view.activeMatches.some(row=>row.id!==before.next.watch_id&&row.id!==retiring?.watch_id))
      throw new Error('Additional active matches require their own exact reconciliation.');
    if(retiring){
      if(retiring.delivery_state!==null||retiring.terminal_event!==null)throw new Error('An active old watch already has terminal delivery evidence.');
      const changed=database.query(`UPDATE watches SET state='cancelled',terminal_event='cancelled',terminal_at_ms=?
        WHERE watch_id=? AND state IN ('accepted','observing') AND delivery_state IS NULL AND terminal_event IS NULL`).run(now,retiring.watch_id);
      if(changed.changes!==1)throw new Error('The old watch changed before quiet retirement.');
    }
    const after=snapshot(database,source,pair);
    const receipt={actionId,source,pair,inspection,recordedAtMs:now,retiredWatchId:retiring?.watch_id??null,
      before:before.view,after:after.view};
    database.query('INSERT INTO watch_custody_operations VALUES(?,?,?,?,?)')
      .run(source.inputId,actionId,source.sessionId,payloadHash,JSON.stringify(receipt));
    return receipt;
  }).immediate();
}
