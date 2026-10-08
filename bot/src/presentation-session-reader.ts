import {Database} from 'bun:sqlite';
import {existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {db} from './state';
import {observedDatabase} from './storage-observation';
import {readPreparedSessionChanges,readPreparedSessionWindow,type SessionWindow} from './prepared-session-cards';
import {readPreparedInboxAttention} from './prepared-topics';
import type {SessionSpace} from './session-space';

let connection:Database|null=null;
function prepared():Database|null {
  const directory=process.env.CONCIERGE_STATE_DIR;
  if(!directory)return null;
  const path=join(realpathSync(directory),'presentation.db');
  if(!existsSync(path))return null;
  if(!connection){
    const raw=new Database(path,{readonly:true});
    raw.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
    connection=observedDatabase(raw);
  }
  return connection.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='presentation_session_meta' LIMIT 1").get()
    ?connection:null;
}
const canonicalHead=()=>Number((db.query('SELECT COALESCE(MAX(sequence),0) AS n FROM presentation_change_log')
  .get() as {n:number}).n);
const indexing:SessionWindow={cards:[],nextCursor:null,asOf:'',coverage:{complete:false,code:'presentation_indexing',appliedSequence:0}};

export function preparedSessionWindow(options:{space:SessionSpace;needsAttention?:boolean;workflowId?:string|null;cursor?:string|null;limit?:number}):SessionWindow {
  const reader=prepared();
  return reader?readPreparedSessionWindow(reader,{...options,canonicalHead:canonicalHead()}):indexing;
}
export function preparedSessionChanges(cursor:string,space:SessionSpace,limit?:number) {
  const reader=prepared();
  return reader?readPreparedSessionChanges(reader,cursor,space,canonicalHead(),limit):
    {changes:[],nextCursor:null,asOf:'',coverage:{complete:false,code:'presentation_indexing',appliedSequence:0}};
}
export function preparedInboxAttention(sessionId:number,cursor:string|null=null,limit=20){
 const reader=prepared();
 return reader?readPreparedInboxAttention(reader,sessionId,canonicalHead(),cursor,limit):
  {needs:[],needsAttention:null,total:null,maxGeneration:null,nextCursor:null,
   coverage:{complete:false,code:'presentation_indexing',appliedSequence:0}};
}
