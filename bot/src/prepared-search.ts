import type {Database} from 'bun:sqlite';

/** Rebuildable text index owned by the presentation worker, never by the command owner. */
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

export class PreparedSearchIndex {
 constructor(private readonly db:Database,initialize=true){
  if(!initialize)return;
  db.exec(`CREATE TABLE IF NOT EXISTS prepared_search_documents(
    id INTEGER PRIMARY KEY,document_key TEXT NOT NULL UNIQUE,session_id INTEGER NOT NULL,
    kind TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,folded TEXT NOT NULL,metadata TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS prepared_search_session ON prepared_search_documents(session_id,id);
  CREATE VIRTUAL TABLE IF NOT EXISTS prepared_search_text USING fts5(folded,tokenize='trigram');
  CREATE VIRTUAL TABLE IF NOT EXISTS prepared_search_short USING fts5(tokens,detail=none);`);
 }
 upsert(document:PreparedSearchDocument){
  const {text,...metadata}=document,folded=text.toLocaleLowerCase(),encoded=JSON.stringify(metadata);
  this.db.transaction(()=>{
   const prior=this.db.query('SELECT id,text,metadata FROM prepared_search_documents WHERE document_key=?').get(document.key) as {id:number;text:string;metadata:string}|null;
   if(prior?.text===text&&prior.metadata===encoded)return;
   if(prior?.text===text){
    this.db.query('UPDATE prepared_search_documents SET session_id=?,kind=?,role=?,metadata=? WHERE id=?')
     .run(document.sessionId,document.kind,document.role,encoded,prior.id);
    return;
   }
   const id=prior?.id??Number(this.db.query('INSERT INTO prepared_search_documents(document_key,session_id,kind,role,text,folded,metadata) VALUES(?,?,?,?,?,?,?)')
    .run(document.key,document.sessionId,document.kind,document.role,text,folded,encoded).lastInsertRowid);
   if(prior){
    this.db.query('DELETE FROM prepared_search_text WHERE rowid=?').run(id);
    this.db.query('DELETE FROM prepared_search_short WHERE rowid=?').run(id);
    this.db.query('UPDATE prepared_search_documents SET session_id=?,kind=?,role=?,text=?,folded=?,metadata=? WHERE id=?')
     .run(document.sessionId,document.kind,document.role,text,folded,encoded,id);
   }
   this.db.query('INSERT INTO prepared_search_text(rowid,folded) VALUES(?,?)').run(id,folded);
   // Native trigram indexing cannot search one/two-character strings (including “AI”).
   // A compact set of encoded short substrings preserves that behavior without a scan.
   this.db.query('INSERT INTO prepared_search_short(rowid,tokens) VALUES(?,?)').run(id,shortTokens(folded));
  })();
 }
 remove(key:string){
  this.db.transaction(()=>{
   const row=this.db.query('SELECT id FROM prepared_search_documents WHERE document_key=?').get(key) as {id:number}|null;
   if(!row)return;
   this.db.query('DELETE FROM prepared_search_text WHERE rowid=?').run(row.id);
   this.db.query('DELETE FROM prepared_search_short WHERE rowid=?').run(row.id);
   this.db.query('DELETE FROM prepared_search_documents WHERE id=?').run(row.id);
  })();
 }
 search(query:string,limit:number,includeTools=false){
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('INVALID_SEARCH_WINDOW');
  const terms=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if(!terms.length||query.length>2000)throw new Error('INVALID_SEARCH_QUERY');
  const long=terms.filter(term=>[...term].length>=3),short=terms.filter(term=>[...term].length<3);
  const table=long.length?'prepared_search_text':'prepared_search_short';
  const expression=(long.length?long.map(quote):short.map(term=>quote(gram([...term])))).join(' AND ');
  const window=Math.min(1000,Math.max(100,limit*10));
  // Search the postings, then inspect a finite candidate window. A common word can have
  // millions of hits; it must not sort/materialize every matching message to show twenty.
  const ids=this.db.query(`SELECT rowid AS id FROM ${table} WHERE ${table} MATCH ? ORDER BY rowid DESC LIMIT ?`)
   .all(expression,window+1) as {id:number}[];
  const selected=new Map<number,PreparedSearchHit>();
  let examined=0;
  for(const {id} of ids.slice(0,window)){
   examined++;
   const row=this.db.query(`SELECT metadata,substr(text,1,6000) AS text,length(text)>6000 AS truncated,
      substr(text,max(1,instr(folded,?)-80),320) AS excerpt,
      ${terms.map(()=>'instr(folded,?)>0').join(' AND ')} AS matches
      FROM prepared_search_documents WHERE id=? ${includeTools?'':"AND role<>'tool'"}`).get(terms[0],...terms,id) as {metadata:string;text:string;excerpt:string;truncated:number;matches:number}|null;
   if(!row?.matches)continue;
   const meta=JSON.parse(row.metadata) as Omit<PreparedSearchDocument,'text'>;
   if(selected.has(meta.sessionId))continue;
   const {key:_key,...reference}=meta;
   selected.set(meta.sessionId,{...reference,text:row.text,snippet:snippet(row.excerpt,terms),truncated:!!row.truncated});
   if(selected.size>=limit)break;
  }
  const hasMore=examined<ids.length;
  return {hits:[...selected.values()],examined,hasMore,
   omissions:hasMore?['More indexed word matches exist beyond this bounded result window.']:[]};
 }
}
