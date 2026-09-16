import {afterEach,beforeEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {db} from '../src/state';
import {RoutedRequestCoordinator} from '../src/routed-requests';
import {startRoutedRequestApi} from '../src/routed-request-api';
import {acquireDatabaseTestLock} from './db-lock';

let unlock:()=>void,directory:string,coordinator:RoutedRequestCoordinator,admitted:unknown[],sequence=0;
beforeEach(async()=>{
  unlock=await acquireDatabaseTestLock();directory=mkdtempSync(join(tmpdir(),'native-routing-retirement-'));admitted=[];sequence=0;
  db.query('DELETE FROM routed_input_events').run();db.query('DELETE FROM routed_requests').run();
  coordinator=new RoutedRequestCoordinator({instanceId:'retirement-fixture',isOwnerAlive:()=>false,admit:async input=>{admitted.push(input);},onError:error=>{throw error;}});
});
afterEach(async()=>{
  await coordinator.stop();db.query('DELETE FROM routed_input_events').run();db.query('DELETE FROM routed_requests').run();
  rmSync(directory,{recursive:true,force:true});unlock();
});

function legacy(status:string,delivery:string) {
  const timestamp=`${101+sequence++}.000001`;
  const id=randomUUID(),publication=JSON.stringify({delivery,channel:'COLD',thread_ts:'100.000001',file_ids:['FRETAINED']});
  db.query(`INSERT INTO routed_requests(request_id,source_channel,source_message_ts,action_id,channel_id,payload_json,payload_hash,requested_by,status,owner_instance_id,publication_json,message_ts)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,'CSOURCE','100.000001',id,'COLD',JSON.stringify({task:'Retained task'}),'retained-hash','U1',status,'prior-owner',publication,timestamp);
  return {id,publication,timestamp};
}

test('retired coordinator refuses new agent ingress before retaining a request',async()=>{
  await expect(coordinator.submit({source:{channel_id:'CSOURCE',message_ts:'100.000001'},action_id:'new',destination:{channel_id:'COLD'},task:'Do not post',defer:false,depends_on:[]})).rejects.toThrow('retired');
  expect(db.query('SELECT count(*) AS n FROM routed_requests').get()).toEqual({n:0});
  expect(admitted).toEqual([]);
});

test('recovery preserves publication evidence and already admitted work without publication or input replay',async()=>{
  const pending=legacy('publishing','unknown'),accepted=legacy('admitted','confirmed');
  const retained=db.query('SELECT * FROM routed_requests WHERE request_id=?').get(accepted.id);
  await coordinator.recover();await coordinator.recoverRequest(pending.id);await coordinator.recoverUnsentReturn(accepted.id);
  expect(coordinator.result(pending.id)).toMatchObject({status:'uncertain',error:expect.stringContaining('reconciliation')});
  expect(db.query('SELECT publication_json,message_ts FROM routed_requests WHERE request_id=?').get(pending.id)).toEqual({publication_json:pending.publication,message_ts:pending.timestamp});
  expect(db.query('SELECT * FROM routed_requests WHERE request_id=?').get(accepted.id)).toEqual(retained);
  expect(admitted).toEqual([]);
});

test('a late publication echo is retained as evidence while independent real Slack input can still enter',async()=>{
  const pending=legacy('publishing','unknown');
  const echo={channel:'COLD',threadTs:'100.000001',userMsgTs:'102.000001',user:'U1',text:'Retained task',clientMessageId:pending.id};
  await coordinator.receive(echo);
  const human={channel:'COLD',threadTs:'100.000001',userMsgTs:'103.000001',user:'U1',text:'A real later human message'};
  await coordinator.receive(human);await coordinator.recover();
  expect(admitted).toEqual([human]);
  expect(db.query('SELECT input_json FROM routed_input_events').all()).toEqual([{input_json:JSON.stringify(echo)}]);
  expect(coordinator.result(pending.id).status).toBe('uncertain');
});

test('request socket refuses agent submission and recovery under both runtime compositions, retaining historical reads',async()=>{
  const historical=legacy('admitted','confirmed');
  for(const adapter of [coordinator,null]) {
    const api=startRoutedRequestApi(directory,adapter);
    try {
      for(const path of ['/requests',`/requests/${historical.id}/recover`]) {
        const response=await fetch(`http://owner${path}`,{unix:join(directory,'requests.sock'),method:'POST',body:'{}'});
        expect(response.status).toBe(410);expect(await response.json()).toMatchObject({code:'slack_routing_retired'});
      }
      {
        const response=await fetch(`http://owner/requests/${historical.id}`,{unix:join(directory,'requests.sock')});
        expect(response.status).toBe(200);expect(await response.json()).toMatchObject({request_id:historical.id,status:'admitted'});
      }
    } finally { await api.stop(true); }
  }
  expect(admitted).toEqual([]);
});

test('installed-wrapper path and direct router-post invocations refuse post, resume and upload without credentials or a socket',async()=>{
  const attachment=join(directory,'retained attachment.txt');writeFileSync(attachment,'Exact attachment bytes');
  const env={...process.env,CONCIERGE_ROUTER_BOT_DIR:resolve('.'),CONCIERGE_STATE_DB:join(directory,'missing.db'),CONCIERGE_SLACK_CONFIG:join(directory,'missing.toml')};
  for(const verb of ['post','resume','upload']) {
    const args=[verb,'COLD',...(verb==='post'?[]:['100.000001']),'--file',attachment,'--source-channel','CSOURCE','--source-ts','99.000001','--','Do not send'];
    for(const command of [[process.execPath,'scripts/router-post.ts','--action',...args],['bash','../systemd/router-actions.sh',...args]]) {
      const child=Bun.spawn(command,{env,stdout:'pipe',stderr:'pipe'});
      const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      expect(exit).toBe(1);expect(stdout).toBe('');expect(stderr).toContain('Agent Slack publication is retired');
      expect(stderr).not.toContain('ENOENT');
    }
  }
  const child=Bun.spawn([process.execPath,'scripts/router-post.ts','COLD','--','Do not send'],{env,stdout:'pipe',stderr:'pipe'});
  expect(await child.exited).toBe(1);expect(await new Response(child.stderr).text()).toContain('Agent Slack publication is retired');
  expect(db.query('SELECT count(*) AS n FROM routed_requests').get()).toEqual({n:0});
});
