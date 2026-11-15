import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {db} from './state';
import {installCodexCustodyForwardGuard,type CodexCustodyForwardScope} from './codex-app-server-client';
import {isCodexNativeObservation} from './codex-native-observations';
import {successorThreadStartParams,type CodexSuccessorPlan} from './codex-successor-native';
import {nativeInputClientMessageId} from './native-result-identity';
import {custodySelectedTerminalConfirmed} from './codex-custody-terminal';

type Relation={canonical_input_id:string;predecessor_session_id:number;successor_session_id:number;handoff_id:string;
  placement_input_id:string;placement_turn_id:number;state:string;plan_json:string;native_thread_id:string|null;
  construction_intended_at:string|null;attempt_spent_at:string|null;dispatch_attempt:number|null};
type Handoff={id:string;predecessor_session_id:number;successor_session_id:number;state:string;canonical_input_id:string|null};
const asObject=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
function boundRelation(owner:number|null,thread:string|null,path:string|null):Relation|null {
  if(thread){const byThread=db.query(`SELECT recovery.* FROM codex_custody_successors recovery
    JOIN sessions predecessor ON predecessor.id=recovery.predecessor_session_id
    WHERE predecessor.agent_session_uuid=?`).get(thread) as Relation|null;
    if(byThread)return byThread;
    const bySuccessor=db.query('SELECT * FROM codex_custody_successors WHERE native_thread_id=?').get(thread) as Relation|null;
    if(bySuccessor)return bySuccessor;
  }
  if(path){const bySource=db.query(`SELECT * FROM codex_custody_successors
    WHERE json_extract(snapshot_json,'$.path')=? LIMIT 1`).get(path) as Relation|null;
    if(bySource)return bySource;}
  if(owner!==null)return db.query('SELECT * FROM codex_custody_successors WHERE predecessor_session_id=? OR successor_session_id=? LIMIT 1')
    .get(owner,owner) as Relation|null;
  return null;
}
function pendingHandoff(owner:number|null,thread:string|null):Handoff|null {
  if(owner!==null){const row=db.query(`SELECT id,predecessor_session_id,successor_session_id,state,canonical_input_id
    FROM session_handoffs WHERE handoff_kind='codex-custody-successor' AND state IN ('proposed','accepted')
      AND (predecessor_session_id=? OR successor_session_id=?) ORDER BY created_at DESC LIMIT 1`).get(owner,owner) as Handoff|null;
    if(row)return row;}
  if(thread)return db.query(`SELECT handoff.id,handoff.predecessor_session_id,handoff.successor_session_id,handoff.state,handoff.canonical_input_id
    FROM session_handoffs handoff JOIN sessions predecessor ON predecessor.id=handoff.predecessor_session_id
    WHERE handoff.handoff_kind='codex-custody-successor' AND handoff.state IN ('proposed','accepted')
      AND predecessor.agent_session_uuid=? ORDER BY handoff.created_at DESC LIMIT 1`).get(thread) as Handoff|null;
  return null;
}
function turnParamsMatch(params:Record<string,any>,plan:Record<string,any>,threadId:string):boolean {
  const roots=[...new Set([plan.cwd,...(plan.runtimeWorkspaceRoots??[])])];
  const env=params.environments;
  return params.threadId===threadId&&params.model===plan.model&&params.effort==='medium'&&params.cwd===plan.cwd
    &&JSON.stringify(params.runtimeWorkspaceRoots)===JSON.stringify(roots)&&Array.isArray(env)&&env.length===1
    &&env[0].environmentId===plan.environmentId&&env[0].cwd===plan.cwd
    &&JSON.stringify(env[0].runtimeWorkspaceRoots)===JSON.stringify(roots)
    &&Array.isArray(params.input)&&params.input.length>0&&params.input.every((part:any)=>part?.type==='text'&&typeof part.text==='string');
}
function once(scope:CodexCustodyForwardScope,relation:Relation,sessionId:number,turnId:number|null,kind:string,
  identity=String(turnId??''),inputId:string|null=null) {
  // Sender and connection generation are audit detail, not retry identity: a reconnect must
  // not create a fresh permit for an already-forwarded construction or owner turn.
  const key=createHash('sha256').update(JSON.stringify([relation.canonical_input_id,kind,sessionId,turnId,identity])).digest('hex');
  return db.transaction(()=>{
    if(db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(`custody-native-forward:${key}`))return false;
    db.query(`INSERT INTO session_owner_events(event_id,session_id,input_id,turn_id,kind,payload_json)
      VALUES(?,?,?,?,'custody_native_forward',?)`).run(`custody-native-forward:${key}`,sessionId,
      inputId??(turnId===relation.placement_turn_id?relation.placement_input_id:null),turnId,
      JSON.stringify({phase:'forwarding_intent',canonicalInputId:relation.canonical_input_id,method:scope.method,senderId:scope.senderId,generation:scope.generation,kind,identity}));
    return true;
  }).immediate();
}
function assertExactStop(scope:CodexCustodyForwardScope,sessionId:number) {
  const params=asObject(scope.params),turnId=String(params.turnId??'');
  const turn=db.query(`SELECT turn.id,turn.session_id,turn.status,turn.stop_requested_at,turn.provider_turn_id,turn.accepted_input_id
    FROM turns turn JOIN sessions session ON session.id=turn.session_id
    WHERE session.agent_session_uuid=? AND turn.provider_turn_id=?`).get(scope.threadId,turnId) as any;
  if(!turn||turn.status!=='running'||!turn.stop_requested_at||turn.session_id!==sessionId)
    throw new Error('Native Stop is held unless it names the exact retained turn and its owner-recorded Stop.');
  const input=db.query(`SELECT 1 FROM session_inputs WHERE session_id=? AND kind='stop'
    AND json_extract(payload_json,'$.runId')=(SELECT native_run_id FROM turns WHERE id=?) LIMIT 1`).get(turn.session_id,turn.id);
  if(!input)throw new Error('Native Stop has no exact retained Stop input.');
}
function predecessorGuard(scope:CodexCustodyForwardScope,relation:Relation) {
  if(isCodexNativeObservation(scope.method))return;
  if(scope.method==='turn/interrupt'){assertExactStop(scope,relation.predecessor_session_id);return;}
  throw new Error('Predecessor native writes remain excluded after recovery custody was proposed.');
}
function successorGuard(scope:CodexCustodyForwardScope,relation:Relation) {
  const params=asObject(scope.params),plan=JSON.parse(relation.plan_json) as Record<string,any>;
  const session=scope.ownerSessionId===null?null:db.query('SELECT id,agent_session_uuid,native_metadata_json FROM sessions WHERE id=?').get(scope.ownerSessionId) as any;
  if(!session||session.id!==relation.successor_session_id)
    throw new Error('Protected successor writes require its owner-derived session identity.');
  if(scope.method==='thread/start'){
    if(relation.state!=='constructing'||!relation.construction_intended_at||relation.native_thread_id
      ||plan.ownerSessionId!==relation.successor_session_id||plan.nativeConnection?.senderId!==scope.senderId
      ||plan.nativeConnection?.generation!==scope.generation||scope.threadId!==null
      ||!isDeepStrictEqual(params,successorThreadStartParams(plan as CodexSuccessorPlan)))
      throw new Error('Native construction does not match the committed custody plan, sender generation and intent.');
    if(!once(scope,relation,relation.successor_session_id,null,'construct'))
      throw new Error('The one native construction send was already attempted; reconcile its retained result.');
    return;
  }
  // Pause withholds productive admission; it must not withhold an exact retained Stop.
  if(scope.method==='turn/interrupt'){assertExactStop(scope,relation.successor_session_id);return;}
  if(JSON.parse(session.native_metadata_json??'{}').suspended)
    throw new Error('Protected successor writes remain held while its owner session is suspended.');
  if(scope.method==='thread/resume'||scope.method==='thread/fork'||scope.method==='thread/start')
    throw new Error('Protected successors cannot resume, fork or recreate their native conversation.');
  if(plan.nativeConnection?.senderId!==scope.senderId||plan.nativeConnection?.generation!==scope.generation)
    throw new Error('Successor admission must use the exact sender generation committed by the native binding.');
  if(scope.method==='turn/steer'){
    const clientMessageId=typeof params.clientUserMessageId==='string'?params.clientUserMessageId:'';
    const expectedTurnId=typeof params.expectedTurnId==='string'?params.expectedTurnId:'';
    const turn=db.query(`SELECT turn.id,turn.status,turn.stop_requested_at,turn.owner_instance_id,turn.provider_turn_id
      FROM turns turn JOIN sessions session ON session.id=turn.session_id
      WHERE turn.session_id=? AND session.agent_session_uuid=? AND turn.provider_turn_id=?
        AND turn.status='running' AND turn.stop_requested_at IS NULL AND turn.owner_instance_id IS NOT NULL
      LIMIT 1`).get(relation.successor_session_id,relation.native_thread_id,expectedTurnId) as any;
    const steering=db.query(`SELECT input.id,input.session_id,input.turn_id,input.steering_id,steering.id AS steering_id,
        steering.status,steering.provider_sent_at,steering.replay_text
      FROM session_inputs input JOIN turn_steering_messages steering ON steering.accepted_input_id=input.id
      WHERE input.id=? AND input.session_id=? AND input.turn_id=? AND input.steering_id=steering.id
      AND steering.turn_id=input.turn_id`).get(clientMessageId,relation.successor_session_id,turn?.id??-1) as any;
    const parts=Array.isArray(params.input)?params.input:[];
    if(params.threadId!==relation.native_thread_id||!turn||!['admitted','acknowledged'].includes(relation.state)||!clientMessageId||!steering
      ||steering.status!=='sending'||steering.provider_sent_at!==null
      ||parts.length!==1||parts[0]?.type!=='text'||parts[0]?.text!==steering.replay_text)
      throw new Error('Steering is not the exact currently owned native turn and retained unsent input.');
    if(!once(scope,relation,relation.successor_session_id,turn.id,'steering',clientMessageId,clientMessageId))
      throw new Error('This exact steering input was already forwarded; reconcile its retained outcome.');
    return;
  }
  if(scope.method!=='turn/start')throw new Error('This native mutation has no protected successor operation.');
  const target=scope.threadId===relation.native_thread_id&&relation.native_thread_id!==null;
  if(!target||!turnParamsMatch(params,plan,relation.native_thread_id!))
    throw new Error('Successor turn does not match its retained native thread and Astra Medium workspace binding.');
  const turn=db.query(`SELECT turn.id,turn.status,turn.stop_requested_at,turn.owner_instance_id,turn.dispatch_attempt,
    turn.accepted_input_id,turn.user_text,turn.session_id FROM turns turn
    WHERE turn.session_id=? AND turn.status='running' ORDER BY turn.id DESC LIMIT 1`).get(relation.successor_session_id) as any;
  if(!turn||turn.stop_requested_at||turn.accepted_input_id===null)
    throw new Error('Successor admission is not bound to its current owner-running input.');
  if(params.clientUserMessageId!==nativeInputClientMessageId(turn.id,turn.dispatch_attempt))
    throw new Error('Successor admission lost its durable owner turn/attempt message identity.');
  const selected=turn.id===relation.placement_turn_id;
  if(selected){
    if(relation.state!=='admitting'||!relation.attempt_spent_at||relation.dispatch_attempt!==turn.dispatch_attempt)
      throw new Error('Selected recovery admission has not durably spent its single additional attempt.');
    const input=db.query('SELECT payload_json FROM session_inputs WHERE id=? AND session_id=?').get(relation.placement_input_id,relation.successor_session_id) as any;
    const exact=JSON.parse(input?.payload_json??'{}').text;
    if(typeof exact!=='string'||params.input.length!==1||params.input[0].text!==exact)
      throw new Error('Selected recovery admission does not preserve the exact retained reminder.');
  }else{
    if(!['admitted','acknowledged'].includes(relation.state)||!relation.attempt_spent_at)
      throw new Error('Later successor work is unavailable until the one selected recovery attempt is durably admitted.');
    if(turn.accepted_input_id===relation.canonical_input_id||turn.accepted_input_id===relation.placement_input_id)
      throw new Error('A later successor turn cannot reuse the one-time recovery input.');
    const accepted=db.query(`SELECT 1 FROM session_inputs WHERE id=? AND session_id=? AND turn_id=? AND kind NOT IN ('stop')`)
      .get(turn.accepted_input_id,relation.successor_session_id,turn.id);
    if(!accepted)throw new Error('Later successor work has no distinct currently accepted owner input.');
    const terminal=db.query('SELECT status FROM turns WHERE id=?').get(relation.placement_turn_id) as {status:string};
    if(!['done','error','cancelled'].includes(terminal.status))
      throw new Error('Later successor admission remains held while its selected attempt is unresolved.');
    if(terminal.status==='error'||terminal.status==='cancelled'){
      const reconciled=db.query(`SELECT 1 FROM session_owner_events WHERE event_id=? AND session_id=? AND turn_id=?
        AND kind='custody_terminal_effects' AND json_extract(payload_json,'$.canonicalInputId')=?
        AND json_extract(payload_json,'$.nativeConnection.senderId')=? AND json_extract(payload_json,'$.nativeConnection.generation')=?
        AND json_extract(payload_json,'$.receipt.threadId')=? AND json_extract(payload_json,'$.receipt.owner.admittingTurnId')=?`)
        .get(`custody-terminal-effects:${turn.id}:${turn.dispatch_attempt}`,relation.successor_session_id,turn.id,
          relation.canonical_input_id,scope.senderId,scope.generation,relation.native_thread_id,turn.id);
      if(!custodySelectedTerminalConfirmed(relation.canonical_input_id)||!reconciled)
        throw new Error('Later successor admission remains held until exact terminal and current effects are reconciled.');
    }
  }
  if(!once(scope,relation,relation.successor_session_id,turn.id,selected?'selected-admission':'successor-turn'))
    throw new Error('This native turn send was already attempted; reconcile its retained result.');
}

/** Install the synchronous database-derived policy at the native client's last byte-forward boundary. */
export function installCodexCustodyForwardPolicy() {
  installCodexCustodyForwardGuard(codexCustodyForwardGuard);
}

export function codexCustodyForwardGuard(scope:CodexCustodyForwardScope) {
  if(isCodexNativeObservation(scope.method))return;
  const params=asObject(scope.params),path=typeof params.path==='string'?params.path:null;
  const relation=boundRelation(scope.ownerSessionId,scope.threadId,path);
  const handoff=pendingHandoff(scope.ownerSessionId,scope.threadId);
  if(!relation&&!handoff)return;
  const predecessorId=relation?.predecessor_session_id??handoff!.predecessor_session_id;
  const successorId=relation?.successor_session_id??handoff!.successor_session_id;
  if(scope.ownerSessionId===predecessorId||scope.threadId&&db.query('SELECT 1 FROM sessions WHERE id=? AND agent_session_uuid=?')
    .get(predecessorId,scope.threadId)){
    if(!relation){if(scope.method==='turn/interrupt'){assertExactStop(scope,predecessorId);return;}
      throw new Error('Predecessor native writes are held while the recovery handoff is proposed.');}
    predecessorGuard(scope,relation);return;
  }
  if(scope.ownerSessionId===successorId||scope.threadId&&relation?.native_thread_id===scope.threadId){
    if(!relation)throw new Error('Recovery successor native writes are held until owner custody is committed.');
    successorGuard(scope,relation);return;
  }
  if(scope.classification==='thread-path'||scope.classification==='unkeyed-thread')
    throw new Error('Unkeyed native mutation cannot establish that it is outside protected recovery custody.');
  if(relation&&scope.threadId===null)throw new Error('Unkeyed native mutation remains held while custody is active.');
}
