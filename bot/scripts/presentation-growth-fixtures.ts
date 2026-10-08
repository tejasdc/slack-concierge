import {Database} from 'bun:sqlite';
import {readPreparedMessages,readPreparedInboxDetailPart} from '../src/presentation-message-reader';
import {PreparedReceipts,readPreparedReceiptWindow,readPreparedReceiptChanges} from '../src/prepared-receipts';
import {observedDatabase,observeStorageOperation,withStorageReadBudget,type StorageWork} from '../src/storage-observation';

const assert=(truth:unknown,description:string)=>{if(!truth)throw new Error(description);};
const maxBudget={maxCalls:128,maxRows:180,maxResultBytes:524288};
const measured=<T>(read:()=>T)=>{
  let work:StorageWork|null=null;
  const result=observeStorageOperation('fixture',()=>withStorageReadBudget(maxBudget,read),value=>{work=value;});
  return {result,work:work!};
};
function messageFixture(unrelated:number){
  const raw=new Database(':memory:');
  raw.exec(`CREATE TABLE presentation_message_meta(singleton INTEGER PRIMARY KEY,generation INTEGER,event_watermark INTEGER,ready INTEGER);
    INSERT INTO presentation_message_meta VALUES(1,1,100000,1);
    CREATE TABLE presentation_messages(generation INTEGER,session_id INTEGER,root_input_id TEXT,topic_id TEXT,
      event_sequence INTEGER,message_id TEXT,input_id TEXT,created_at TEXT,PRIMARY KEY(generation,event_sequence));
    CREATE INDEX page ON presentation_messages(generation,session_id,root_input_id,event_sequence DESC);
    CREATE UNIQUE INDEX exact_message ON presentation_messages(generation,session_id,message_id);
    CREATE TABLE presentation_message_detail_chunks(generation INTEGER,event_sequence INTEGER,part INTEGER,
      content TEXT,digest TEXT,PRIMARY KEY(generation,event_sequence,part));`);
  const insert=raw.query('INSERT INTO presentation_messages VALUES(1,?,?,NULL,?,?,?,?)');
  raw.transaction(()=>{
    for(let i=1;i<=unrelated;i++)insert.run(2,'other',i,`other-${i}`,`other-${i}`,'2026-10-08');
    for(let i=1;i<=51;i++)insert.run(1,'root',unrelated+i,`target-${i}`,`target-${i}`,'2026-10-08');
  })();
  raw.query('INSERT INTO presentation_message_detail_chunks VALUES(1,?,?,?,?)').run(unrelated+51,0,'full text','digest');
  raw.query('INSERT INTO presentation_message_detail_chunks VALUES(1,?,?,?,?)').run(unrelated+51,1,'more text','digest');
  return observedDatabase(raw);
}
function receiptFixture(unrelated:number){
  const raw=new Database(':memory:');new PreparedReceipts(raw,raw);
  raw.query('UPDATE presentation_receipt_meta SET generation=1,source_head=100000,ready=1 WHERE singleton=1').run();
  const card=(id:number,sessionId:number)=>JSON.stringify({operationId:`receipt-${id}`,sessionId:`concierge:${sessionId}`,
    textPreview:'brief',detail:{operationId:`receipt-${id}`}});
  const insert=raw.query(`INSERT INTO presentation_receipts
    (generation,session_id,input_id,input_rowid,receipt_json,revision) VALUES(1,?,?,?,?,?)`);
  const change=raw.query('INSERT INTO presentation_receipt_changes(generation,session_id,input_id,receipt_json,source_sequence) VALUES(1,?,?,?,?)');
  raw.transaction(()=>{
    for(let i=1;i<=unrelated;i++){insert.run(2,`other-${i}`,i,card(i,2),i);change.run(2,`other-${i}`,card(i,2),i);}
    for(let i=1;i<=51;i++){insert.run(1,`target-${i}`,unrelated+i,card(i,1),unrelated+i);change.run(1,`target-${i}`,card(i,1),unrelated+i);}
  })();
  raw.query('UPDATE presentation_receipt_meta SET change_base=0 WHERE singleton=1').run();
  return observedDatabase(raw);
}
function boundedGrowth<T>(small:()=>{result:T;work:StorageWork},large:()=>{result:T;work:StorageWork},same:(a:T,b:T)=>boolean){
 const first=small(),second=large();
 assert(same(first.result,second.result),'unrelated history changed the requested result');
 assert(second.work.db_calls<=first.work.db_calls+1,'database calls grew with unrelated history');
 assert(second.work.db_rows<=first.work.db_rows+1,'returned rows grew with unrelated history');
 assert(second.work.db_result_bytes<=first.work.db_result_bytes+1024,'read bytes grew with unrelated history');
}
const messageWindow=()=>{
  const small=messageFixture(300),large=messageFixture(3000);
  boundedGrowth(()=>measured(()=>readPreparedMessages(small,1,'root',20,null,100000)),
    ()=>measured(()=>readPreparedMessages(large,1,'root',20,null,100000)),
    (a,b)=>a.keys.length===20&&b.keys.length===20&&a.coverage.complete&&b.coverage.complete);
};
const messageDetail=()=>{
  const small=messageFixture(300),large=messageFixture(3000);
  boundedGrowth(()=>measured(()=>readPreparedInboxDetailPart(small,1,'target-51',0)),
    ()=>measured(()=>readPreparedInboxDetailPart(large,1,'target-51',0)),
    (a,b)=>a?.content==='full text'&&b?.content==='full text'&&a.nextPart===1&&b.nextPart===1);
};
const receiptWindow=()=>{
  const small=receiptFixture(300),large=receiptFixture(3000);
  boundedGrowth(()=>measured(()=>readPreparedReceiptWindow(small,1,100000,null,40)),
    ()=>measured(()=>readPreparedReceiptWindow(large,1,100000,null,40)),
    (a,b)=>a.operations.length===40&&b.operations.length===40&&a.operations[0]?.operationId==='receipt-51'&&
      b.operations[0]?.operationId==='receipt-51'&&!!a.nextCursor&&!!b.nextCursor);
};
const receiptChanges=()=>{
  const small=receiptFixture(300),large=receiptFixture(3000);
  const smallPosition=Buffer.from(JSON.stringify({v:1,g:1,s:1,a:300,h:300})).toString('base64url');
  const largePosition=Buffer.from(JSON.stringify({v:1,g:1,s:1,a:3000,h:3000})).toString('base64url');
  boundedGrowth(()=>measured(()=>readPreparedReceiptChanges(small,1,100000,smallPosition,40)),
    ()=>measured(()=>readPreparedReceiptChanges(large,1,100000,largePosition,40)),
    (a,b)=>a.operations.length===40&&b.operations.length===40&&a.operations[0]?.operationId==='receipt-1'&&
      b.operations[0]?.operationId==='receipt-1'&&a.hasMore&&b.hasMore);
};
export const READ_GROWTH_FIXTURES={
  'messages-window-growth':messageWindow,
  'messages-detail-growth':messageDetail,
  'receipts-window-growth':receiptWindow,
  'receipts-changes-growth':receiptChanges,
};
