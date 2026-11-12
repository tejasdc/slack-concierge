import type {Database} from 'bun:sqlite';

/**
 * Every word of every Inbox thread, searchable the moment its message is prepared.
 *
 * Tejas, 2026-11-12, after "anil", "WhatsApp" and "Maschine" found nothing in Threads: "Why are we
 * not indexing this? ... I want threads searchable the moment they exist." Thread search had indexed
 * only each thread's title and summary, so a word he or an agent wrote inside a thread was invisible.
 *
 * Shape, and why: one index row per prepared message, written in the same transaction as the
 * message's display row (`writeThreadText`), so indexing costs what the new message costs and never
 * re-reads a whole thread. A message is found through its root, and the root's current thread is
 * looked up at read time, so re-filing a message into another thread needs no reindex. The worker
 * removes display rows from about eight places (retiring a generation, re-display, removal); a
 * trigger on that table removes the text with it, so no path can leave a stale hit. The full text
 * is kept here because a long message's display row holds only a 1 KB preview.
 *
 * Contract and his search requirements: thnkr.ing docs/architecture/threads-search.md.
 */
export function installThreadText(db:Database){
 db.exec(`CREATE TABLE IF NOT EXISTS presentation_message_text(
   id INTEGER PRIMARY KEY,generation INTEGER NOT NULL,event_sequence INTEGER NOT NULL,text TEXT NOT NULL,
   UNIQUE(generation,event_sequence));
  CREATE VIRTUAL TABLE IF NOT EXISTS presentation_message_search USING fts5(text,content='presentation_message_text',content_rowid='id',tokenize='trigram');
  CREATE TRIGGER IF NOT EXISTS presentation_message_text_added AFTER INSERT ON presentation_message_text BEGIN
   INSERT INTO presentation_message_search(rowid,text) VALUES(new.id,new.text); END;
  CREATE TRIGGER IF NOT EXISTS presentation_message_text_removed AFTER DELETE ON presentation_message_text BEGIN
   INSERT INTO presentation_message_search(presentation_message_search,rowid,text) VALUES('delete',old.id,old.text); END;
  CREATE TRIGGER IF NOT EXISTS presentation_message_text_changed AFTER UPDATE OF text ON presentation_message_text BEGIN
   INSERT INTO presentation_message_search(presentation_message_search,rowid,text) VALUES('delete',old.id,old.text);
   INSERT INTO presentation_message_search(rowid,text) VALUES(new.id,new.text); END;
  CREATE TRIGGER IF NOT EXISTS presentation_message_display_text_removed AFTER DELETE ON presentation_message_display BEGIN
   DELETE FROM presentation_message_text WHERE generation=old.generation AND event_sequence=old.event_sequence; END;
  CREATE TABLE IF NOT EXISTS presentation_message_text_meta(
   singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL,after INTEGER NOT NULL,done INTEGER NOT NULL);
  INSERT OR IGNORE INTO presentation_message_text_meta(singleton,generation,after,done) VALUES(1,-1,0,0);`);
}

/** The words a thread shows for one message. */
export function threadMessageText(message:{content?:unknown}|null|undefined){
 const content=typeof message?.content==='string'?message.content:'';
 return content.startsWith('{"type":"concierge-session-input"')?content.slice(Math.max(0,content.indexOf('\n\n')+2)):content;
}

export function writeThreadText(db:Database,generation:number,sequence:number,text:string){
 if(!text.trim()){db.query('DELETE FROM presentation_message_text WHERE generation=? AND event_sequence=?').run(generation,sequence);return;}
 db.query(`INSERT INTO presentation_message_text(generation,event_sequence,text) VALUES(?,?,?)
  ON CONFLICT(generation,event_sequence) DO UPDATE SET text=excluded.text WHERE text IS NOT excluded.text`).run(generation,sequence,text);
}

/**
 * Indexes messages prepared before this index existed, a bounded page per call, from the prepared
 * rows alone (the display row, or its full detail when the display holds a preview). Returns whether
 * the active generation is fully indexed. A new generation restarts the walk.
 */
export function backfillThreadText(db:Database,generation:number,page=150){
 const state=db.query('SELECT generation,after,done FROM presentation_message_text_meta WHERE singleton=1').get() as {generation:number;after:number;done:number};
 if(state.generation!==generation){db.query('UPDATE presentation_message_text_meta SET generation=?,after=0,done=0 WHERE singleton=1').run(generation);state.after=0;state.done=0;}
 if(state.done)return true;
 const rows=db.query(`SELECT event_sequence AS sequence,display_json AS display FROM presentation_message_display
  WHERE generation=? AND event_sequence>? ORDER BY event_sequence LIMIT ?`).all(generation,state.after,page) as {sequence:number;display:string}[];
 const chunks=db.query('SELECT content FROM presentation_message_detail_chunks WHERE generation=? AND event_sequence=? ORDER BY part');
 const exists=db.query('SELECT 1 FROM presentation_message_text WHERE generation=? AND event_sequence=?');
 for(const row of rows){
  if(exists.get(generation,row.sequence))continue;
  let message:{content?:unknown;contentCoverage?:{complete?:boolean}}|null=null;
  try{message=JSON.parse(row.display);}catch{message=null;}
  if(message?.contentCoverage&&message.contentCoverage.complete===false){
   const detail=(chunks.all(generation,row.sequence) as {content:string}[]).map(chunk=>chunk.content).join('');
   if(detail)try{message=JSON.parse(detail);}catch{}
  }
  writeThreadText(db,generation,row.sequence,threadMessageText(message));
 }
 const done=rows.length<page;
 db.query('UPDATE presentation_message_text_meta SET after=?,done=? WHERE singleton=1').run(rows.at(-1)?.sequence??state.after,done?1:0);
 return done;
}
