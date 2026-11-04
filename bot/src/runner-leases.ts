import type {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';

/**
 * The runner protocol's durable records (docs/architecture/RUNNERS.md). Runners are machines
 * that pull work from the owner over outbound HTTPS; nothing here reaches a runner.
 *
 * Invariants:
 * - A job is the work; an attempt is one runner's custody of it; the epoch fences that custody.
 *   Each (re)acquisition of an attempt raises its epoch, and every heartbeat, event batch,
 *   command result and finish names the epoch it holds. A stale epoch is refused, so a runner
 *   that lost its lease (or a second copy of its daemon) can no longer write.
 * - Liveness is computed, never swept: an attempt holds the job only while `state='live'` and
 *   its lease has not passed. No timer has to run for an expired lease to stop counting.
 * - Events carry a per-attempt sequence. Only the contiguous next sequences are stored and the
 *   answer is the durable cursor, so a resend after a lost answer stores nothing twice.
 * - Every effect has its own operation identity: commands by `command_id`, the finish by its
 *   operation id. An expired job is requeued only when it declared replay safe; otherwise it is
 *   settled `unconfirmed` for its coordinator to reconcile (a provider may still have acted).
 */
export const LEASE_MS=90_000;
export const HEARTBEAT_MS=15_000;

export type RunnerJobState='queued'|'leased'|'finished'|'unconfirmed';
export class RunnerProtocolError extends Error {
  constructor(readonly code:'STALE_EPOCH'|'UNKNOWN_ATTEMPT'|'UNKNOWN_JOB'|'INVALID'|'CONFLICT',message:string){super(message);}
}

export function initializeRunnerSchema(db:Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS runner_jobs (
    job_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    replay_safe INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL CHECK(state IN ('queued','leased','finished','unconfirmed')),
    created_at_ms INTEGER NOT NULL,
    ended_at_ms INTEGER,
    finish_operation_id TEXT,
    result_json TEXT
  );
  CREATE INDEX IF NOT EXISTS runner_jobs_queued ON runner_jobs(created_at_ms) WHERE state='queued';
  CREATE INDEX IF NOT EXISTS runner_jobs_leased ON runner_jobs(job_id) WHERE state='leased';
  CREATE TABLE IF NOT EXISTS runner_attempts (
    attempt_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES runner_jobs(job_id),
    runner TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('live','finished','expired')),
    lease_expires_at_ms INTEGER NOT NULL,
    acked_seq INTEGER NOT NULL DEFAULT 0,
    started_at_ms INTEGER NOT NULL,
    ended_at_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS runner_attempts_job ON runner_attempts(job_id);
  CREATE INDEX IF NOT EXISTS runner_attempts_live ON runner_attempts(runner) WHERE state='live';
  CREATE TABLE IF NOT EXISTS runner_events (
    attempt_id TEXT NOT NULL REFERENCES runner_attempts(attempt_id),
    seq INTEGER NOT NULL,
    received_at_ms INTEGER NOT NULL,
    frame_json TEXT NOT NULL,
    PRIMARY KEY(attempt_id,seq)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS runner_commands (
    command_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES runner_jobs(job_id),
    kind TEXT NOT NULL,
    body_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    result_json TEXT,
    result_attempt_id TEXT,
    result_at_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS runner_commands_open ON runner_commands(job_id,created_at_ms) WHERE result_at_ms IS NULL;`);
}

type Attempt={attempt_id:string;job_id:string;runner:string;epoch:number;state:string;lease_expires_at_ms:number;acked_seq:number};
type Job={job_id:string;kind:string;payload_json:string;replay_safe:number;state:RunnerJobState;result_json:string|null;finish_operation_id:string|null};

export class RunnerLeases {
  constructor(private readonly db:Database,private readonly now:()=>number=Date.now){}

  /** The coordinator's side: record work for a runner. The same job id records once. */
  enqueue(input:{jobId?:string;kind:string;payload:unknown;replaySafe?:boolean}):{jobId:string;created:boolean} {
    const jobId=input.jobId??randomUUID();
    if(!/^[a-z][a-z0-9-]{1,40}$/.test(input.kind))throw new RunnerProtocolError('INVALID','Invalid job kind.');
    const created=this.db.query(`INSERT INTO runner_jobs(job_id,kind,payload_json,replay_safe,state,created_at_ms)
      VALUES(?,?,?,?,'queued',?) ON CONFLICT(job_id) DO NOTHING`).run(jobId,input.kind,JSON.stringify(input.payload??null),input.replaySafe?1:0,this.now()).changes>0;
    return {jobId,created};
  }

  /** Settles every lease that has passed. Called inside each transition, so no timer is needed. */
  private settleExpired() {
    const now=this.now();
    const expired=this.db.query(`SELECT attempt.attempt_id,attempt.job_id,job.replay_safe FROM runner_attempts attempt
      JOIN runner_jobs job ON job.job_id=attempt.job_id
      WHERE attempt.state='live' AND attempt.lease_expires_at_ms<=?`).all(now) as {attempt_id:string;job_id:string;replay_safe:number}[];
    for(const row of expired) {
      this.db.query("UPDATE runner_attempts SET state='expired',ended_at_ms=? WHERE attempt_id=? AND state='live'").run(now,row.attempt_id);
      this.db.query(`UPDATE runner_jobs SET state=?,ended_at_ms=CASE WHEN ?='unconfirmed' THEN ? ELSE NULL END,
        result_json=CASE WHEN ?='unconfirmed' THEN ? ELSE result_json END WHERE job_id=? AND state='leased'`)
        .run(row.replay_safe?'queued':'unconfirmed',row.replay_safe?'queued':'unconfirmed',now,
          row.replay_safe?'queued':'unconfirmed',JSON.stringify({unconfirmed:'lease_expired',attemptId:row.attempt_id}),row.job_id);
    }
    return expired.length;
  }

  /** A runner asks for work: the oldest queued job of a kind it runs, under a new attempt at epoch 1. */
  claim(runner:string,kinds:readonly string[]) {
    return this.db.transaction(()=>{
      this.settleExpired();
      if(!kinds.length)return null;
      const job=this.db.query(`SELECT * FROM runner_jobs WHERE state='queued' AND kind IN (${kinds.map(()=>'?').join(',')})
        ORDER BY created_at_ms LIMIT 1`).get(...kinds) as Job|null;
      if(!job)return null;
      const now=this.now(),attemptId=randomUUID();
      this.db.query("UPDATE runner_jobs SET state='leased' WHERE job_id=? AND state='queued'").run(job.job_id);
      this.db.query(`INSERT INTO runner_attempts(attempt_id,job_id,runner,epoch,state,lease_expires_at_ms,started_at_ms)
        VALUES(?,?,?,1,'live',?,?)`).run(attemptId,job.job_id,runner,now+LEASE_MS,now);
      return {jobId:job.job_id,kind:job.kind,payload:JSON.parse(job.payload_json),attemptId,epoch:1,
        leaseExpiresAtMs:now+LEASE_MS,heartbeatMs:HEARTBEAT_MS,ackedSeq:0};
    }).immediate();
  }

  /**
   * A restarted runner takes back attempts it still runs locally. Each live one gets a new epoch,
   * fencing the daemon copy that held it before; an expired one is answered `stale`, and the
   * runner must stop that local work because the owner has already decided it.
   */
  reacquire(runner:string,attemptIds:readonly string[]) {
    return this.db.transaction(()=>{
      this.settleExpired();
      return attemptIds.map(attemptId=>{
        const attempt=this.db.query('SELECT * FROM runner_attempts WHERE attempt_id=?').get(attemptId) as Attempt|null;
        if(!attempt||attempt.runner!==runner||attempt.state!=='live')return {attemptId,stale:true as const};
        const lease=this.now()+LEASE_MS;
        this.db.query('UPDATE runner_attempts SET epoch=epoch+1,lease_expires_at_ms=? WHERE attempt_id=?').run(lease,attemptId);
        return {attemptId,stale:false as const,epoch:attempt.epoch+1,leaseExpiresAtMs:lease,ackedSeq:attempt.acked_seq};
      });
    }).immediate();
  }

  private holding(runner:string,attemptId:string,epoch:number):Attempt {
    this.settleExpired();
    const attempt=this.db.query('SELECT * FROM runner_attempts WHERE attempt_id=?').get(attemptId) as Attempt|null;
    if(!attempt||attempt.runner!==runner)throw new RunnerProtocolError('UNKNOWN_ATTEMPT','This runner holds no such attempt.');
    if(attempt.state!=='live'||attempt.epoch!==epoch)
      throw new RunnerProtocolError('STALE_EPOCH',`Attempt ${attemptId} is ${attempt.state} at epoch ${attempt.epoch}; this caller held ${epoch}.`);
    return attempt;
  }

  /** Extends the lease and hands over commands the job has not answered yet, oldest first. */
  heartbeat(runner:string,attemptId:string,epoch:number) {
    return this.db.transaction(()=>{
      const attempt=this.holding(runner,attemptId,epoch);
      const lease=this.now()+LEASE_MS;
      this.db.query('UPDATE runner_attempts SET lease_expires_at_ms=? WHERE attempt_id=?').run(lease,attemptId);
      const commands=(this.db.query(`SELECT command_id,kind,body_json FROM runner_commands
        WHERE job_id=? AND result_at_ms IS NULL ORDER BY created_at_ms,command_id`).all(attempt.job_id) as {command_id:string;kind:string;body_json:string}[])
        .map(row=>({commandId:row.command_id,kind:row.kind,body:JSON.parse(row.body_json)}));
      return {leaseExpiresAtMs:lease,ackedSeq:attempt.acked_seq,commands};
    }).immediate();
  }

  /** Stores the contiguous run of events after the cursor and answers the durable cursor. */
  appendEvents(runner:string,attemptId:string,epoch:number,events:readonly {seq:number;frame:unknown}[]) {
    return this.db.transaction(()=>{
      const attempt=this.holding(runner,attemptId,epoch);
      let cursor=attempt.acked_seq;
      const insert=this.db.query('INSERT INTO runner_events(attempt_id,seq,received_at_ms,frame_json) VALUES(?,?,?,?)');
      for(const event of [...events].sort((a,b)=>a.seq-b.seq)) {
        if(!Number.isSafeInteger(event.seq)||event.seq<1)throw new RunnerProtocolError('INVALID','Event sequences start at 1.');
        if(event.seq<=cursor)continue;
        if(event.seq!==cursor+1)break;
        insert.run(attemptId,event.seq,this.now(),JSON.stringify(event.frame??null));
        cursor=event.seq;
      }
      this.db.query('UPDATE runner_attempts SET acked_seq=? WHERE attempt_id=?').run(cursor,attemptId);
      return {ackedSeq:cursor};
    }).immediate();
  }

  /** The coordinator's side: a command for the job's runner (submit, close, signal). Same id, one command. */
  command(jobId:string,input:{commandId:string;kind:string;body:unknown}) {
    if(!this.db.query('SELECT 1 FROM runner_jobs WHERE job_id=?').get(jobId))throw new RunnerProtocolError('UNKNOWN_JOB','No such job.');
    const created=this.db.query(`INSERT INTO runner_commands(command_id,job_id,kind,body_json,created_at_ms) VALUES(?,?,?,?,?)
      ON CONFLICT(command_id) DO NOTHING`).run(input.commandId,jobId,input.kind,JSON.stringify(input.body??null),this.now()).changes>0;
    return {commandId:input.commandId,created};
  }

  /** A runner reports what a command did. The first result for a command id stands. */
  commandResults(runner:string,attemptId:string,epoch:number,results:readonly {commandId:string;result:unknown}[]) {
    return this.db.transaction(()=>{
      const attempt=this.holding(runner,attemptId,epoch);
      let recorded=0;
      for(const item of results)recorded+=this.db.query(`UPDATE runner_commands SET result_json=?,result_attempt_id=?,result_at_ms=?
        WHERE command_id=? AND job_id=? AND result_at_ms IS NULL`).run(JSON.stringify(item.result??null),attemptId,this.now(),item.commandId,attempt.job_id).changes;
      return {recorded};
    }).immediate();
  }

  /** Ends the attempt and the job with the runner's outcome; a repeated finish answers the first. */
  finish(runner:string,attemptId:string,epoch:number,operationId:string,result:unknown) {
    return this.db.transaction(()=>{
      const prior=this.db.query(`SELECT job.finish_operation_id,job.result_json FROM runner_attempts attempt JOIN runner_jobs job ON job.job_id=attempt.job_id
        WHERE attempt.attempt_id=? AND attempt.runner=? AND attempt.state='finished'`).get(attemptId,runner) as {finish_operation_id:string|null;result_json:string|null}|null;
      if(prior) {
        if(prior.finish_operation_id!==operationId)throw new RunnerProtocolError('CONFLICT','This attempt already finished under another operation.');
        return {finished:true,repeated:true,result:JSON.parse(prior.result_json??'null')};
      }
      const attempt=this.holding(runner,attemptId,epoch);
      const now=this.now();
      this.db.query("UPDATE runner_attempts SET state='finished',ended_at_ms=? WHERE attempt_id=?").run(now,attemptId);
      this.db.query("UPDATE runner_jobs SET state='finished',ended_at_ms=?,finish_operation_id=?,result_json=? WHERE job_id=?")
        .run(now,operationId,JSON.stringify(result??null),attempt.job_id);
      return {finished:true,repeated:false,result};
    }).immediate();
  }

  /** The coordinator's view of a job, its attempts and events after a cursor. */
  job(jobId:string,afterSeq=0) {
    return this.db.transaction(()=>{
      this.settleExpired();
      const job=this.db.query('SELECT * FROM runner_jobs WHERE job_id=?').get(jobId) as Job|null;
      if(!job)return null;
      const attempts=this.db.query('SELECT attempt_id,runner,epoch,state,lease_expires_at_ms,acked_seq FROM runner_attempts WHERE job_id=? ORDER BY started_at_ms').all(jobId) as Attempt[];
      const current=attempts.at(-1);
      const events=current?(this.db.query('SELECT seq,frame_json FROM runner_events WHERE attempt_id=? AND seq>? ORDER BY seq').all(current.attempt_id,afterSeq) as {seq:number;frame_json:string}[])
        .map(row=>({seq:row.seq,frame:JSON.parse(row.frame_json)})):[];
      return {jobId,kind:job.kind,state:job.state,result:JSON.parse(job.result_json??'null'),attempts,events};
    }).immediate();
  }
}
