import {afterEach,beforeEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';
import {db,claimNextQueuedTurn,getSessionById,createOrGetSession,upsertChannel,listInterruptedInputContext,finishTurn} from '../src/state';
import {interruptedInputNotice} from '../src/input-continuity';
import {initializeSessionOwnerSchema} from '../src/session-schema';
import {attachSessionSteering,bindSessionProvider,createNativeSession,enqueueSessionInput,nativeRunId,retainSessionInput} from '../src/session-inputs';
import {acquireDatabaseTestLock} from './db-lock';

let release:()=>void;
const owned:number[]=[];
beforeEach(async()=>{release=await acquireDatabaseTestLock();});
afterEach(()=>{
  for(const id of owned.splice(0)) {
    db.query('DELETE FROM session_owner_events WHERE session_id=?').run(id);
    db.query('DELETE FROM session_inputs WHERE session_id=?').run(id);
    db.query('DELETE FROM turn_steering_messages WHERE turn_id IN (SELECT id FROM turns WHERE session_id=?)').run(id);
    db.query('DELETE FROM turns WHERE session_id=?').run(id);
    db.query('DELETE FROM sessions WHERE id=?').run(id);
  }
  release();
});
function session(){const value=createNativeSession('codex',{cwd:'/tmp',purpose:'chat'});owned.push(value.id);return value;}
function input(sessionId:number,actionId=randomUUID(),text='question') {
  return db.transaction(()=>retainSessionInput({sessionId,scope:'surface:thinkering',actionId,kind:'input',origin:'human',payload:{text}}))();
}
test('native inputs use existing FIFO without Slack claims and immutable actions cannot change text',()=>{
  const target=session();
  const action=randomUUID();
  const first=input(target.id,action);
  expect(input(target.id,action)).toMatchObject({duplicate:true,input:{id:first.input.id}});
  expect(()=>input(target.id,action,'changed')).toThrow('conflict');
  const second=input(target.id);
  const a=enqueueSessionInput(first.input.id), b=enqueueSessionInput(second.input.id);
  const claimed=claimNextQueuedTurn('native-owner');
  expect(claimed).toMatchObject({turn_id:a.turn_id,accepted_input_id:a.id,turn_kind:'native',slack_user_msg_ts:null,slack_channel_id:null});
  expect(claimNextQueuedTurn('native-owner')).toBeNull();
  expect(db.query('SELECT status FROM turns WHERE id=?').get(b.turn_id)).toEqual({status:'queued'});
  expect(db.query('SELECT 1 FROM slack_user_input_claims WHERE turn_id IN (?,?)').get(a.turn_id,b.turn_id)).toBeNull();
  expect(nativeRunId(a.turn_id!)).toBe(nativeRunId(a.turn_id!));
  expect(db.query('SELECT 1 FROM turn_reaction_cleanups WHERE turn_id=?').get(a.turn_id)).toBeNull();
});
test('a native input resumes an existing Slack branch without changing its session or native identity',()=>{
  const channel=`C${randomUUID()}`;
  upsertChannel({slack_channel_id:channel,slack_channel_name:'original',group_name:null,name:'original',vault_path:'/tmp',code_path:'/tmp',provider_default:'codex'});
  const target=createOrGetSession(channel,'1700000000.123456','codex');owned.push(target.id);
  bindSessionProvider(target.id,'codex','retained-provider-session');
  const accepted=enqueueSessionInput(input(target.id).input.id);
  const claim=claimNextQueuedTurn('native-owner');
  expect(claim).toMatchObject({turn_id:accepted.turn_id,slack_user_msg_ts:null,turn_kind:'native',agent_session_uuid:'retained-provider-session'});
  expect(getSessionById(target.id)).toMatchObject({id:target.id,slack_channel_id:channel,slack_thread_ts:'1700000000.123456',agent_session_uuid:'retained-provider-session'});
  db.query('DELETE FROM channels WHERE slack_channel_id=?').run(channel);
});
test('steering binds one accepted input to one exact existing execution without a Slack timestamp',()=>{
  const target=session();
  const first=enqueueSessionInput(input(target.id).input.id);
  claimNextQueuedTurn('native-owner');
  const next=input(target.id);
  const steer=attachSessionSteering(next.input.id,first.turn_id!);
  expect(steer).toMatchObject({turn_id:first.turn_id,id:next.input.id});
  expect(steer.steering_id).not.toBeNull();
  expect(attachSessionSteering(next.input.id,first.turn_id!).steering_id).toBe(steer.steering_id);
  expect(db.query('SELECT slack_user_msg_ts,accepted_input_id FROM turn_steering_messages WHERE id=?').get(steer.steering_id)).toEqual({slack_user_msg_ts:null,accepted_input_id:next.input.id});
});
test('adapter-nullability upgrade preserves exact old identities, foreign keys, indexes, triggers and sequence',()=>{
  const store=new Database(':memory:');
  try {
    store.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE sessions(id INTEGER PRIMARY KEY AUTOINCREMENT,slack_channel_id TEXT NOT NULL,slack_thread_ts TEXT NOT NULL,provider_id TEXT NOT NULL,agent_session_uuid TEXT,UNIQUE(slack_channel_id,slack_thread_ts));
      CREATE TABLE turns(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id INTEGER REFERENCES sessions(id),slack_user_msg_ts TEXT NOT NULL);
      CREATE TABLE turn_steering_messages(id INTEGER PRIMARY KEY,turn_id INTEGER REFERENCES turns(id),slack_user_msg_ts TEXT NOT NULL);
      CREATE TABLE session_communication_requests(request_id TEXT PRIMARY KEY,source_channel TEXT NOT NULL,source_message_ts TEXT NOT NULL,source_root_ts TEXT NOT NULL,target_channel TEXT NOT NULL,target_root_ts TEXT NOT NULL,action_id TEXT);
      CREATE TABLE session_communication_events(event_id TEXT PRIMARY KEY);
      CREATE INDEX fixture_provider ON sessions(provider_id);
      CREATE TABLE fixture_audit(id INTEGER);
      CREATE TRIGGER fixture_update AFTER UPDATE ON sessions BEGIN INSERT INTO fixture_audit VALUES(new.id); END;
      CREATE VIEW fixture_existing_session_history AS SELECT sessions.id, turns.slack_user_msg_ts
        FROM sessions JOIN turns ON turns.session_id=sessions.id;
      INSERT INTO sessions VALUES(17,'C1','1.000001','codex','native-old');
      INSERT INTO turns VALUES(23,17,'1.000002');
      INSERT INTO sessions VALUES(99,'C2','2.000001','codex','removed');
      DELETE FROM sessions WHERE id=99;`);
    initializeSessionOwnerSchema(store);
    initializeSessionOwnerSchema(store);
    expect(store.query('SELECT id,slack_channel_id,agent_session_uuid FROM sessions').all()).toEqual([{id:17,slack_channel_id:'C1',agent_session_uuid:'native-old'}]);
    expect(store.query('SELECT * FROM turns WHERE id=23').get()).toMatchObject({session_id:17,slack_user_msg_ts:'1.000002'});
    expect(store.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(store.query('PRAGMA foreign_keys').get()).toEqual({foreign_keys:1});
    expect(store.query('SELECT * FROM fixture_existing_session_history').all()).toEqual([{id:17,slack_user_msg_ts:'1.000002'}]);
    expect(store.query("SELECT name FROM sqlite_master WHERE name='fixture_provider'").get()).not.toBeNull();
    store.query('UPDATE sessions SET agent_session_uuid=? WHERE id=17').run('still-native');
    expect(store.query('SELECT * FROM fixture_audit').all()).toEqual([{id:17}]);
    const created=store.query('INSERT INTO sessions(slack_channel_id,slack_thread_ts,provider_id) VALUES(NULL,NULL,?)').run('codex');
    expect(Number(created.lastInsertRowid)).toBeGreaterThan(99);
  } finally {store.close();}
});

test('later native input preserves unconfirmed model history without replaying fork controls or fabricating Slack pointers',()=>{
  const target=session(),first=enqueueSessionInput(input(target.id).input.id);
  claimNextQueuedTurn('fixture-owner');finishTurn(first.turn_id!,'error','Unconfirmed native input');
  const control=retainSessionInput({sessionId:target.id,scope:'surface:thinkering',actionId:randomUUID(),kind:'fork',origin:'human',payload:{boundary:'native-boundary'}}).input;
  enqueueSessionInput(control.id);const fork=claimNextQueuedTurn('fixture-owner')!;finishTurn(fork.turn_id,'error','Fork was refused');
  const next=enqueueSessionInput(input(target.id).input.id),history=listInterruptedInputContext(next.turn_id!);
  expect(history.map(entry=>entry.turn_id)).toEqual([first.turn_id]);
  expect(history[0]).toMatchObject({input_id:first.id,channel_id:null,message_ts:null});
  expect(interruptedInputNotice(history)).toContain(first.id);
  expect(interruptedInputNotice(history)).not.toContain('slack.com');
});
