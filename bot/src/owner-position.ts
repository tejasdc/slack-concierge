import {Database} from 'bun:sqlite';
import {existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {presentationHead} from './presentation-changes';
import {observedDatabase} from './storage-observation';
import {isTransientDatabaseError} from './database-retry';
import type {PresentationReaderName} from './presentation-reader-contracts';

/**
 * A minimum owner write position lets a caller that just wrote ask a prepared reader whether its
 * projection already includes that write. Every owner write response names the ledger's change
 * position after the write committed; a prepared read carrying it as `minOwnerPosition` either
 * answers normally or says, at once, that this exact projection has not reached it yet.
 *
 * Why a write position and not the moving head: waiting for the ledger head held every Threads
 * read up to four seconds because agent activity moves the head constantly (Nov 11-12, 2026).
 * One write's position stops moving, so a caller waits only for its own write. The read never
 * waits inside the owner: the worker's ordinary batches take 0.7 to 3.6 seconds, and holding the
 * read would reintroduce that wait for every caller. The caller keeps its own display and asks
 * again after `retryAfterMs`.
 */
export const OWNER_POSITION_HEADER='x-concierge-owner-position';
export const OWNER_POSITION_APPLIED_HEADER='x-concierge-owner-position-applied';
export const MIN_OWNER_POSITION_PARAM='minOwnerPosition';
export const OWNER_POSITION_RETRY_MS=500;

/** Each gated reader names the projection whose checkpoint must cover the write. */
const PROJECTION_OF:Partial<Record<PresentationReaderName,{projection:string;meta:string}>>={
 sessionWindow:{projection:'session-cards',meta:'presentation_session_meta'},
 sessionChanges:{projection:'session-cards',meta:'presentation_session_meta'},
 receiptWindow:{projection:'receipts',meta:'presentation_receipt_meta'},
 receiptChanges:{projection:'receipts',meta:'presentation_receipt_meta'},
 topicWindow:{projection:'topics',meta:'presentation_topics_meta'},
 topicIncoming:{projection:'topics',meta:'presentation_topics_meta'},
 topicChanges:{projection:'topics',meta:'presentation_topics_meta'},
 topicResolution:{projection:'topics',meta:'presentation_topics_meta'},
 topicOverview:{projection:'topics',meta:'presentation_topics_meta'},
 topicItems:{projection:'topics',meta:'presentation_topics_meta'},
 topicQuestions:{projection:'topics',meta:'presentation_topics_meta'},
 inboxAttention:{projection:'topics',meta:'presentation_topics_meta'},
};
export const positionedReaders=()=>Object.keys(PROJECTION_OF) as PresentationReaderName[];

let ledger:string|null=null;
function ledgerId(db:Database):string|null {
 if(ledger)return ledger;
 try {
  const row=db.query('SELECT ledger_id FROM presentation_change_ledger WHERE singleton=1').get() as {ledger_id:string}|null;
  ledger=row?.ledger_id??null;
 } catch { return null; }
 return ledger;
}
const format=(id:string,sequence:number)=>`v1.${id}.${sequence}`;
export function parseOwnerPosition(value:string):{ledger:string;sequence:number}|null {
 const match=/^v1\.([0-9a-f]{16})\.(\d{1,15})$/.exec(value);
 if(!match)return null;
 const sequence=Number(match[2]);
 return Number.isSafeInteger(sequence)?{ledger:match[1]!,sequence}:null;
}
/** The committed change position after a write; null on an owner without a ledger identity yet. */
export function currentOwnerPosition(db:Database):string|null {
 const id=ledgerId(db);
 return id?format(id,presentationHead(db)):null;
}
/** Adds the write position to a response. Responses built by `fetch` have immutable headers. */
export function withOwnerPosition(response:Response,db:Database):Response {
 const position=currentOwnerPosition(db);
 if(!position)return response;
 try { response.headers.set(OWNER_POSITION_HEADER,position); return response; }
 catch {
  const headers=new Headers(response.headers);headers.set(OWNER_POSITION_HEADER,position);
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
 }
}

let connection:Database|null=null;
function prepared():Database|null {
 if(connection)return connection;
 const directory=process.env.CONCIERGE_STATE_DIR;
 if(!directory)return null;
 const path=join(realpathSync(directory),'presentation.db');
 if(!existsSync(path))return null;
 let raw:Database|null=null;
 try {
  raw=new Database(path,{readonly:true});
  raw.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
  connection=observedDatabase(raw);
  return connection;
 } catch(error) {
  raw?.close();
  if(isTransientDatabaseError(error))return null;
  throw error;
 }
}
function applied(meta:string):number|null {
 const reader=prepared();
 if(!reader)return null;
 try {
  const row=reader.query(`SELECT ready,source_head FROM ${meta} WHERE singleton=1`).get() as {ready:number;source_head:number}|null;
  return row?.ready?row.source_head:null;
 } catch(error) {
  // A projection whose table is not created yet is indexing; its own reader says so.
  if(isTransientDatabaseError(error)||/no such table/.test(String(error)))return null;
  throw error;
 }
}
const json=(body:unknown,status:number,headers:Record<string,string>={})=>
 Response.json(body,{status,headers:{'cache-control':'no-store',...headers}});

export type OwnerPositionGate={response:Response}|{appliedHeader:string|null}|null;
/**
 * Checks `minOwnerPosition` on a prepared read before the reader runs. Null means the read carried
 * no position. A refusal or not-ready answer is returned as `response`; otherwise the reader runs
 * and its response carries the applied position.
 */
export function ownerPositionGate(db:Database,url:URL,reader:PresentationReaderName|null):OwnerPositionGate {
 const value=url.searchParams.get(MIN_OWNER_POSITION_PARAM);
 if(value===null)return null;
 const required=parseOwnerPosition(value);
 if(!required)return {response:json({error:{code:'OWNER_POSITION_INVALID',message:'minOwnerPosition must be a position returned by this owner.'}},400)};
 const target=reader?PROJECTION_OF[reader]:undefined;
 if(!target)return {response:json({error:{code:'OWNER_POSITION_UNSUPPORTED',
  message:'This read is not a prepared receipt, session-card or topic read; it does not accept minOwnerPosition.'}},400)};
 const id=ledgerId(db);
 // A position from another owner's ledger, or beyond this ledger's committed head, cannot be
 // reached here. Comparing it as a number would leave the caller waiting for nothing.
 if(!id||required.ledger!==id||required.sequence>presentationHead(db))
  return {response:json({error:{code:'OWNER_POSITION_FOREIGN',message:'This position was not issued by this owner\'s ledger; read without it.'}},409)};
 const head=applied(target.meta);
 // An unprepared projection answers through its own reader, which already reports indexing.
 if(head===null)return {appliedHeader:null};
 if(head>=required.sequence)return {appliedHeader:format(id,head)};
 return {response:json({notReady:{code:'OWNER_POSITION_PENDING',projection:target.projection,
  requiredPosition:value,appliedPosition:format(id,head),retryAfterMs:OWNER_POSITION_RETRY_MS}},200,
  {[OWNER_POSITION_APPLIED_HEADER]:format(id,head)})};
}
