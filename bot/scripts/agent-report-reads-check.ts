import assert from 'node:assert/strict';
import {Database} from 'bun:sqlite';
import {reportSourceChain,reportWindow} from '../src/agent-report-reads';
import {classifyNativeReadRoute} from '../src/native-read-routes';

{
  assert.equal(classifyNativeReadRoute('GET','/sessions/v1/reports/chain/request:sample')?.domain,'read-worker');
  assert.equal(classifyNativeReadRoute('GET','/sessions/v1/reports/window')?.domain,'read-worker');
  const db=new Database(':memory:');
  db.exec(`CREATE TABLE session_inputs(id TEXT PRIMARY KEY,session_id INTEGER,source_input_id TEXT,source_run_id TEXT,
    origin TEXT,kind TEXT,created_at TEXT,payload_json TEXT);
    CREATE TABLE session_communication_requests(request_id TEXT PRIMARY KEY,payload_json TEXT,outcome TEXT,
      target_session_id INTEGER,created_at_ms INTEGER);
    CREATE TABLE session_owner_events(sequence INTEGER PRIMARY KEY,event_id TEXT,kind TEXT,created_at TEXT,payload_json TEXT);
    CREATE TABLE inbox_requests(request_id TEXT,topic_id TEXT,sources_json TEXT,dispatches_json TEXT);`);
  const reportA='capture:'+'a'.repeat(64),reportB='capture:'+'b'.repeat(64),unrelated='capture:'+'c'.repeat(64);
  const dispatch='f0e34d81-434f-4ca6-a2de-8e7c3d62f61d';
  const put=db.query('INSERT INTO session_inputs VALUES(?,?,?,?,?,?,?,?)');
  const capture=(id:string,file:string,client:string,at='2026-11-04 08:00:00')=>put.run(id,1,null,null,'human','input',at,
    JSON.stringify({attachments:[file],capture:{source:{metadata:{client}}}}));
  capture(reportA,'report-a','thinkering-bug-report');
  capture(reportB,'report-b','thinkering-bug-report','2026-11-04 08:01:00');
  capture(unrelated,'other','action-button');
  put.run('request:'+dispatch,2,unrelated,'run-1','agent','request','2026-11-04 09:00:00','{}');
  db.query('INSERT INTO session_communication_requests VALUES(?,?,?,?,?)').run(dispatch,'{"attachments":[]}',null,2,Date.parse('2026-11-04T09:00:00Z'));
  db.query('INSERT INTO inbox_requests VALUES(?,?,?,?)').run('req:a','topic-a',JSON.stringify([{inputId:reportA}]),JSON.stringify([{requestId:dispatch}]));
  db.query('INSERT INTO inbox_requests VALUES(?,?,?,?)').run('req:b','topic-b',JSON.stringify([{inputId:reportB}]),JSON.stringify([{requestId:dispatch}]));
  db.query('INSERT INTO session_owner_events VALUES(NULL,?,?,?,?)').run('post-old','post','2026-11-03 10:00:00',JSON.stringify({requestId:dispatch}));
  db.query('INSERT INTO session_owner_events VALUES(NULL,?,?,?,?)').run('post-1','post','2026-11-04 10:00:00',JSON.stringify({requestId:dispatch}));
  const chain=reportSourceChain(db,dispatch);
  assert.equal(chain.resolvedCapture,unrelated);
  assert.deepEqual(chain.inboxLinks.flatMap(link=>link.sources.filter(source=>source.inAppReport).map(source=>source.inputId)).sort(),[reportA,reportB]);
  assert.equal(chain.inboxLinks.every(link=>link.direct),true);
  const historical='11111111-2222-4333-8444-555555555555';
  put.run('request:'+historical,3,unrelated,'run-2','agent','request','2026-11-04 11:00:00','{}');
  db.query('INSERT INTO session_communication_requests VALUES(?,?,?,?,?)').run(historical,
    JSON.stringify({attachments:['report-a']}),'answered',3,Date.parse('2026-11-04T11:00:00Z'));
  assert.equal(reportSourceChain(db,historical).resolvedCapture,reportA);
  const window=reportWindow(db,'2026-11-04T06:00:23Z','2026-11-05T06:00:21Z');
  assert.equal(window.reports.length,2);
  assert.equal(window.reports.every(report=>report.requests.some(request=>request.id===dispatch&&request.answeredInThread)),true);
  assert.equal(window.reports[0]?.requests.find(request=>request.id===dispatch)?.threadPosts[0]?.eventId,'post-1');
  assert.equal(window.reports[0]?.requests.find(request=>request.id===dispatch)?.threadPosts.length,1);
  db.close();
}
console.log('Agent report read check passed.');
