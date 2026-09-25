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
      // A question is a decision he owes or something to read; where it came from; and the Inbox
      // attention generation it was raised at (docs/plans/2026-09-23-attention-that-ends.md).
      add('inbox_questions','kind',"kind TEXT NOT NULL DEFAULT 'decision'");
      add('inbox_questions','origin',"origin TEXT NOT NULL DEFAULT 'declared'");
      add('inbox_questions','generation','generation INTEGER');
      add('turn_steering_messages','accepted_input_id','accepted_input_id TEXT');
      add('session_communication_requests','source_input_id','source_input_id TEXT');
      add('session_communication_requests','target_input_id','target_input_id TEXT');
      // The thread an Inbox request works for, named by the sender and resolved at admission,
      // so what comes back is filed there and never under the input that started the turn.
      add('session_communication_requests','thread_root_input_id','thread_root_input_id TEXT');
      add('session_peer_requests','thread_root_input_id','thread_root_input_id TEXT');
      add('session_communication_events','accepted_input_id','accepted_input_id TEXT');
      // A recipient's explicit final replaces an owner-inferred one (undetermined/unanswered read
      // off a finished turn). Both stay as history; only the unsuperseded final is current.
      add('session_communication_events','superseded_by_event_id','superseded_by_event_id TEXT');
      // The steps request-liveness.ts takes for a stranded request, each at most once.
      add('session_communication_requests','reminded_at_ms','reminded_at_ms INTEGER');
      add('session_communication_requests','stalled_at_ms','stalled_at_ms INTEGER');
      // 'hook' when the end-of-turn hook sent the worker back inside its run; 'input' for a reminder turn.
      add('session_communication_requests','reminded_via','reminded_via TEXT');
      // The run whose Stop hook listed this request, so only a request that hook actually showed counts as reminded.
      add('session_communication_requests','hook_offered_run','hook_offered_run TEXT');
      db.exec(`DROP INDEX IF EXISTS session_communication_final;
        CREATE UNIQUE INDEX IF NOT EXISTS session_communication_current_final ON session_communication_events(request_id) WHERE kind='final' AND superseded_by_event_id IS NULL;`);
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
        -- Every per-session read of inputs (a session's receipts, its resurrection record, the
        -- Inbox's human replies) seeks by session; without this the catalogue's per-imported-
        -- session lookup scanned 10,787 rows 651 times and took 3.9 s per read (2026-09-25).
        CREATE INDEX IF NOT EXISTS session_inputs_session_kind ON session_inputs(session_id,kind);
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
        CREATE INDEX IF NOT EXISTS session_owner_events_session_kind ON session_owner_events(session_id, kind);
        -- Resolving which thread an Inbox message belongs to looks events up by their input; without
        -- this the first Threads list after a restart scanned the whole ledger per message (85 s, 2026-09-22).
        CREATE INDEX IF NOT EXISTS session_owner_events_input ON session_owner_events(input_id);
        -- Streaming rewrites a message many times; search needs each message's latest version without a whole-ledger GROUP BY.
        CREATE INDEX IF NOT EXISTS session_owner_events_message_version ON session_owner_events(turn_id, json_extract(payload_json,'$.message.id'), sequence) WHERE kind='message';
        -- A history page's input and metadata projections look each message up by session and
        -- message id; without this they parsed the JSON of every message event of the session
        -- per requested message (43 messages × 3,680 events: 2.3 s a page, 14 s for a delta
        -- read, blocking the owner for that long; 2026-09-25). With it: 5 ms.
        CREATE INDEX IF NOT EXISTS session_owner_events_message_lookup ON session_owner_events(session_id, json_extract(payload_json,'$.message.id')) WHERE kind='message';
        -- A request this instance sent to a peer instance. The target session lives in the
        -- peer's ledger, so it cannot satisfy session_communication_requests' foreign keys.
        CREATE TABLE IF NOT EXISTS session_peer_requests (
          request_id TEXT PRIMARY KEY,
          peer TEXT NOT NULL,
          source_session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          source_turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
          source_input_id TEXT NOT NULL REFERENCES session_inputs(id),
          action_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          remote_session_id TEXT NOT NULL,
          remote_address TEXT NOT NULL,
          remote_operation_id TEXT NOT NULL,
          remote_status_json TEXT,
          status TEXT NOT NULL DEFAULT 'recorded',
          outcome TEXT,
          result_json TEXT,
          due_at_ms INTEGER NOT NULL,
          overdue_at_ms INTEGER,
          created_at_ms INTEGER NOT NULL,
          UNIQUE(source_input_id, action_id)
        );
        CREATE INDEX IF NOT EXISTS session_peer_requests_pending ON session_peer_requests(status) WHERE outcome IS NULL;
        CREATE TABLE IF NOT EXISTS session_peer_events (
          event_id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL REFERENCES session_peer_requests(request_id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('progress','final','overdue')),
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'recorded',
          error TEXT,
          accepted_input_id TEXT,
          created_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS session_peer_events_undelivered ON session_peer_events(status) WHERE status NOT IN ('received','retained');
        -- A request a peer instance delivered here. Its requester lives in the peer's ledger;
        -- this row lets the recipient reply and lets the peer read the request's execution.
        CREATE TABLE IF NOT EXISTS session_peer_deliveries (
          request_id TEXT PRIMARY KEY,
          peer TEXT NOT NULL,
          origin_session_id TEXT NOT NULL,
          origin_input_id TEXT NOT NULL,
          origin_run_id TEXT NOT NULL,
          target_session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          target_input_id TEXT NOT NULL,
          requested_effect TEXT NOT NULL DEFAULT 'informational',
          origin_provenance_json TEXT,
          notified_fingerprint TEXT,
          closed_at_ms INTEGER,
          created_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS session_peer_deliveries_open ON session_peer_deliveries(peer) WHERE closed_at_ms IS NULL;
        CREATE TABLE IF NOT EXISTS session_peer_replies (
          event_id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL REFERENCES session_peer_deliveries(request_id) ON DELETE CASCADE,
          action_key TEXT UNIQUE,
          kind TEXT NOT NULL CHECK(kind IN ('progress','final')),
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          error TEXT,
          created_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS session_peer_replies_pending ON session_peer_replies(status) WHERE status='pending';
        -- The last catalogue a peer answered with, so its sessions stay addressable while it is offline.
        CREATE TABLE IF NOT EXISTS session_peer_catalogue (
          peer TEXT NOT NULL,
          remote_session_id TEXT NOT NULL,
          address TEXT NOT NULL,
          runtime_thread_id TEXT,
          view_json TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY(peer, remote_session_id)
        );
        CREATE INDEX IF NOT EXISTS session_peer_catalogue_thread ON session_peer_catalogue(runtime_thread_id);
        -- Topics: the Inbox's recognizable conversations. Owner events are the truth
        -- (kinds topic, topic_request, topic_question, topic_answer, topic_reading,
        -- topic_focus, topics_migration); these tables are their replayable projection,
        -- rebuilt by rebuildTopicProjections() in session-topics.ts.
        CREATE TABLE IF NOT EXISTS inbox_topics (
          topic_id TEXT PRIMARY KEY,
          session_id INTEGER NOT NULL REFERENCES sessions(id),
          title TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed')),
          set_aside_json TEXT,
          aliases_json TEXT NOT NULL DEFAULT '[]',
          revision INTEGER NOT NULL DEFAULT 1,
          recovered INTEGER NOT NULL DEFAULT 0,
          read_sequence INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          closure_json TEXT,
          created_by_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS inbox_topics_session ON inbox_topics(session_id,state);
        -- One thread root belongs to at most one topic; the latest placement wins.
        CREATE TABLE IF NOT EXISTS inbox_topic_roots (
          root_input_id TEXT PRIMARY KEY,
          topic_id TEXT NOT NULL,
          placed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          placed_by_json TEXT NOT NULL DEFAULT '{}',
          reason TEXT
        );
        CREATE INDEX IF NOT EXISTS inbox_topic_roots_topic ON inbox_topic_roots(topic_id);
        CREATE TABLE IF NOT EXISTS inbox_requests (
          request_id TEXT PRIMARY KEY,
          topic_id TEXT NOT NULL,
          title TEXT NOT NULL,
          brief TEXT NOT NULL DEFAULT '',
          state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed')),
          disposition TEXT,
          revision INTEGER NOT NULL DEFAULT 1,
          sources_json TEXT NOT NULL DEFAULT '[]',
          dispatches_json TEXT NOT NULL DEFAULT '[]',
          closure_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS inbox_requests_topic ON inbox_requests(topic_id,state);
        CREATE TABLE IF NOT EXISTS inbox_questions (
          question_id TEXT PRIMARY KEY,
          topic_id TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          state TEXT NOT NULL DEFAULT 'open',
          blocking INTEGER NOT NULL DEFAULT 1,
          optional INTEGER NOT NULL DEFAULT 0,
          context TEXT NOT NULL DEFAULT 'ready' CHECK(context IN ('ready','agent_checking')),
          brief_json TEXT NOT NULL DEFAULT '{}',
          owner_json TEXT,
          sources_json TEXT NOT NULL DEFAULT '[]',
          replaces TEXT,
          replaced_by TEXT,
          answer_json TEXT,
          recovered INTEGER NOT NULL DEFAULT 0,
          -- The migrated attention entry this question recovered, so answering it can clear
          -- that legacy need without matching question text.
          legacy_need_event_id TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS inbox_questions_topic ON inbox_questions(topic_id,state);
        -- What was actually shown, and what he said he read. Never inferred from either.
        CREATE TABLE IF NOT EXISTS inbox_topic_reading (
          topic_id TEXT NOT NULL,
          item_id TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0,
          kind TEXT NOT NULL CHECK(kind IN ('exposed','acknowledged')),
          at TEXT NOT NULL,
          by_json TEXT,
          UNIQUE(topic_id,item_id,revision,kind)
        );
        CREATE INDEX IF NOT EXISTS inbox_topic_reading_topic ON inbox_topic_reading(topic_id,item_id);
        -- What the router says it is working on right now, bound to its exact run.
        CREATE TABLE IF NOT EXISTS inbox_focus (
          session_id INTEGER PRIMARY KEY REFERENCES sessions(id),
          topic_id TEXT,
          input_ids_json TEXT NOT NULL DEFAULT '[]',
          run_id TEXT,
          summary TEXT,
          since TEXT
        );
        CREATE INDEX IF NOT EXISTS inbox_focus_topic ON inbox_focus(topic_id);
        -- An input recorded as Tejas's that an agent actually posted. The input keeps its bytes;
        -- this additive record says who wrote it, and every reader of "his words" honours it.
        CREATE TABLE IF NOT EXISTS session_input_author_corrections (
          input_id TEXT PRIMARY KEY REFERENCES session_inputs(id),
          -- Null when the agent ran on another instance; the reason names it.
          author_session_id INTEGER REFERENCES sessions(id),
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      // Retain the speech text beside its original bytes so a later provider
      // dispatch and a retried client request use the same transcription.
      add('session_attachments','transcript_text','transcript_text TEXT');
      // Who produced those words: the person's phone or this server, and with which engine.
      add('session_attachments','transcript_source','transcript_source TEXT');
      add('session_attachments','transcript_engine','transcript_engine TEXT');
      add('session_attachments','transcript_engine_version','transcript_engine_version TEXT');
      add('session_attachments','duration_ms','duration_ms INTEGER');
      // A forwarded copy of a recording finds its original's words by the bytes' hash.
      db.exec('CREATE INDEX IF NOT EXISTS session_attachments_sha256 ON session_attachments(sha256)');
      // A peer request accepted while the peer was offline keeps its exact delivery body until it lands.
      add('session_peer_requests','delivery_json','delivery_json TEXT');
      // Same supersession as session_communication_events: a peer recipient's late explicit final
      // replaces an inferred one and returns in its own right.
      add('session_peer_events','superseded_by_event_id','superseded_by_event_id TEXT');
      // The worker's machine reminds and detects a stall (it owns the worker session); the origin
      // records the stalled notice it returned to the requester.
      add('session_peer_deliveries','reminded_at_ms','reminded_at_ms INTEGER');
      add('session_peer_deliveries','stalled_at_ms','stalled_at_ms INTEGER');
      add('session_peer_deliveries','stalled_reason','stalled_reason TEXT');
      add('session_peer_deliveries','reminded_via','reminded_via TEXT');
      add('session_peer_deliveries','hook_offered_run','hook_offered_run TEXT');
      add('session_peer_requests','stalled_at_ms','stalled_at_ms INTEGER');
      // Inputs agents posted through his intake or sign-in, found by the September 23, 2026 audit
      // (docs/runbooks/THINKERING-CAPTURE.md#nothing-but-him). Applied only where the exact input and
      // author exist, so another instance's ledger is untouched. A correction never re-labels in the
      // other direction; add a row here, in review, for any later one.
      const correct=db.query(`INSERT OR IGNORE INTO session_input_author_corrections(input_id,author_session_id,reason)
        SELECT ?1,(SELECT id FROM sessions WHERE id=?2),?3 WHERE EXISTS(SELECT 1 FROM session_inputs WHERE id=?1 AND origin='human')`);
      for(const [inputId,sessionId,reason] of [
        ['capture:913790e47e8cd27302671d83aafb4744915f9903aed239fcd19233e90f6d19c1',3572,'The Thinkering agent posted this test through the capture intake with the app\'s key (2026-09-23).'],
        ['capture:0efbbf3dd0a230eb318e8a2f1f462b665d1277039eed3771ff874b2e02124178',3572,'The Thinkering agent posted this test through the capture intake with the app\'s key (2026-09-23).'],
        ['capture:3427ddf59583d32229017ff81267672751ffaeaf73f4b5a7c5e874da0b8c38c5',3572,'The Thinkering agent posted this test through the capture intake with the app\'s key (2026-09-23).'],
        ['capture:e075516f9458a7e9024092c52f2e22bb0feb7b3a193f40c1f935da34eacde2a8',null,'An agent on the Mac posted this delivery check with a device key it made for the capture helper (2026-09-23).'],
        ['a939f495-9319-4d39-ad0f-b3076a67d1d5',null,'An agent on the Mac signed in with the shared sign-in secret and sent this to test the Mac link (2026-09-18).'],
        ['a6b5b14b-06c4-496e-b4d6-f2c2800e3588',null,'An agent on the Mac signed in with the shared sign-in secret and sent this to test the Mac link (2026-09-18).'],
        ['8c51f324-70c2-4c6b-80b4-c80a0c3d7142',null,'An agent on the Mac signed in with the shared sign-in secret and sent this to test the Mac link (2026-09-18).'],
        ['d2a82dfd-3404-4dbf-86fc-0a24beea9018',null,'An agent on the Mac signed in with the shared sign-in secret and sent this to test the Mac link (2026-09-18).'],
        ['e12bca9f-64b1-4550-ae84-15b19eb02139',null,'An agent on the Mac signed in with the shared sign-in secret and sent this to test the Mac link (2026-09-18).'],
        ['2fc1b0bc-0818-4c22-b130-eed40c72a04a',null,'An agent on the Mac signed in with the shared sign-in secret and started this to test the Mac link (2026-09-18).'],
        ['04f086f4-459e-41c4-a8c6-e1c7562e0ba4',null,'An agent on the Mac signed in with the shared sign-in secret and sent this to test the Mac link (2026-09-18).'],
        ['334de17b-fb9b-4708-a9aa-f3226a6c5f1b',3275,'The agent building session attention pinned this session to test pinning (2026-09-17).'],
        ['3b5441db-e747-4a34-ba68-70653b415b46',3275,'The agent building session attention unpinned this session to test pinning (2026-09-17).'],
      ] as const)correct.run(inputId,sessionId,reason);
      const violation = db.query('PRAGMA foreign_key_check').get();
      if (violation) throw new Error(`Session owner migration violates a foreign key: ${JSON.stringify(violation)}`);
    // Immediate: it reads the schema and then writes (idempotent inserts, index statements). A
    // deferred transaction that upgrades to write fails at once with SQLITE_BUSY when the running
    // service has committed in between, whatever the busy timeout; that failed a deployment's run
    // claim twice on 2026-09-23 while sessions were active. Taking the write lock first waits instead.
    }).immediate();
  } finally {
    db.exec(`PRAGMA foreign_keys=${foreignKeys ? 'ON' : 'OFF'}`);
  }
}
