import type {Database} from 'bun:sqlite';
import {readCompactReceipt,type PreparedReceipt} from './prepared-receipt-core';

type Change={sequence:number;source_table:string;row_key:string;session_id:number|null;
  input_id:string|null;target_input_id:string|null;turn_id:number|null;request_id:string|null};
const PAGE=40;
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
const decode=(value:string):any=>{try{return value.length<=512&&/^[A-Za-z0-9_-]+$/.test(value)
  ?JSON.parse(Buffer.from(value,'base64url').toString('utf8')):null;}catch{return null;}};
const unavailable={complete:false as const,code:'presentation_indexing' as const,appliedSequence:0};

/** The canonical owner is the only writer of facts. This worker owns the disposable read copy. */
export class PreparedReceipts {
  constructor(private readonly source:Database,private readonly prepared:Database){
    prepared.exec(`CREATE TABLE IF NOT EXISTS presentation_receipt_meta(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL DEFAULT 0,
      source_head INTEGER NOT NULL DEFAULT 0,change_base INTEGER NOT NULL DEFAULT 0,ready INTEGER NOT NULL DEFAULT 0
    ); INSERT OR IGNORE INTO presentation_receipt_meta(singleton) VALUES(1);
    CREATE TABLE IF NOT EXISTS presentation_receipts(
      generation INTEGER NOT NULL,session_id INTEGER NOT NULL,input_id TEXT NOT NULL,
      input_rowid INTEGER NOT NULL,receipt_json TEXT NOT NULL,revision INTEGER NOT NULL,
      next_refresh_ms INTEGER,
      PRIMARY KEY(generation,input_id)
    );
    CREATE INDEX IF NOT EXISTS presentation_receipts_page
      ON presentation_receipts(generation,session_id,input_rowid DESC);
    CREATE INDEX IF NOT EXISTS presentation_receipts_due
      ON presentation_receipts(generation,next_refresh_ms) WHERE next_refresh_ms IS NOT NULL;
    CREATE TABLE IF NOT EXISTS presentation_receipt_changes(
      change_id INTEGER PRIMARY KEY AUTOINCREMENT,generation INTEGER NOT NULL,
      session_id INTEGER NOT NULL,input_id TEXT NOT NULL,receipt_json TEXT,
      source_sequence INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS presentation_receipt_changes_page
      ON presentation_receipt_changes(generation,session_id,change_id);`);
  }
  beginRebuild(generation:number){
    this.prepared.query('DELETE FROM presentation_receipts WHERE generation=?').run(generation);
    this.prepared.query('DELETE FROM presentation_receipt_changes WHERE generation=?').run(generation);
  }
  rebuildPage(generation:number,afterRowid:number,limit=20):{lastRowid:number;hasMore:boolean}{
    const rows=this.source.query('SELECT rowid,id FROM session_inputs WHERE rowid>? ORDER BY rowid LIMIT ?')
      .all(afterRowid,limit+1) as {rowid:number;id:string}[];
    for(const row of rows.slice(0,limit))this.write(generation,row.id,0,false);
    return {lastRowid:rows[Math.min(rows.length,limit)-1]?.rowid??afterRowid,hasMore:rows.length>limit};
  }
  activate(generation:number,sourceHead:number){
    const base=(this.prepared.query('SELECT COALESCE(MAX(change_id),0) AS n FROM presentation_receipt_changes WHERE generation=?')
      .get(generation) as {n:number}).n;
    this.prepared.query('UPDATE presentation_receipt_meta SET generation=?,source_head=?,change_base=?,ready=1 WHERE singleton=1')
      .run(generation,sourceHead,base);
    this.prepared.query('DELETE FROM presentation_receipts WHERE generation<?').run(generation);
    this.prepared.query('DELETE FROM presentation_receipt_changes WHERE generation<?').run(generation);
  }
  checkpoint(generation:number,sourceHead:number){
    this.prepared.query('UPDATE presentation_receipt_meta SET source_head=? WHERE singleton=1 AND generation=? AND ready=1')
      .run(sourceHead,generation);
  }
  refreshDue(generation:number,nowMs=Date.now(),limit=20){
    const due=this.prepared.query(`SELECT input_id FROM presentation_receipts
      WHERE generation=? AND next_refresh_ms IS NOT NULL AND next_refresh_ms<=?
      ORDER BY next_refresh_ms LIMIT ?`).all(generation,nowMs,limit) as {input_id:string}[];
    for(const row of due)this.write(generation,row.input_id,0,true);
    return due.length;
  }
  /** Expand a finite journal page by exact keys, then refresh each distinct receipt once. */
  apply(generation:number,changes:readonly Change[]){
    const ids=new Map<string,number>();
    const turns=new Map<number,number>(),requests=new Map<string,number>();
    for(const change of changes){
      if(change.input_id)ids.set(change.input_id,change.sequence);
      if(change.target_input_id)ids.set(change.target_input_id,change.sequence);
      if(change.turn_id)turns.set(change.turn_id,change.sequence);
      if(change.request_id)requests.set(change.request_id,change.sequence);
      if(change.source_table==='provider_outage_offers'){
        const input=this.source.query('SELECT input_id FROM provider_outage_offers WHERE turn_id=?')
          .get(Number(change.row_key)) as {input_id:string}|null;
        if(input)ids.set(input.input_id,change.sequence);
      }
    }
    for(const [turnId,sequence] of turns){
      const rows=this.source.query('SELECT id FROM session_inputs WHERE turn_id=? UNION SELECT accepted_input_id AS id FROM turns WHERE id=? AND accepted_input_id IS NOT NULL')
        .all(turnId,turnId) as {id:string}[];
      for(const row of rows)ids.set(row.id,Math.max(ids.get(row.id)??0,sequence));
    }
    for(const [requestId,sequence] of requests){
      const local=this.source.query(`SELECT source_input_id AS id FROM session_communication_requests WHERE request_id=?
        UNION SELECT target_input_id AS id FROM session_communication_requests WHERE request_id=?
        UNION SELECT source_input_id AS id FROM session_peer_requests WHERE request_id=?
        UNION SELECT target_input_id AS id FROM session_peer_deliveries WHERE request_id=?
        UNION SELECT target_input_id AS id FROM session_external_requests WHERE request_id=?`)
        .all(requestId,requestId,requestId,requestId,requestId) as {id:string|null}[];
      for(const row of local)if(row.id)ids.set(row.id,Math.max(ids.get(row.id)??0,sequence));
    }
    for(const [id,sequence] of ids)this.write(generation,id,sequence,true);
  }
  private write(generation:number,id:string,sequence:number,track:boolean){
    const previous=this.prepared.query('SELECT session_id,receipt_json FROM presentation_receipts WHERE generation=? AND input_id=?')
      .get(generation,id) as {session_id:number;receipt_json:string}|null;
    const key=this.source.query('SELECT rowid,session_id FROM session_inputs WHERE id=?').get(id) as
      {rowid:number;session_id:number}|null;
    const receipt=key?readCompactReceipt(this.source,id):null;
    const encoded=receipt?JSON.stringify(receipt):null;
    if(previous?.receipt_json===encoded)return;
    if(key&&encoded){
      this.prepared.query(`INSERT INTO presentation_receipts
        (generation,session_id,input_id,input_rowid,receipt_json,revision,next_refresh_ms) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(generation,input_id) DO UPDATE SET
        session_id=excluded.session_id,input_rowid=excluded.input_rowid,
        receipt_json=excluded.receipt_json,revision=excluded.revision,
        next_refresh_ms=excluded.next_refresh_ms`)
        .run(generation,key.session_id,id,key.rowid,encoded,sequence,receipt?.nextRefreshAtMs??null);
    }else this.prepared.query('DELETE FROM presentation_receipts WHERE generation=? AND input_id=?').run(generation,id);
    const sessionId=key?.session_id??previous?.session_id;
    if(track&&sessionId)this.prepared.query(`INSERT INTO presentation_receipt_changes
      (generation,session_id,input_id,receipt_json,source_sequence) VALUES(?,?,?,?,?)`)
      .run(generation,sessionId,id,encoded,sequence);
  }
}

function position(database:Database,generation:number){
  return (database.query('SELECT COALESCE(MAX(change_id),0) AS n FROM presentation_receipt_changes WHERE generation=?')
    .get(generation) as {n:number}).n;
}
export function readPreparedReceiptWindow(database:Database,sessionId:number,canonicalHead:number,
  cursor:string|null,requestedLimit=PAGE){
  const limit=Math.min(PAGE,Math.max(1,requestedLimit));
  return database.transaction(()=>{
    const meta=database.query('SELECT generation,source_head,change_base,ready FROM presentation_receipt_meta WHERE singleton=1')
      .get() as {generation:number;source_head:number;change_base:number;ready:number}|null;
    if(!meta?.ready)return {operations:[] as PreparedReceipt[],nextCursor:null,asOf:'',coverage:unavailable};
    const head=position(database,meta.generation),p=cursor?decode(cursor):null;
    if(cursor&&(!p||p.v!==1||p.g!==meta.generation||p.s!==sessionId||p.h<meta.change_base||
      !Number.isSafeInteger(p.b)||!Number.isSafeInteger(p.h)||p.h>head))
      return {operations:[] as PreparedReceipt[],nextCursor:null,asOf:'',coverage:{complete:false,code:'reset' as const,appliedSequence:meta.source_head}};
    const before=p?.b??Number.MAX_SAFE_INTEGER;
    const rows=database.query(`SELECT input_rowid,receipt_json FROM presentation_receipts
      WHERE generation=? AND session_id=? AND input_rowid<? ORDER BY input_rowid DESC LIMIT ?`)
      .all(meta.generation,sessionId,before,limit+1) as {input_rowid:number;receipt_json:string}[];
    const selected=rows.slice(0,limit);
    const asOf=encode({v:1,g:meta.generation,s:sessionId,a:head,h:head});
    return {operations:selected.map(row=>JSON.parse(row.receipt_json) as PreparedReceipt),
      nextCursor:rows.length>limit&&selected.length?encode({v:1,g:meta.generation,s:sessionId,h:p?.h??head,b:selected.at(-1)!.input_rowid}):null,
      asOf,coverage:{complete:meta.source_head>=canonicalHead,appliedSequence:meta.source_head,
        ...(meta.source_head>=canonicalHead?{}:{code:'catching_up' as const})}};
  })();
}
export function readPreparedReceiptChanges(database:Database,sessionId:number,canonicalHead:number,
  token:string,requestedLimit=PAGE){
  const limit=Math.min(PAGE,Math.max(1,requestedLimit));
  return database.transaction(()=>{
    const meta=database.query('SELECT generation,source_head,change_base,ready FROM presentation_receipt_meta WHERE singleton=1')
      .get() as {generation:number;source_head:number;change_base:number;ready:number}|null;
    if(!meta?.ready)return {operations:[] as PreparedReceipt[],removed:[] as string[],asOf:'',hasMore:false,coverage:unavailable};
    const p=decode(token),head=position(database,meta.generation);
    if(!p||p.v!==1||p.g!==meta.generation||p.s!==sessionId||!Number.isSafeInteger(p.a)||
      !Number.isSafeInteger(p.h)||p.a<meta.change_base||p.a>head||p.h>head)
      return {operations:[] as PreparedReceipt[],removed:[] as string[],asOf:'',hasMore:false,
        coverage:{complete:false,code:'reset' as const,appliedSequence:meta.source_head}};
    const fixed=p.a===p.h?head:p.h;
    const rows=database.query(`SELECT change_id,input_id,receipt_json FROM presentation_receipt_changes
      WHERE generation=? AND session_id=? AND change_id>? AND change_id<=? ORDER BY change_id LIMIT ?`)
      .all(meta.generation,sessionId,p.a,fixed,limit) as {change_id:number;input_id:string;receipt_json:string|null}[];
    const after=rows.at(-1)?.change_id??fixed;
    return {operations:rows.flatMap(row=>row.receipt_json?[JSON.parse(row.receipt_json) as PreparedReceipt]:[]),
      removed:rows.flatMap(row=>row.receipt_json?[]:[row.input_id]),
      asOf:encode({v:1,g:meta.generation,s:sessionId,a:after,h:fixed}),hasMore:after<fixed,
      coverage:{complete:meta.source_head>=canonicalHead,appliedSequence:meta.source_head,
        ...(meta.source_head>=canonicalHead?{}:{code:'catching_up' as const})}};
  })();
}
