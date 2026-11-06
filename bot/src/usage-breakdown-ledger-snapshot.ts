import {Database} from 'bun:sqlite';
import {deflateSync,inflateSync} from 'node:zlib';

type Row=Record<string,unknown>;
export type UsageLedgerSnapshot={sinceMs:number;sessions:Row[];turns:Row[];events:Row[];timeZone:string};

/** Only the owner-held facts needed to attribute one week of runner usage. */
export function captureUsageLedgerSnapshot(ledger:Database,sinceMs:number):UsageLedgerSnapshot{
  const since=new Date(sinceMs).toISOString().slice(0,19).replace('T',' ');
  const turns=ledger.query(`SELECT id,session_id,status,provider_turn_id,provider_started_at,ended_at,
    saved_kind,saved_repeat_ms,saved_root_id,saved_sequence,saved_fire_at_ms,provider_duration_ms
    FROM turns WHERE (provider_started_at IS NOT NULL AND (provider_started_at>=? OR ended_at>=? OR ended_at IS NULL))
      OR (saved_kind='scheduled' AND saved_repeat_ms IS NOT NULL AND saved_fire_at_ms>=?)`).all(since,since,sinceMs) as Row[];
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
  const turnIds=new Set(turns.map(row=>row.id as number)),seenTurns=new Set<number>();
  const identities=byIds('prompt_cache_identity','turn_id',[...turnIds],'',[]).sort((a,b)=>Number(b.sequence)-Number(a.sequence));
  for(const event of identities){const id=event.turn_id as number;
    if(turnIds.has(id)&&!seenTurns.has(id)){events.push(event);seenTurns.add(id);}}
  const timeZone=(ledger.query('SELECT time_zone FROM saved_work_settings WHERE singleton=1').get() as {time_zone:string}|null)?.time_zone??'America/New_York';
  return {sinceMs,sessions,turns,events,timeZone};
}

export function encodeUsageSnapshot(value:UsageLedgerSnapshot):string{
  return deflateSync(JSON.stringify(value)).toString('base64url');
}
export function decodeUsageSnapshot(value:string):UsageLedgerSnapshot{
  if(typeof value!=='string'||value.length>2*1024*1024)throw new Error('INVALID_USAGE_LEDGER_SNAPSHOT');
  const parsed=JSON.parse(inflateSync(Buffer.from(value,'base64url'),{maxOutputLength:16*1024*1024}).toString('utf8'));
  if(!parsed||!Array.isArray(parsed.sessions)||!Array.isArray(parsed.turns)||!Array.isArray(parsed.events)
    ||typeof parsed.timeZone!=='string'||!Number.isSafeInteger(parsed.sinceMs)||parsed.sinceMs<0||parsed.sinceMs>Date.now()
    ||parsed.sessions.length>20_000||parsed.turns.length>50_000||parsed.events.length>100_000)
    throw new Error('INVALID_USAGE_LEDGER_SNAPSHOT');
  return parsed;
}

/** The runner never opens the owner ledger. This memory copy contains only report attribution. */
export function ledgerFromUsageSnapshot(snapshot:UsageLedgerSnapshot):Database{
  const db=new Database(':memory:');
  db.exec(`CREATE TABLE sessions(id INTEGER PRIMARY KEY,agent_session_uuid TEXT,provider_id TEXT,native_metadata_json TEXT);
    CREATE TABLE turns(id INTEGER PRIMARY KEY,session_id INTEGER,status TEXT,provider_turn_id TEXT,provider_started_at TEXT,ended_at TEXT,
      saved_kind TEXT,saved_repeat_ms INTEGER,saved_root_id INTEGER,saved_sequence INTEGER,saved_fire_at_ms INTEGER,provider_duration_ms INTEGER);
    CREATE TABLE session_owner_events(sequence INTEGER PRIMARY KEY,session_id INTEGER,turn_id INTEGER,kind TEXT,payload_json TEXT,created_at TEXT);
    CREATE TABLE saved_work_settings(singleton INTEGER PRIMARY KEY,time_zone TEXT);`);
  const insert=(table:string,keys:string[],rows:Row[])=>{
    const statement=db.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`);
    for(const row of rows)statement.run(...keys.map(key=>row[key]??null));
  };
  db.exec('BEGIN');
  try{
    insert('sessions',['id','agent_session_uuid','provider_id','native_metadata_json'],snapshot.sessions);
    insert('turns',['id','session_id','status','provider_turn_id','provider_started_at','ended_at','saved_kind','saved_repeat_ms','saved_root_id','saved_sequence','saved_fire_at_ms','provider_duration_ms'],snapshot.turns);
    insert('session_owner_events',['sequence','session_id','turn_id','kind','payload_json','created_at'],snapshot.events);
    db.query('INSERT INTO saved_work_settings VALUES(1,?)').run(snapshot.timeZone);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');db.close();throw error;}
  return db;
}
