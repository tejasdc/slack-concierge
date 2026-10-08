import type {Database} from 'bun:sqlite';

/**
 * The source ledger remains authoritative. This journal records which canonical rows changed,
 * in the same SQLite transaction as the write, including writes by recovery and import code.
 * Readers expand a row to its affected presentation keys in bounded pages. A new canonical
 * table used by a presentation reader must be registered here before that reader can ship.
 */
export const PRESENTATION_CHANGE_TABLES={
  sessions:{key:'{row}.id',session:'{row}.id'},
  channels:{key:'{row}.slack_channel_id'},
  slack_agent_session_title_projections:{key:"{row}.slack_channel_id || ':' || {row}.slack_thread_ts",
    session:'(SELECT id FROM sessions WHERE slack_channel_id={row}.slack_channel_id AND slack_thread_ts={row}.slack_thread_ts LIMIT 1)'},
  slack_agent_session_status_projections:{key:"{row}.slack_channel_id || ':' || {row}.slack_thread_ts",
    session:'(SELECT id FROM sessions WHERE slack_channel_id={row}.slack_channel_id AND slack_thread_ts={row}.slack_thread_ts LIMIT 1)'},
  turns:{key:'{row}.id',session:'{row}.session_id',turn:'{row}.id'},
  turn_steering_messages:{key:'{row}.id',session:'(SELECT session_id FROM turns WHERE id={row}.turn_id)',turn:'{row}.turn_id',input:'{row}.accepted_input_id'},
  turn_dependencies:{key:"{row}.turn_id || ':' || {row}.prerequisite_turn_id",session:'(SELECT session_id FROM turns WHERE id={row}.turn_id)',turn:'{row}.turn_id'},
  session_inputs:{key:'{row}.id',session:'{row}.session_id',input:'{row}.id',turn:'{row}.turn_id',request:'{row}.request_id'},
  session_input_cancellations:{key:"{row}.scope || ':' || {row}.action_id",session:'{row}.session_id',input:'{row}.canceled_by_input_id'},
  session_owner_events:{key:'{row}.sequence',session:'{row}.session_id',input:'{row}.input_id',turn:'{row}.turn_id'},
  session_input_author_corrections:{key:'{row}.input_id',session:'(SELECT session_id FROM session_inputs WHERE id={row}.input_id)',input:'{row}.input_id'},
  session_communication_requests:{key:'{row}.request_id',session:'{row}.source_session_id',input:'{row}.source_input_id',turn:'{row}.source_turn_id',request:'{row}.request_id',targetSession:'{row}.target_session_id',targetInput:'{row}.target_input_id'},
  session_communication_events:{key:'{row}.event_id',session:'(SELECT source_session_id FROM session_communication_requests WHERE request_id={row}.request_id)',input:'{row}.accepted_input_id',request:'{row}.request_id',targetSession:'(SELECT target_session_id FROM session_communication_requests WHERE request_id={row}.request_id)'},
  session_peer_requests:{key:'{row}.request_id',session:'{row}.source_session_id',input:'{row}.source_input_id',turn:'{row}.source_turn_id',request:'{row}.request_id'},
  session_peer_events:{key:'{row}.event_id',session:'(SELECT source_session_id FROM session_peer_requests WHERE request_id={row}.request_id)',input:'{row}.accepted_input_id',request:'{row}.request_id'},
  session_peer_deliveries:{key:'{row}.request_id',session:'{row}.target_session_id',input:'{row}.target_input_id',request:'{row}.request_id'},
  session_peer_replies:{key:'{row}.event_id',session:'(SELECT target_session_id FROM session_peer_deliveries WHERE request_id={row}.request_id)',request:'{row}.request_id'},
  session_external_requests:{key:'{row}.request_id',session:'{row}.target_session_id',input:'{row}.target_input_id',request:'{row}.request_id'},
  session_external_replies:{key:'{row}.event_id',session:'(SELECT target_session_id FROM session_external_requests WHERE request_id={row}.request_id)',request:'{row}.request_id'},
  inbox_topics:{key:'{row}.topic_id',session:'{row}.session_id',topic:'{row}.topic_id'},
  inbox_topic_roots:{key:'{row}.root_input_id',session:'(SELECT session_id FROM inbox_topics WHERE topic_id={row}.topic_id)',topic:'{row}.topic_id',input:'{row}.root_input_id'},
  inbox_requests:{key:'{row}.request_id',session:'(SELECT session_id FROM inbox_topics WHERE topic_id={row}.topic_id)',topic:'{row}.topic_id',request:'{row}.request_id'},
  inbox_questions:{key:'{row}.question_id',session:'(SELECT session_id FROM inbox_topics WHERE topic_id={row}.topic_id)',topic:'{row}.topic_id'},
  inbox_topic_reading:{key:'{row}.rowid',session:'(SELECT session_id FROM inbox_topics WHERE topic_id={row}.topic_id)',topic:'{row}.topic_id'},
  inbox_focus:{key:'{row}.session_id',session:'{row}.session_id',topic:'{row}.topic_id'},
  session_peer_catalogue:{key:"{row}.peer || ':' || {row}.remote_session_id"},
  session_attachments:{key:'{row}.id'},
} as const;

type TableName=keyof typeof PRESENTATION_CHANGE_TABLES;
const quote=(value:string)=>`"${value.replaceAll('"','""')}"`;
const fields=['row_key','session_id','input_id','turn_id','request_id','topic_id','target_session_id','target_input_id'] as const;
const expressions=['key','session','input','turn','request','topic','targetSession','targetInput'] as const;

function triggerStatement(table:TableName,version:'NEW'|'OLD') {
  const spec:PresentationSpec=PRESENTATION_CHANGE_TABLES[table];
  const resolved=expressions.map(field=>field in spec
    ?String(spec[field as keyof PresentationSpec]).replaceAll('{row}',version)
    :'NULL');
  // Keep all possible identifiers out of values; the table name and field expressions are
  // static source constants, not input. The row key is textual so INTEGER and TEXT keys agree.
  resolved[0]=`CAST(${resolved[0]} AS TEXT)`;
  return `INSERT INTO presentation_change_log(source_table,${fields.join(',')}) VALUES(${[`'${table}'`,...resolved].join(',')});`;
}

type PresentationSpec={key:string;session?:string;input?:string;turn?:string;request?:string;topic?:string;targetSession?:string;targetInput?:string};

/** Install after the canonical schema has finished all column additions. */
export function initializePresentationChanges(db:Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS presentation_change_log(
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    source_table TEXT NOT NULL,
    row_key TEXT NOT NULL,
    session_id INTEGER,
    input_id TEXT,
    turn_id INTEGER,
    request_id TEXT,
    topic_id TEXT,
    target_session_id INTEGER,
    target_input_id TEXT,
    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS presentation_changes_session ON presentation_change_log(session_id,sequence);
  CREATE INDEX IF NOT EXISTS presentation_changes_topic ON presentation_change_log(topic_id,sequence);
  CREATE INDEX IF NOT EXISTS presentation_changes_target_session ON presentation_change_log(target_session_id,sequence);
  CREATE INDEX IF NOT EXISTS presentation_sessions_channel ON sessions(slack_channel_id,id) WHERE slack_channel_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS presentation_change_epoch(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    epoch INTEGER NOT NULL,
    retained_after INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO presentation_change_epoch(singleton,epoch) VALUES(1,1);`);
  for(const table of Object.keys(PRESENTATION_CHANGE_TABLES) as TableName[]) {
    for(const kind of ['INSERT','UPDATE','DELETE'] as const) {
      const trigger=`presentation_change_${table}_${kind.toLowerCase()}`;
      const writes=kind==='UPDATE'?[triggerStatement(table,'OLD'),triggerStatement(table,'NEW')]
        :[triggerStatement(table,kind==='DELETE'?'OLD':'NEW')];
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${quote(trigger)} AFTER ${kind} ON ${quote(table)}
        BEGIN ${writes.join('\n')} END;`);
    }
  }
}

export type PresentationChange=Readonly<{
  sequence:number;source_table:TableName;row_key:string;session_id:number|null;
  input_id:string|null;turn_id:number|null;request_id:string|null;topic_id:string|null;
  target_session_id:number|null;target_input_id:string|null;
}>;
export const presentationHead=(db:Database)=>(db.query('SELECT COALESCE(MAX(sequence),0) AS sequence FROM presentation_change_log').get() as {sequence:number}).sequence;
export const presentationEpoch=(db:Database)=>(db.query('SELECT epoch,retained_after FROM presentation_change_epoch WHERE singleton=1').get() as {epoch:number;retained_after:number});

/** Rows are immutable; a short reader transaction can pin its head and continue later. */
export function presentationChanges(db:Database,after:number,head:number,limit:number):PresentationChange[] {
  return db.query(`SELECT sequence,source_table,row_key,session_id,input_id,turn_id,request_id,topic_id,target_session_id,target_input_id
    FROM presentation_change_log WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?`)
    .all(after,head,limit) as PresentationChange[];
}

/** A busy Inbox must not page through unrelated sessions' streamed token events. Both arms
 * start at indexed session keys; a source/target overlap is emitted once. */
export function presentationChangesForSession(db:Database,sessionId:number,after:number,head:number,limit:number):PresentationChange[] {
  return db.query(`SELECT * FROM (
    SELECT sequence,source_table,row_key,session_id,input_id,turn_id,request_id,topic_id,target_session_id,target_input_id
      FROM presentation_change_log WHERE session_id=? AND sequence>? AND sequence<=?
    UNION ALL
    SELECT sequence,source_table,row_key,session_id,input_id,turn_id,request_id,topic_id,target_session_id,target_input_id
      FROM presentation_change_log WHERE target_session_id=? AND (session_id IS NULL OR session_id<>?) AND sequence>? AND sequence<=?
  ) ORDER BY sequence LIMIT ?`).all(sessionId,after,head,sessionId,sessionId,after,head,limit) as PresentationChange[];
}
