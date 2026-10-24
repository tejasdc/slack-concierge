import {createHash} from 'node:crypto';
import {expect,test} from 'bun:test';
import {createCaptureQueueRequestHandler} from '../src/capture-queue-api';
import {claimHumanCommand,retainHumanCommand,settleHumanCommand,type HumanCommand} from '../src/human-command-state';
import {currentProcessIdentity} from '../src/runtime-identity';

const token='isolated-command-status-token-123456789';
const handler=createCaptureQueueRequestHandler({host:'127.0.0.1',port:8081,token});
const status=(actionId:string,authorization=`Bearer ${token}`)=>handler(new Request(
  `http://127.0.0.1:8081/commands/${actionId}`,{headers:{authorization}},
));

test('authenticated status proves original command bytes and rejects changed retries',async()=>{
  const body={clientActionId:'identity-action-1',text:'private saved message',attachments:[{id:'attachment-1'}]};
  const command:HumanCommand={version:1,actionId:body.clientActionId,clientId:'client-identity-1',
    sessionId:'concierge:3172',sequence:1,door:'iPhone app',method:'POST',
    path:'/sessions/v1/sessions/concierge%3A3172/inputs',body};
  retainHumanCommand(command);
  const claim=claimHumanCommand('identity-claim-1',currentProcessIdentity(),'identity-worker');
  expect(claim?.action_id).toBe(command.actionId);
  settleHumanCommand(command.actionId,'identity-claim-1',202,{operation:{inputId:'original-input'}},'owner');

  expect((await status(command.actionId,'Bearer wrong-token')).status).toBe(401);
  expect((await status('unknown-identity-action')).status).toBe(404);
  const response=await status(command.actionId);
  expect(response.status).toBe(200);
  const receipt=await response.json();
  const originalIdentity={version:1,actionId:command.actionId,clientId:command.clientId,
    sessionId:command.sessionId,sequence:command.sequence,door:command.door,
    method:command.method,path:command.path,
    bodySha256:createHash('sha256').update(JSON.stringify(body),'utf8').digest('hex')};
  expect(receipt).toMatchObject({custody:'server',actionId:command.actionId,status:'delivered',
    decisionStage:'owner',ownerStatus:202,commandIdentity:originalIdentity});
  expect(JSON.stringify(receipt.commandIdentity)).not.toContain(body.text);

  expect(retainHumanCommand(command).sequence).toBe(1);
  expect(()=>retainHumanCommand({...command,sequence:2})).toThrow();
  expect(()=>retainHumanCommand({...command,body:{...body,text:'changed message'}})).toThrow();
  expect((await (await status(command.actionId)).json()).commandIdentity).toEqual(originalIdentity);
});
