import {Database} from 'bun:sqlite';
import {deflateSync,inflateSync} from 'node:zlib';

type Row=Record<string,unknown>;
export type UsageLedgerSnapshot={sinceMs:number;sessions:Row[];turns:Row[];events:Row[];policyRequests:Row[];timeZone:string};

/** Only the owner-held facts needed to attribute one week of runner usage. */
export function captureUsageLedgerSnapshot(ledger:Database,sinceMs:number):UsageLedgerSnapshot{
  const since=new Date(sinceMs).toISOString().slice(0,19).replace('T',' ');
  const turns=ledger.query(`SELECT turn.id,turn.session_id,turn.status,turn.provider_turn_id,turn.provider_started_at,turn.ended_at,
    saved_kind,saved_repeat_ms,saved_root_id,saved_sequence,saved_fire_at_ms,provider_duration_ms
    ,topic.topic_id FROM turns turn
    LEFT JOIN inbox_topic_roots topic ON topic.root_input_id=coalesce(
      (SELECT coalesce(nullif(request.topic_root_input_id,''),request.thread_root_input_id)
       FROM session_communication_requests request WHERE request.target_input_id=turn.accepted_input_id
       ORDER BY request.created_at_ms DESC LIMIT 1),
      (SELECT CASE WHEN coalesce(json_extract(link.payload_json,'$.attached'),1)<>0
        THEN json_extract(link.payload_json,'$.root') END FROM session_owner_events link
       WHERE link.kind='thread_link' AND link.input_id=turn.accepted_input_id ORDER BY link.sequence DESC LIMIT 1),
      turn.accepted_input_id)
    WHERE (turn.provider_started_at IS NOT NULL AND (turn.provider_started_at>=? OR turn.ended_at>=? OR turn.ended_at IS NULL))
      OR (turn.saved_kind='scheduled' AND turn.saved_repeat_ms IS NOT NULL AND turn.saved_fire_at_ms>=?)`).all(since,since,sinceMs) as Row[];
  const sessionIds=new Set(turns.map(row=>row.session_id as number));
  const sessions=(ledger.query('SELECT id,agent_session_uuid,provider_id,native_metadata_json,last_turn_at FROM sessions WHERE agent_session_uuid IS NOT NULL').all() as Row[])
    .filter(row=>{if(typeof row.last_turn_at==='string'&&Date.parse(row.last_turn_at)>=sinceMs)sessionIds.add(row.id as number);
      return sessionIds.has(row.id as number);})
    .map(row=>{
      let meta:Record<string,unknown>={};try{const parsed=JSON.parse(String(row.native_metadata_json));
        for(const key of ['project','cwd','title'])if(typeof parsed?.[key]==='string')meta[key]=parsed[key];}catch{}
      return {...row,native_metadata_json:JSON.stringify(meta)};
    });
  const events:Row[]=[];
  const byIds=(kind:string,key:'session_id'|'turn_id',ids:number[],condition:string,args:unknown[]):Row[]=>{
    const rows:Row[]=[];
    for(let start=0;start<ids.length;start+=1000){const chunk=ids.slice(start,start+1000);
      rows.push(...ledger.query(`SELECT sequence,session_id,turn_id,kind,payload_json,created_at FROM session_owner_events
        WHERE kind=? AND ${key} IN (${chunk.map(()=>'?').join(',')}) ${condition}`).all(kind,...chunk,...args) as Row[]);
    }
    return rows;
  };
  const recentSessionIds=[...sessionIds];
  const priorAccounts=byIds('account','session_id',recentSessionIds,'AND created_at<?',[since])
    .sort((a,b)=>Number(a.session_id)-Number(b.session_id)||String(b.created_at).localeCompare(String(a.created_at))||Number(b.sequence)-Number(a.sequence));
  const seenAccounts=new Set<number>();
  for(const event of priorAccounts){const id=event.session_id as number;
    if(sessionIds.has(id)&&!seenAccounts.has(id)){events.push(event);seenAccounts.add(id);}}
  events.push(...byIds('account','session_id',recentSessionIds,'AND created_at>=?',[since]));
  events.push(...ledger.query(`SELECT sequence,session_id,turn_id,kind,payload_json,created_at FROM session_owner_events
    WHERE kind='model_escalation' AND created_at>=?`).all(since) as Row[]);
  events.push(...ledger.query(`SELECT sequence,session_id,turn_id,kind,payload_json,created_at FROM session_owner_events
    WHERE kind IN ('implementation_top_model_reason','implementation_edit_hold') AND created_at>=?`).all(since) as Row[]);
  const policyRequests:Row[]=[];
  for(const table of ['session_communication_requests','session_peer_requests']){
    const present=ledger.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if(!present)continue;
    const columns=new Set((ledger.query(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(row=>row.name));
    if(!['request_id','source_session_id','payload_json','created_at_ms'].every(column=>columns.has(column)))continue;
    policyRequests.push(...ledger.query(`SELECT request_id,source_session_id,payload_json,created_at_ms FROM ${table}
      WHERE created_at_ms>=? AND (json_extract(payload_json,'$.purpose') IN ('research','design-critique','design-review')
        OR json_extract(payload_json,'$.implementation')=1)`).all(sinceMs) as Row[]);
  }
  const turnIds=new Set(turns.map(row=>row.id as number)),seenTurns=new Set<number>();
  const identities=byIds('prompt_cache_identity','turn_id',[...turnIds],'',[]).sort((a,b)=>Number(b.sequence)-Number(a.sequence));
  for(const event of identities){const id=event.turn_id as number;
    if(turnIds.has(id)&&!seenTurns.has(id)){events.push(event);seenTurns.add(id);}}
  const timeZone=(ledger.query('SELECT time_zone FROM saved_work_settings WHERE singleton=1').get() as {time_zone:string}|null)?.time_zone??'America/New_York';
  return {sinceMs,sessions,turns,events,policyRequests,timeZone};
}

export function encodeUsageSnapshot(value:UsageLedgerSnapshot):string{
  return deflateSync(JSON.stringify(value)).toString('base64url');
}
export function decodeUsageSnapshot(value:string):UsageLedgerSnapshot{
  if(typeof value!=='string'||value.length>2*1024*1024)throw new Error('INVALID_USAGE_LEDGER_SNAPSHOT');
  const parsed=JSON.parse(inflateSync(Buffer.from(value,'base64url'),{maxOutputLength:16*1024*1024}).toString('utf8'));
  if(!parsed||!Array.isArray(parsed.sessions)||!Array.isArray(parsed.turns)||!Array.isArray(parsed.events)
    ||typeof parsed.timeZone!=='string'||!Number.isSafeInteger(parsed.sinceMs)||parsed.sinceMs<0||parsed.sinceMs>Date.now()
    ||parsed.sessions.length>20_000||parsed.turns.length>50_000||parsed.events.length>100_000
    ||!Array.isArray(parsed.policyRequests)||parsed.policyRequests.length>50_000)
    throw new Error('INVALID_USAGE_LEDGER_SNAPSHOT');
  return parsed;
}

/** The runner never opens the owner ledger. This memory copy contains only report attribution. */
export function ledgerFromUsageSnapshot(snapshot:UsageLedgerSnapshot):Database{
  const db=new Database(':memory:');
  db.exec(`CREATE TABLE sessions(id INTEGER PRIMARY KEY,agent_session_uuid TEXT,provider_id TEXT,native_metadata_json TEXT);
    CREATE TABLE turns(id INTEGER PRIMARY KEY,session_id INTEGER,status TEXT,provider_turn_id TEXT,provider_started_at TEXT,ended_at TEXT,
      saved_kind TEXT,saved_repeat_ms INTEGER,saved_root_id INTEGER,saved_sequence INTEGER,saved_fire_at_ms INTEGER,provider_duration_ms INTEGER,topic_id TEXT);
    CREATE TABLE session_owner_events(sequence INTEGER PRIMARY KEY,session_id INTEGER,turn_id INTEGER,kind TEXT,payload_json TEXT,created_at TEXT);
    CREATE TABLE saved_work_settings(singleton INTEGER PRIMARY KEY,time_zone TEXT);
    CREATE TABLE usage_policy_requests(request_id TEXT PRIMARY KEY,source_session_id INTEGER,payload_json TEXT,created_at_ms INTEGER);`);
  const insert=(table:string,keys:string[],rows:Row[])=>{
    const statement=db.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`);
    for(const row of rows)statement.run(...keys.map(key=>row[key]??null));
  };
  db.exec('BEGIN');
  try{
    insert('sessions',['id','agent_session_uuid','provider_id','native_metadata_json'],snapshot.sessions);
    insert('turns',['id','session_id','status','provider_turn_id','provider_started_at','ended_at','saved_kind','saved_repeat_ms','saved_root_id','saved_sequence','saved_fire_at_ms','provider_duration_ms','topic_id'],snapshot.turns);
    insert('session_owner_events',['sequence','session_id','turn_id','kind','payload_json','created_at'],snapshot.events);
    insert('usage_policy_requests',['request_id','source_session_id','payload_json','created_at_ms'],snapshot.policyRequests);
    db.query('INSERT INTO saved_work_settings VALUES(1,?)').run(snapshot.timeZone);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');db.close();throw error;}
  return db;
}
