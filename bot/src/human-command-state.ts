import { createHash } from "node:crypto";
import { captureDb } from "./capture-state";

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
  next_attempt_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(client_id,session_id,sequence)
);
CREATE INDEX IF NOT EXISTS human_commands_ready
  ON human_commands(status,next_attempt_ms,created_at);
CREATE INDEX IF NOT EXISTS human_commands_stream
  ON human_commands(client_id,session_id,sequence,status);
`);
const commandColumns=captureDb.query("PRAGMA table_info(human_commands)").all() as {name:string}[];
if(!commandColumns.some(column=>column.name==='decision_stage'))captureDb.exec("ALTER TABLE human_commands ADD COLUMN decision_stage TEXT CHECK(decision_stage IN ('preparation','owner'))");

function row(actionId: string): HumanCommandRow | null {
  return captureDb.query("SELECT * FROM human_commands WHERE action_id=?").get(actionId) as HumanCommandRow | null;
}

export function commandStatus(actionId: string): HumanCommandRow | null { return row(actionId); }

export class CommandIdentityConflict extends Error {
  constructor() { super("The command identity already names different bytes or a different place in the stream."); }
}
export class UnknownCommandTarget extends Error {
  constructor(){super("The action being canceled is not in this client's retained session stream.");}
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
      if(!target||target.client_id!==command.clientId||target.session_id!==command.sessionId)
        throw new UnknownCommandTarget();
      // Transport custody may still hold the target. Freeze it here, in the same transaction
      // that retains the owner's cancellation intent, so a worker cannot import it afterward.
      captureDb.query("UPDATE human_commands SET status='canceled',updated_at=CURRENT_TIMESTAMP WHERE action_id=? AND status='pending'")
        .run(targetId);
    }
    captureDb.query(`INSERT INTO human_commands
      (action_id,door,client_id,session_id,sequence,method,path,body_json,digest)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(command.actionId,command.door,command.clientId,command.sessionId,
        command.sequence,command.method,command.path,bodyJson,digest);
    return row(command.actionId)!;
  }).immediate();
}

// A worker crash after sending cannot prove the owner did not accept. The same action is sent
// again; the canonical owner, not this transport journal, deduplicates its semantic effect.
export function recoverHumanCommands(): number {
  return captureDb.query("UPDATE human_commands SET status='pending',claim_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE status='delivering'").run().changes;
}

/** A predecessor must finish first; a refusal is terminal and does not block later input. */
export function claimHumanCommand(claimId:string,now = Date.now()): HumanCommandRow | null {
  return captureDb.transaction(() => {
    const candidate = captureDb.query(`SELECT * FROM human_commands AS command
      WHERE command.status='pending' AND (command.next_attempt_ms IS NULL OR command.next_attempt_ms<=?)
      AND (command.path LIKE '%/stop' OR command.path LIKE '%/actions/%/cancel' OR NOT EXISTS (SELECT 1 FROM human_commands AS predecessor
        WHERE predecessor.client_id=command.client_id AND predecessor.session_id=command.session_id
          AND predecessor.sequence<command.sequence AND predecessor.status IN ('pending','delivering')))
      ORDER BY CASE WHEN command.path LIKE '%/stop' OR command.path LIKE '%/actions/%/cancel' THEN 0 ELSE 1 END,
        command.created_at,command.sequence LIMIT 1`).get(now) as HumanCommandRow|null;
    if (!candidate) return null;
    captureDb.query("UPDATE human_commands SET status='delivering',claim_id=?,attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE action_id=? AND status='pending'")
      .run(claimId,candidate.action_id);
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
    return row(actionId);
  }).immediate();
}

/** A session creation still held only by ingress can be withdrawn with no invented owner effect. */
export function withdrawPendingCreation(actionId:string):HumanCommandRow|null {
  return captureDb.transaction(()=>{
    captureDb.query("UPDATE human_commands SET status='canceled',updated_at=CURRENT_TIMESTAMP WHERE action_id=? AND path='/sessions/v1/sessions' AND status='pending'")
      .run(actionId);
    const current=row(actionId);
    return current?.path==='/sessions/v1/sessions'?current:null;
  }).immediate();
}
