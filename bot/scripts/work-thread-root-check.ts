import {Database} from 'bun:sqlite';
import {turnTopicRootIn} from '../src/work-thread-root';

// A watch wake, a report-back and a request each reach his thread through the retained links the
// owner uses; the weekly allowance report counts them by this same rule.
const db=new Database(':memory:');
db.exec(`CREATE TABLE session_inputs(id TEXT PRIMARY KEY,session_id INTEGER,scope TEXT,action_id TEXT,kind TEXT,origin TEXT,payload_json TEXT,
    turn_id INTEGER,steering_id INTEGER,source_input_id TEXT,source_run_id TEXT,request_id TEXT);
  CREATE TABLE turns(id INTEGER PRIMARY KEY,session_id INTEGER,native_run_id TEXT);
  CREATE TABLE inbox_topic_roots(root_input_id TEXT PRIMARY KEY,topic_id TEXT);
  CREATE TABLE session_communication_requests(request_id TEXT PRIMARY KEY,source_session_id INTEGER,source_turn_id INTEGER,source_input_id TEXT,
    target_session_id INTEGER,target_input_id TEXT,thread_root_input_id TEXT,topic_root_input_id TEXT,payload_json TEXT,created_at_ms INTEGER);
  CREATE TABLE session_peer_requests(request_id TEXT,source_session_id INTEGER,source_input_id TEXT,source_turn_id INTEGER,payload_json TEXT);
  CREATE TABLE session_input_author_corrections(input_id TEXT PRIMARY KEY);
  CREATE TABLE session_peer_deliveries(target_input_id TEXT,peer TEXT,origin_session_id TEXT,origin_input_id TEXT,origin_run_id TEXT,requested_effect TEXT,origin_provenance_json TEXT);`);
const input=db.query(`INSERT INTO session_inputs(id,session_id,scope,action_id,kind,origin,payload_json,turn_id,source_input_id,source_run_id,request_id)
  VALUES(?,?,?,?,?,?,'{}',?,?,?,?)`);
db.query('INSERT INTO inbox_topic_roots VALUES(?,?)').run('capture:his','topic:his');
db.exec("INSERT INTO turns VALUES(1,1,'run-inbox'),(2,2,'run-worker')");
input.run('capture:his',1,'s','a1','input','human',1,null,null,null);
// The Inbox asks a worker; its request names the thread.
db.query(`INSERT INTO session_communication_requests VALUES('one',1,1,'capture:his',2,'request:one','capture:his','capture:his',?,1)`)
  .run(JSON.stringify({requestedEffect:'work'}));
input.run('request:one',2,'s','a2','input','agent',2,'capture:his','run-inbox','one');
// The worker's own watch wakes it later: a service input whose source is the worker's request turn.
input.run('watch:w:fired',2,'s','a3','input','service',null,'request:one','run-worker','watch:w:fired');
// Work started by hand in Sessions, outside any thread, stays unthreaded.
input.run('typed',3,'s','a4','input','human',null,null,null,null);
const results={request:turnTopicRootIn(db,'request:one'),watch:turnTopicRootIn(db,'watch:w:fired'),typed:turnTopicRootIn(db,'typed')};
if(results.request!=='capture:his'||results.watch!=='capture:his'||results.typed!==null)throw new Error(`thread roots: ${JSON.stringify(results)}`);
console.log(`thread roots resolve through retained links: ${JSON.stringify(results)}`);
