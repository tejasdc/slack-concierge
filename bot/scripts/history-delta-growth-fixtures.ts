#!/usr/bin/env bun
import {strict as assert} from 'node:assert';
import {Database} from 'bun:sqlite';
import {boundedChangedMessageIds,HISTORY_CHANGE_LIMIT} from '../src/bounded-history-changes';

for(const count of [100,1000,10_000]){
 const db=new Database(':memory:');
 try{
  db.exec(`CREATE TABLE session_owner_events(sequence INTEGER PRIMARY KEY,event_id TEXT,session_id INTEGER,
    turn_id INTEGER,kind TEXT,payload_json TEXT);
   CREATE INDEX session_owner_events_message_delta ON session_owner_events(session_id,sequence) WHERE kind='message';
   CREATE INDEX session_owner_events_message_version ON session_owner_events(turn_id,json_extract(payload_json,'$.message.id'),sequence) WHERE kind='message';
   CREATE INDEX session_owner_events_history_turn_delta ON session_owner_events(session_id,sequence) WHERE kind<>'message' AND turn_id IS NOT NULL;
   CREATE INDEX session_owner_events_history_action_delta ON session_owner_events(session_id,sequence) WHERE kind='message-action';`);
  const insert=db.query('INSERT INTO session_owner_events VALUES(?,?,?,?,?,?)');
  for(let n=1;n<=count;n++)insert.run(n,`m-${n}`,1,n,'message',JSON.stringify({message:{id:`message-${n}`}}));
  const held=Array.from({length:Math.min(200,count)},(_,index)=>`message-${count-index}`);
  assert.equal(boundedChangedMessageIds(db,1,count,count,held)?.size,0);
  insert.run(count+1,'changed',1,count,'run','{}');
  const turn=boundedChangedMessageIds(db,1,count,count+1,held);
  assert.deepEqual([...turn??[]],[`message-${count}`]);
  insert.run(count+2,'reaction',1,null,'message-action',JSON.stringify({action:{messageId:held[1]??held[0]}}));
  const action=boundedChangedMessageIds(db,1,count,count+2,held);
  assert.ok(action?.has(held[1]??held[0]));
  insert.run(count+3,'version',1,count,'message',JSON.stringify({message:{id:`message-${count}`}}));
  assert.ok(boundedChangedMessageIds(db,1,count,count+3,held)?.has(`message-${count}`));
  for(let n=0;n<=HISTORY_CHANGE_LIMIT;n++)insert.run(count+4+n,`burst-${n}`,1,null,'message',JSON.stringify({message:{id:`burst-${n}`}}));
  assert.equal(boundedChangedMessageIds(db,1,count+3,count+4+HISTORY_CHANGE_LIMIT,held),null,
   'a burst must reset to one recent page, never scan the entire suffix');
  for(const [sql,index] of [
   ["SELECT sequence FROM session_owner_events WHERE session_id=1 AND kind='message' AND sequence>1 ORDER BY sequence LIMIT 201",'session_owner_events_message_delta'],
   ["SELECT turn_id FROM session_owner_events WHERE session_id=1 AND kind<>'message' AND turn_id IS NOT NULL AND sequence>1 ORDER BY sequence LIMIT 201",'session_owner_events_history_turn_delta'],
   ["SELECT sequence FROM session_owner_events WHERE session_id=1 AND kind='message-action' AND sequence>1 ORDER BY sequence LIMIT 201",'session_owner_events_history_action_delta'],
   ["SELECT sequence FROM session_owner_events WHERE kind='message' AND turn_id=1 AND json_extract(payload_json,'$.message.id')='message-1' LIMIT 1",'session_owner_events_message_version']]){
   const plan=db.query('EXPLAIN QUERY PLAN '+sql).all() as {detail:string}[];
   assert.ok(plan.some(row=>row.detail.includes(index)),JSON.stringify(plan));
  }
 }finally{db.close();}
}
console.log('history-delta-growth: passed');
