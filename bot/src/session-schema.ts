import type { Database } from "bun:sqlite";

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

function allowAbsentAdapterFields(db: Database, table: string, names: string[]) {
  const fields = db.query(`PRAGMA table_info(${identifier(table)})`).all() as {name:string;notnull:number}[];
  const required = names.filter(name => fields.some(field => field.name === name && field.notnull));
  if (!required.length) return;
  const original = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as {sql:string};
  const auxiliary = db.query("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL").all(table) as {sql:string}[];
  const temporary = `${table}_surface_independent`;
  if (db.query("SELECT 1 FROM sqlite_master WHERE name=?").get(temporary)) throw new Error(`Unresolved schema migration: ${temporary}`);
  let definition = original.sql.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|\w+)/i, `CREATE TABLE ${identifier(temporary)}`);
  for (const name of required) {
    const pattern = new RegExp(`(\\b${name}\\s+TEXT)\\s+NOT NULL`, 'i');
    if (!pattern.test(definition)) throw new Error(`Unsupported adapter column definition: ${table}.${name}`);
    definition = definition.replace(pattern, '$1');
  }
  const columns = fields.map(field => identifier(field.name)).join(',');
  const sequence = db.query('SELECT seq FROM sqlite_sequence WHERE name=?').get(table) as {seq:number}|null;
  db.exec(definition);
  db.exec(`INSERT INTO ${identifier(temporary)} (${columns}) SELECT ${columns} FROM ${identifier(table)}`);
  const oldCount = db.query(`SELECT count(*) AS count FROM ${identifier(table)}`).get() as {count:number};
  const newCount = db.query(`SELECT count(*) AS count FROM ${identifier(temporary)}`).get() as {count:number};
  if (oldCount.count !== newCount.count) throw new Error(`Incomplete adapter migration: ${table}`);
  db.exec(`DROP TABLE ${identifier(table)}`);
  db.exec(`ALTER TABLE ${identifier(temporary)} RENAME TO ${identifier(table)}`);
  if (sequence) db.query('UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name=?').run(sequence.seq,table);
  for (const item of auxiliary) db.exec(item.sql);
}

export function initializeSessionOwnerSchema(db: Database) {
  const foreignKeys = (db.query('PRAGMA foreign_keys').get() as {foreign_keys:number}).foreign_keys;
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.transaction(() => {
      const adapterFields: Array<[string, string[]]> = [
        ['sessions', ['slack_channel_id','slack_thread_ts']],
        ['turns', ['slack_user_msg_ts']],
        ['turn_steering_messages', ['slack_user_msg_ts']],
        ['session_communication_requests', ['source_channel','source_message_ts','source_root_ts','target_channel','target_root_ts']],
      ];
      const needsUpgrade = adapterFields.some(([table,names]) =>
        (db.query(`PRAGMA table_info(${identifier(table)})`).all() as {name:string;notnull:number}[])
          .some(field => names.includes(field.name) && field.notnull));
      const views = needsUpgrade ? db.query("SELECT name,sql FROM sqlite_master WHERE type='view'").all() as {name:string;sql:string}[] : [];
      // SQLite validates all views during rename, while the replaced table is absent.
      for (const view of views) db.exec(`DROP VIEW ${identifier(view.name)}`);
      for (const [table,names] of adapterFields) allowAbsentAdapterFields(db,table,names);
      for (const view of views) db.exec(view.sql);
      const add = (table:string, name:string, definition:string) => {
        const fields = db.query(`PRAGMA table_info(${identifier(table)})`).all() as {name:string}[];
        if (!fields.some(field => field.name === name)) db.exec(`ALTER TABLE ${identifier(table)} ADD COLUMN ${definition}`);
      };
      add('sessions','binding_generation','binding_generation INTEGER NOT NULL DEFAULT 1');
      add('sessions','native_metadata_json',"native_metadata_json TEXT NOT NULL DEFAULT '{}'");
      add('turns','accepted_input_id','accepted_input_id TEXT');
      add('turns','native_run_id','native_run_id TEXT');
      add('turn_steering_messages','accepted_input_id','accepted_input_id TEXT');
      add('session_communication_requests','source_input_id','source_input_id TEXT');
      add('session_communication_requests','target_input_id','target_input_id TEXT');
      add('session_communication_events','accepted_input_id','accepted_input_id TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_inputs (
          id TEXT PRIMARY KEY,
          session_id INTEGER NOT NULL REFERENCES sessions(id),
          scope TEXT NOT NULL,
          action_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          origin TEXT NOT NULL CHECK(origin IN ('human','agent','service')),
          payload_json TEXT NOT NULL,
          turn_id INTEGER REFERENCES turns(id),
          steering_id INTEGER REFERENCES turn_steering_messages(id),
          source_input_id TEXT REFERENCES session_inputs(id),
          source_run_id TEXT,
          request_id TEXT,
          receipt_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(scope, action_id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS turns_accepted_input ON turns(accepted_input_id) WHERE accepted_input_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS turns_native_run ON turns(native_run_id) WHERE native_run_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS steering_accepted_input ON turn_steering_messages(accepted_input_id) WHERE accepted_input_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS communication_source_input ON session_communication_requests(source_input_id,action_id) WHERE source_input_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS session_inputs_turn ON session_inputs(turn_id);
        CREATE TABLE IF NOT EXISTS session_attachments (
          id TEXT PRIMARY KEY, action_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
          content_type TEXT NOT NULL, sha256 TEXT NOT NULL, bytes BLOB NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS session_owner_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          session_id INTEGER NOT NULL REFERENCES sessions(id),
          input_id TEXT REFERENCES session_inputs(id),
          turn_id INTEGER REFERENCES turns(id),
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      // Retain the speech text beside its original bytes so a later provider
      // dispatch and a retried client request use the same transcription.
      add('session_attachments','transcript_text','transcript_text TEXT');
      const violation = db.query('PRAGMA foreign_key_check').get();
      if (violation) throw new Error(`Session owner migration violates a foreign key: ${JSON.stringify(violation)}`);
    })();
  } finally {
    db.exec(`PRAGMA foreign_keys=${foreignKeys ? 'ON' : 'OFF'}`);
  }
}
