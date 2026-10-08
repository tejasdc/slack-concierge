import {Database} from 'bun:sqlite';
import {existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {db} from './state';
import {observedDatabase} from './storage-observation';
import {presentationHead} from './presentation-changes';
import {readPreparedReceiptChanges,readPreparedReceiptWindow} from './prepared-receipts';

let connection:Database|null=null;
function prepared():Database|null{
  const stateDir=process.env.CONCIERGE_STATE_DIR;
  if(!stateDir)return null;
  const path=join(realpathSync(stateDir),'presentation.db');
  if(!existsSync(path))return null;
  if(!connection){
    const raw=new Database(path,{readonly:true});
    raw.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
    connection=observedDatabase(raw);
  }
  return connection.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='presentation_receipt_meta' LIMIT 1").get()
    ?connection:null;
}
export function preparedReceiptWindow(sessionId:number,cursor:string|null,limit:number){
  const reader=prepared();
  return reader?readPreparedReceiptWindow(reader,sessionId,presentationHead(db),cursor,limit):
    {operations:[],nextCursor:null,asOf:'',coverage:{complete:false,code:'presentation_indexing',appliedSequence:0}};
}
export function preparedReceiptChanges(sessionId:number,after:string,limit:number){
  const reader=prepared();
  return reader?readPreparedReceiptChanges(reader,sessionId,presentationHead(db),after,limit):
    {operations:[],removed:[],asOf:'',hasMore:false,coverage:{complete:false,code:'presentation_indexing',appliedSequence:0}};
}
