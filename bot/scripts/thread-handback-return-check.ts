import assert from 'node:assert/strict';
import {Database} from 'bun:sqlite';
import {returnsToRequester,threadOnlyReturnInputSql} from '../src/inbox-request-root';

const database=new Database(':memory:');
for(const table of ['session_communication','session_peer']){
  database.exec(`CREATE TABLE ${table}_requests (request_id TEXT,source_session_id INTEGER,thread_root_input_id TEXT,payload_json TEXT)`);
  database.exec(`CREATE TABLE ${table}_events (event_id TEXT,request_id TEXT,kind TEXT,payload_json TEXT)`);
}
database.exec('CREATE TABLE session_inputs (id TEXT,request_id TEXT,session_id INTEGER,origin TEXT)');

for(const [table,kind,requestedEffect,result,expectedReturn] of [
  ['session_communication','final','work',{workDisposition:'completed'},false],
  ['session_peer','final','informational',{outcome:'answered'},false],
  ['session_communication','final','work',{workDisposition:'failed'},true],
  ['session_peer','final','work',{workDisposition:'needs_decision'},true],
  ['session_communication','final','work',{},true],
  ['session_peer','final','informational',{outcome:'failed'},true],
  ['session_communication','final','work',{outcome:'canceled',output:{stoppedBy:'tejas'}},false],
  ['session_peer','overdue','work',{promptAnswerOverdue:true},true],
  ['session_communication','final','work',{workDisposition:'completed',handBack:'too-loaded'},true],
  ['session_peer','final','work',{workDisposition:'failed',handBack:'not-my-subject'},true],
  ['session_peer','progress','work',{},false],
] as const){
  const requestId=`${table}:${kind}:${requestedEffect}:${JSON.stringify(result)}`;
  const eventId=`event:${requestId}`;
  const request={thread_root_input_id:'thread:fixture',payload_json:JSON.stringify({requestedEffect})};
  const event={kind,payload_json:JSON.stringify(result)};
  database.query(`INSERT INTO ${table}_requests VALUES(?,?,?,?)`).run(requestId,7,request.thread_root_input_id,request.payload_json);
  database.query(`INSERT INTO ${table}_events VALUES(?,?,?,?)`).run(eventId,requestId,event.kind,event.payload_json);
  database.query('INSERT INTO session_inputs VALUES(?,?,?,?)').run(`return:${eventId}`,requestId,7,'service');
  assert.equal(returnsToRequester(request,event),expectedReturn,requestId);
  const refused=database.query(`SELECT 1 FROM session_inputs input WHERE input.id=? AND ${threadOnlyReturnInputSql('input')}`).get(`return:${eventId}`);
  assert.equal(!!refused,!expectedReturn,`${requestId}: queue guard`);
}
database.close();
console.log('Thread completion stays quiet; failures, decisions, uncertainty, overdue answers and hand-backs return on server and peer.');
