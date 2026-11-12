import type {Database} from 'bun:sqlite';

/**
 * Rebuildable word index owned by the presentation worker, never by the command owner.
 *
 * Size rule (docs/architecture/PREPARED-SEARCH.md): every indexed text exists once, in
 * search_documents. The trigram index reads it as external content and the short-string
 * index keeps no content at all. Tool calls and results are not indexed here: thnkr.ing's
 * archive index already holds every provider transcript's tool entries and the owner's search
 * merges both, so a second copy of tool output only cost disk.
 */
export type PreparedSearchDocument={
 key:string;sessionId:number;kind:'input'|'message'|'session';eventId:string;
 sourceId:string;sourceVersion:string|null;textHash:string|null;
 role:string;text:string;at:string|null;ordinal:number;detailKey?:string;
};
export type PreparedSearchHit=Omit<PreparedSearchDocument,'key'|'text'>&{
 text:string;snippet:string;truncated:boolean;
};
const quote=(term:string)=>'"'+term.replaceAll('"','""')+'"';
export const gram=(chars:string[])=>'g'+chars.map(char=>char.codePointAt(0)!.toString(16)).join('z');
export function shortTokens(text:string){
 const tokens=new Set<string>();let previous:string|undefined;
 for(const char of text){tokens.add(gram([char]));if(previous!==undefined)tokens.add(gram([previous,char]));previous=char;}
 return [...tokens].join(' ');
}
function snippet(text:string,terms:string[]){
 const lower=text.toLocaleLowerCase(),positions=terms.map(term=>lower.indexOf(term)).filter(value=>value>=0);
 const at=positions.length?Math.min(...positions):0,start=Math.max(0,at-80),end=Math.min(text.length,at+240);
 return (start?'… ':'')+text.slice(start,end).replace(/\s+/g,' ')+(end<text.length?' …':'');
}
/** Tool evidence is searched in the archive index; see the size rule above. */
export const indexedRole=(role:string)=>role!=='tool';

export class PreparedSearchIndex {
 private indexedChangesSinceMerge=0;
 /** Text bytes written to the index since the caller last read it; paces bulk backfills. */
 indexedBytes=0;
 constructor(private readonly db:Database,initialize=true){
  if(!initialize)return;
  db.exec(`CREATE TABLE IF NOT EXISTS search_documents(
    id INTEGER PRIMARY KEY,document_key TEXT NOT NULL UNIQUE,ordinal INTEGER NOT NULL,text TEXT NOT NULL,metadata TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS search_text USING fts5(text,content='search_documents',content_rowid='id',tokenize='trigram');
  CREATE VIRTUAL TABLE IF NOT EXISTS search_short USING fts5(tokens,content='',contentless_delete=1,detail=none);
  CREATE TABLE IF NOT EXISTS search_meta(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),ready INTEGER NOT NULL,backfill_json TEXT
  );
  INSERT OR IGNORE INTO search_meta(singleton,ready,backfill_json) VALUES(1,0,'{"phase":"legacy"}');`);
  // FTS5's default crisis merge rewrites whole, accumulated segments inside the
  // insertion that crosses its threshold. Give merging its own bounded worker budget
  // instead of charging an arbitrary source event (2026-11-01 write-burst record).
  db.query("INSERT INTO search_text(search_text,rank) VALUES('automerge',0)").run();
  db.query("INSERT INTO search_text(search_text,rank) VALUES('crisismerge',2147483647)").run();
 }
 /** Called between replay batches, after a fixed interval or indexed change count. */
 get mergeDue(){return this.indexedChangesSinceMerge>=250;}
 maintain(pageBudget:number){
  if(!Number.isSafeInteger(pageBudget)||pageBudget<1)throw new Error('INVALID_SEARCH_MERGE_BUDGET');
  this.db.query("INSERT INTO search_text(search_text,rank) VALUES('merge',?)").run(pageBudget);
  this.indexedChangesSinceMerge=0;
 }
 private unindex(id:number,text:string){
  // External content: the trigram index must be told the exact text it indexed.
  this.db.query("INSERT INTO search_text(search_text,rowid,text) VALUES('delete',?,?)").run(id,text);
  this.db.query('DELETE FROM search_short WHERE rowid=?').run(id);
 }
 upsert(document:PreparedSearchDocument){
  if(!indexedRole(document.role)){this.remove(document.key);return;}
  const {text,...metadata}=document,encoded=JSON.stringify(metadata);
  let indexed=false;
  this.db.transaction(()=>{
   const prior=this.db.query('SELECT id,ordinal,text,metadata FROM search_documents WHERE document_key=?')
    .get(document.key) as {id:number;ordinal:number;text:string;metadata:string}|null;
   // A backfill can reach an older version after catch-up indexed a newer one.
   if(prior&&prior.ordinal>document.ordinal)return;
   if(prior?.text===text){
    if(prior.metadata!==encoded)this.db.query('UPDATE search_documents SET ordinal=?,metadata=? WHERE id=?').run(document.ordinal,encoded,prior.id);
    return;
   }
   let id:number;
   if(prior){
    id=prior.id;this.unindex(id,prior.text);
    this.db.query('UPDATE search_documents SET ordinal=?,text=?,metadata=? WHERE id=?').run(document.ordinal,text,encoded,id);
   }else id=Number(this.db.query('INSERT INTO search_documents(document_key,ordinal,text,metadata) VALUES(?,?,?,?)')
    .run(document.key,document.ordinal,text,encoded).lastInsertRowid);
   this.db.query('INSERT INTO search_text(rowid,text) VALUES(?,?)').run(id,text);
   // Native trigram indexing cannot search one/two-character strings (including “AI”).
   // A compact, contentless set of encoded short substrings preserves that without a scan.
   this.db.query('INSERT INTO search_short(rowid,tokens) VALUES(?,?)').run(id,shortTokens(text.toLocaleLowerCase()));
   indexed=true;
  })();
  if(indexed){this.indexedChangesSinceMerge++;this.indexedBytes+=Buffer.byteLength(text);}
 }
 remove(key:string){
  let removed=false;
  this.db.transaction(()=>{
   const row=this.db.query('SELECT id,text FROM search_documents WHERE document_key=?').get(key) as {id:number;text:string}|null;
   if(!row)return;
   this.unindex(row.id,row.text);
   this.db.query('DELETE FROM search_documents WHERE id=?').run(row.id);
   removed=true;
  })();
  if(removed)this.indexedChangesSinceMerge++;
 }
 /** includeTools is accepted for the wire contract; tool evidence comes from the archive index. */
 search(query:string,limit:number,_includeTools=false){
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('INVALID_SEARCH_WINDOW');
  const terms=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if(!terms.length||query.length>2000)throw new Error('INVALID_SEARCH_QUERY');
  const long=terms.filter(term=>[...term].length>=3),short=terms.filter(term=>[...term].length<3);
  const shortExpression=short.map(term=>quote(gram([...term]))).join(' AND ');
  const table=long.length?'search_text':'search_short';
  const expression=long.length?long.map(quote).join(' AND '):shortExpression;
  const window=Math.min(1000,Math.max(100,limit*10));
  // Search the postings, then inspect a finite candidate window. A common word can have
  // millions of hits; it must not sort/materialize every matching message to show twenty.
  // A trigram phrase match is an exact case-folded substring match, so long terms need no
  // second check; short terms beside them are checked in the short index by rowid.
  const ids=this.db.query(`SELECT rowid AS id FROM ${table} WHERE ${table} MATCH ? ORDER BY rowid DESC LIMIT ?`)
   .all(expression,window+1) as {id:number}[];
  const shortCheck=long.length&&short.length
   ?this.db.query('SELECT 1 AS hit FROM search_short WHERE search_short MATCH ? AND rowid=?'):null;
  const read=this.db.query(`SELECT metadata,substr(text,1,6000) AS text,length(text)>6000 AS truncated,
     substr(text,max(1,instr(lower(text),?)-80),320) AS excerpt FROM search_documents WHERE id=?`);
  const selected=new Map<number,PreparedSearchHit>();
  let examined=0;
  for(const {id} of ids.slice(0,window)){
   examined++;
   if(shortCheck&&!shortCheck.get(shortExpression,id))continue;
   const row=read.get(terms[0]!,id) as {metadata:string;text:string;excerpt:string;truncated:number}|null;
   if(!row)continue;
   const meta=JSON.parse(row.metadata) as Omit<PreparedSearchDocument,'text'>;
   if(!indexedRole(meta.role)||selected.has(meta.sessionId))continue;
   const {key:_key,...reference}=meta;
   selected.set(meta.sessionId,{...reference,text:row.text,snippet:snippet(row.excerpt,terms),truncated:!!row.truncated});
   if(selected.size>=limit)break;
  }
  const hasMore=examined<ids.length;
  return {hits:[...selected.values()],examined,hasMore,
   omissions:hasMore?['More indexed word matches exist beyond this bounded result window.']:[]};
 }
}
