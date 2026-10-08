import { createHash } from "node:crypto";
import { captureDb } from "./capture-state";
import {isProcessIdentityAlive,type ProcessIdentity} from './runtime-identity';

export type HumanCommand = Readonly<{
  version: 1;
  clientId: string;
  sessionId: string;
  sequence: number;
  actionId: string;
  door: string;
  method: "POST";
  path: string;
  body: Record<string, unknown>;
}>;

export type HumanCommandStatus = "pending" | "delivering" | "delivered" | "refused" | "canceled";
export type HumanCommandRow = Readonly<{
  action_id: string;
  door: string;
  client_id: string;
  session_id: string;
  sequence: number;
  method: "POST";
  path: string;
  body_json: string;
  prepared_json: string | null;
  digest: string;
  status: HumanCommandStatus;
  owner_status: number | null;
  decision_stage: "preparation" | "owner" | null;
  owner_response_json: string | null;
  attempts: number;
  claim_id: string | null;
  claim_owner_json: string | null;
  claim_worker_id: string | null;
  next_attempt_ms: number | null;
  created_at: string;
  updated_at: string;
}>;

captureDb.exec(`
CREATE TABLE IF NOT EXISTS human_commands (
  action_id TEXT PRIMARY KEY,
  door TEXT NOT NULL,
  client_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  method TEXT NOT NULL CHECK(method='POST'),
  path TEXT NOT NULL,
  body_json TEXT NOT NULL,
  prepared_json TEXT,
  digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','delivering','delivered','refused','canceled')),
  owner_status INTEGER,
  decision_stage TEXT CHECK(decision_stage IN ('preparation','owner')),
  owner_response_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  claim_id TEXT,
  claim_owner_json TEXT,
  claim_worker_id TEXT,
  next_attempt_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(client_id,session_id,sequence)
);
CREATE INDEX IF NOT EXISTS human_commands_ready
  ON human_commands(status,next_attempt_ms,created_at);
CREATE INDEX IF NOT EXISTS human_commands_stream
  ON human_commands(client_id,session_id,sequence,status);
CREATE TABLE IF NOT EXISTS human_command_streams(
  client_id TEXT NOT NULL,session_id TEXT NOT NULL,next_sequence INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(client_id,session_id)
);
`);
const commandColumns=captureDb.query("PRAGMA table_info(human_commands)").all() as {name:string}[];
if(!commandColumns.some(column=>column.name==='decision_stage'))captureDb.exec("ALTER TABLE human_commands ADD COLUMN decision_stage TEXT CHECK(decision_stage IN ('preparation','owner'))");
for(const column of ['claim_owner_json','claim_worker_id'])if(!commandColumns.some(value=>value.name===column))captureDb.exec(`ALTER TABLE human_commands ADD COLUMN ${column} TEXT`);

function advanceStream(clientId:string,sessionId:string){
 const stream=captureDb.query('SELECT next_sequence FROM human_command_streams WHERE client_id=? AND session_id=?').get(clientId,sessionId) as {next_sequence:number};
 let next=stream.next_sequence;
 for(;;){
  const found=captureDb.query('SELECT status FROM human_commands WHERE client_id=? AND session_id=? AND sequence=?').get(clientId,sessionId,next) as {status:string}|null;
  if(!found||!['delivered','refused','canceled'].includes(found.status))break;
  next++;
 }
 if(next!==stream.next_sequence)captureDb.query('UPDATE human_command_streams SET next_sequence=? WHERE client_id=? AND session_id=?').run(next,clientId,sessionId);
}

function row(actionId: string): HumanCommandRow | null {
  return captureDb.query("SELECT * FROM human_commands WHERE action_id=?").get(actionId) as HumanCommandRow | null;
}

export function commandStatus(actionId: string): HumanCommandRow | null { return row(actionId); }

export class CommandIdentityConflict extends Error {
  constructor() { super("The command identity already names different bytes or a different place in the stream."); }
}

function canceledAction(path:string):string|null {
  const match=path.match(/^\/sessions\/v1\/sessions\/[^/]+\/actions\/([^/]+)\/cancel$/);
  return match?.[1]?decodeURIComponent(match[1]):null;
}

export function retainHumanCommand(command: HumanCommand): HumanCommandRow {
  const bodyJson = JSON.stringify(command.body);
  const digest = createHash("sha256").update(JSON.stringify([
    command.version, command.clientId, command.sessionId, command.sequence,
    command.actionId, command.door, command.method, command.path, bodyJson,
  ])).digest("hex");
  return captureDb.transaction(() => {
    captureDb.query('INSERT OR IGNORE INTO human_command_streams(client_id,session_id) VALUES(?,?)').run(command.clientId,command.sessionId);
    const byAction = row(command.actionId);
    if (byAction) {
      if (byAction.digest !== digest) throw new CommandIdentityConflict();
      return byAction;
    }
    const bySequence = captureDb.query("SELECT action_id FROM human_commands WHERE client_id=? AND session_id=? AND sequence=?")
      .get(command.clientId, command.sessionId, command.sequence) as {action_id:string}|null;
    if (bySequence) throw new CommandIdentityConflict();
    const targetId=canceledAction(command.path);
    if(targetId){
      const target=row(targetId);
      // Transport custody may still hold the target. Freeze it here, in the same transaction
      // that retains the owner's cancellation intent, so a worker cannot import it afterward.
      if(target?.session_id===command.sessionId){
        captureDb.query("UPDATE human_commands SET status='canceled',updated_at=CURRENT_TIMESTAMP WHERE action_id=? AND status='pending'").run(targetId);
        advanceStream(target.client_id,target.session_id);
      }
      // An exact cancellation can overtake the original network request. Retain it even
      // when that target has not arrived; the owner records cancellation before admission.
    }
    captureDb.query(`INSERT INTO human_commands
      (action_id,door,client_id,session_id,sequence,method,path,body_json,digest)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(command.actionId,command.door,command.clientId,command.sessionId,
        command.sequence,command.method,command.path,bodyJson,digest);
    advanceStream(command.clientId,command.sessionId);
    return row(command.actionId)!;
  }).immediate();
}

// A worker crash after sending cannot prove the owner did not accept. The same action is sent
// again; the canonical owner, not this transport journal, deduplicates its semantic effect.
export function recoverHumanCommands(workerId?:string): number {
  let recovered=0;
  for(const claim of captureDb.query("SELECT action_id,claim_owner_json,claim_worker_id FROM human_commands WHERE status='delivering'").all() as Pick<HumanCommandRow,'action_id'|'claim_owner_json'|'claim_worker_id'>[]){
    const owner=claim.claim_owner_json?JSON.parse(claim.claim_owner_json) as ProcessIdentity:null;
    if(claim.claim_worker_id!==workerId&&owner&&isProcessIdentityAlive(owner))continue;
    recovered+=captureDb.query("UPDATE human_commands SET status='pending',claim_id=NULL,claim_owner_json=NULL,claim_worker_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE action_id=? AND status='delivering'").run(claim.action_id).changes;
  }
  return recovered;
}

/** A predecessor must finish first; a refusal is terminal and does not block later input. */
export function claimHumanCommand(claimId:string,owner:ProcessIdentity,workerId:string,now = Date.now()): HumanCommandRow | null {
  return captureDb.transaction(() => {
    // One worker holds only one active claim; another live worker's claim stays fenced.
    recoverHumanCommands(workerId);
    const candidate = captureDb.query(`SELECT * FROM human_commands AS command
      WHERE command.status='pending' AND (command.next_attempt_ms IS NULL OR command.next_attempt_ms<=?)
      AND (command.path LIKE '%/stop' OR command.path LIKE '%/actions/%/cancel' OR command.sequence=(
        SELECT next_sequence FROM human_command_streams stream WHERE stream.client_id=command.client_id AND stream.session_id=command.session_id))
      ORDER BY CASE WHEN command.path LIKE '%/stop' OR command.path LIKE '%/actions/%/cancel' THEN 0 ELSE 1 END,
        command.created_at,command.sequence LIMIT 1`).get(now) as HumanCommandRow|null;
    if (!candidate) return null;
    captureDb.query("UPDATE human_commands SET status='delivering',claim_id=?,claim_owner_json=?,claim_worker_id=?,attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE action_id=? AND status='pending'")
      .run(claimId,JSON.stringify(owner),workerId,candidate.action_id);
    return row(candidate.action_id);
  }).immediate();
}

export function settleHumanCommand(actionId:string,claimId:string,ownerStatus:number,response:unknown,decisionStage:"preparation"|"owner"):HumanCommandRow {
  return captureDb.transaction(() => {
    const current=row(actionId);
    if (!current || current.status!=='delivering'||current.claim_id!==claimId) throw new Error("Command is not held by this delivery worker.");
    captureDb.query(`UPDATE human_commands SET status=?,owner_status=?,owner_response_json=?,decision_stage=?,claim_id=NULL,next_attempt_ms=NULL,
      updated_at=CURRENT_TIMESTAMP WHERE action_id=? AND status='delivering'`).run(
      ownerStatus>=200&&ownerStatus<300?'delivered':'refused',ownerStatus,JSON.stringify(response),decisionStage,actionId);
    advanceStream(current.client_id,current.session_id);
    return row(actionId)!;
  }).immediate();
}

export function prepareHumanCommand(actionId:string,claimId:string,prepared:unknown):HumanCommandRow {
  return captureDb.transaction(()=>{
    const current=row(actionId);
    if(!current||current.status!=='delivering'||current.claim_id!==claimId)throw new Error("Command is not held by this delivery worker.");
    const encoded=JSON.stringify(prepared);
    if(current.prepared_json&&current.prepared_json!==encoded)throw new CommandIdentityConflict();
    if(!current.prepared_json)captureDb.query("UPDATE human_commands SET prepared_json=?,updated_at=CURRENT_TIMESTAMP WHERE action_id=? AND claim_id=?")
      .run(encoded,actionId,claimId);
    return row(actionId)!;
  }).immediate();
}

export function retryHumanCommand(actionId:string,claimId:string,nextAttemptMs:number):boolean {
  return captureDb.query("UPDATE human_commands SET status='pending',claim_id=NULL,next_attempt_ms=?,updated_at=CURRENT_TIMESTAMP WHERE action_id=? AND status='delivering' AND claim_id=?")
    .run(nextAttemptMs,actionId,claimId).changes===1;
}

/** A pending action is canceled locally, before the canonical owner has ever seen it. */
export function cancelPendingHumanCommand(actionId:string):HumanCommandRow|null {
  return captureDb.transaction(() => {
    captureDb.query("UPDATE human_commands SET status='canceled',updated_at=CURRENT_TIMESTAMP WHERE action_id=? AND status='pending'")
      .run(actionId);
    const current=row(actionId);if(current)advanceStream(current.client_id,current.session_id);return current;
  }).immediate();
}

/** A session creation still held only by ingress can be withdrawn with no invented owner effect. */
export function withdrawPendingCreation(actionId:string):HumanCommandRow|null {
  return captureDb.transaction(()=>{
    captureDb.query("UPDATE human_commands SET status='canceled',updated_at=CURRENT_TIMESTAMP WHERE action_id=? AND path='/sessions/v1/sessions' AND status='pending'")
      .run(actionId);
    const current=row(actionId);
    if(current)advanceStream(current.client_id,current.session_id);
    return current?.path==='/sessions/v1/sessions'?current:null;
  }).immediate();
}
