import type {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import type {CapabilitySource} from './session-capability-client';

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const sourceKey=(id:string,branch:string)=>digest(JSON.stringify([id,branch]));
export type ImportFailure='invalid_request'|'adapter_unavailable'|'source_rejected'|'source_outcome_unknown'|'owner_materialization_failed';
type Attempt={actionId:string;atMs:number;durationMs:number};

export function initializeArchiveImportObservation(db:Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS archive_import_observations (
      action_id TEXT NOT NULL,
      source_version TEXT NOT NULL,
      first_observed_at_ms INTEGER NOT NULL,
      accepted_at_ms INTEGER,
      import_duration_ms INTEGER,
      indexed_conversations INTEGER,
      indexed_activity_records INTEGER,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      source_refusals INTEGER NOT NULL DEFAULT 0,
      last_failure_kind TEXT,
      last_failure_at_ms INTEGER,
      last_failure_duration_ms INTEGER,
      first_search_at_ms INTEGER,
      first_search_duration_ms INTEGER,
      first_search_coverage_complete INTEGER CHECK(first_search_coverage_complete IN (0,1)),
      first_search_source_key TEXT,
      PRIMARY KEY(action_id,source_version)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS archive_import_observations_by_time
      ON archive_import_observations(first_observed_at_ms,action_id,source_version);
    CREATE TABLE IF NOT EXISTS archive_import_source_pins (
      source_version TEXT NOT NULL,
      source_key TEXT NOT NULL,
      action_id TEXT NOT NULL,
      PRIMARY KEY(source_version,source_key,action_id),
      FOREIGN KEY(action_id,source_version) REFERENCES archive_import_observations(action_id,source_version)
    ) WITHOUT ROWID;
  `);
}

export function observeGeminiImport(db:Database,attempt:Attempt,sources:readonly CapabilitySource[]) {
  const versions=new Map<string,Map<string,boolean>>();
  for(const source of sources) {
    if(source.provider!=='gemini')continue;
    const pins=versions.get(source.version)??new Map<string,boolean>();
    pins.set(sourceKey(source.id,source.branch),source.nativeId.startsWith('conversation:'));
    versions.set(source.version,pins);
  }
  if(!versions.size)return;
  db.transaction(()=>{
    const accept=db.query(`INSERT INTO archive_import_observations
      (action_id,source_version,first_observed_at_ms,accepted_at_ms,import_duration_ms,indexed_conversations,indexed_activity_records)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(action_id,source_version) DO UPDATE SET
        accepted_at_ms=excluded.accepted_at_ms,import_duration_ms=excluded.import_duration_ms,
        indexed_conversations=excluded.indexed_conversations,indexed_activity_records=excluded.indexed_activity_records
      WHERE archive_import_observations.accepted_at_ms IS NULL RETURNING action_id`);
    const pin=db.query('INSERT INTO archive_import_source_pins (source_version,source_key,action_id) VALUES (?,?,?)');
    for(const [version,pins] of versions) {
      const grouped=[...pins.values()].filter(Boolean).length;
      if(!accept.get(attempt.actionId,version,attempt.atMs,attempt.atMs,attempt.durationMs,grouped,pins.size-grouped))continue;
      for(const key of pins.keys())pin.run(version,key,attempt.actionId);
    }
  }).immediate();
}

export function observeArchiveImportFailure(db:Database,attempt:Attempt,content:unknown,failure:ImportFailure) {
  // Before the adapter supplies a verified descriptor, the bytes give an attempt digest
  // but provide no retained source or provider identity.
  const version=typeof content==='string'?digest(content):'';
  db.query(`INSERT INTO archive_import_observations
    (action_id,source_version,first_observed_at_ms,failed_attempts,source_refusals,last_failure_kind,last_failure_at_ms,last_failure_duration_ms)
    VALUES (?,?,?,1,?,?,?,?)
    ON CONFLICT(action_id,source_version) DO UPDATE SET failed_attempts=failed_attempts+1,
      source_refusals=source_refusals+excluded.source_refusals,
      last_failure_kind=excluded.last_failure_kind,last_failure_at_ms=excluded.last_failure_at_ms,
      last_failure_duration_ms=excluded.last_failure_duration_ms`)
    .run(attempt.actionId,version,attempt.atMs,Number(failure==='source_rejected'),failure,attempt.atMs,attempt.durationMs);
}

export function observeGeminiSearch(db:Database,response:{results:any[];coverage:{complete?:boolean}},atMs:number,durationMs:number) {
  const matched=new Map<string,string>();
  for(const result of response.results) {
    if(result.session?.provider!=='gemini'||result.session.origin!=='imported'||result.session.peer)continue;
    for(const evidence of result.evidence??[]) {
      if(typeof evidence.sourceId!=='string'||evidence.sourceId!==result.session.nativeKey
        ||typeof evidence.branch!=='string'||typeof evidence.sourceVersion!=='string')continue;
      const key=sourceKey(evidence.sourceId,evidence.branch);
      // Choose the first finally returned pin for an import if this search found several.
      const pending=db.query(`SELECT observation.action_id
        FROM archive_import_source_pins AS pin
        JOIN archive_import_observations AS observation USING(action_id,source_version)
        WHERE pin.source_version=? AND pin.source_key=? AND observation.first_search_at_ms IS NULL
          AND observation.accepted_at_ms<=?`).all(evidence.sourceVersion,key,atMs) as {action_id:string}[];
      for(const {action_id} of pending) {
        const identity=JSON.stringify([action_id,evidence.sourceVersion]);
        if(!matched.has(identity))matched.set(identity,key);
      }
    }
  }
  if(!matched.size)return;
  db.transaction(()=>{
    const hit=db.query(`UPDATE archive_import_observations
      SET first_search_at_ms=?,first_search_duration_ms=?,first_search_coverage_complete=?,first_search_source_key=?
      WHERE action_id=? AND source_version=? AND first_search_at_ms IS NULL`);
    for(const [identity,key] of matched) {
      const [action,version]=JSON.parse(identity) as [string,string];
      hit.run(atMs,durationMs,Number(response.coverage.complete===true),key,action,version);
    }
  }).immediate();
}
