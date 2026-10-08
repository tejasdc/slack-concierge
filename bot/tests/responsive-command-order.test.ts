import {beforeEach,expect,test} from 'bun:test';
import {captureDb} from '../src/capture-state';
import {currentProcessIdentity} from '../src/runtime-identity';
import {claimHumanCommand,commandStatus,prepareHumanCommand,recoverHumanCommands,retainHumanCommand,settleHumanCommand,type HumanCommand} from '../src/human-command-state';
const owner=currentProcessIdentity();
const command=(sequence:number,overrides:Partial<HumanCommand>={}):HumanCommand=>({version:1,clientId:'test-client',sessionId:'concierge:1',sequence,
 actionId:`action-${sequence}`,door:'test',method:'POST',path:'/sessions/v1/sessions/concierge%3A1/inputs',body:{clientActionId:`action-${sequence}`,text:`message ${sequence}`},...overrides});
beforeEach(()=>{captureDb.exec('DELETE FROM human_commands; DELETE FROM human_command_streams;');});
test('out-of-order network arrival cannot dispatch a missing predecessor',()=>{
 retainHumanCommand(command(2));
 expect(claimHumanCommand('early',owner,'worker')).toBeNull();
 retainHumanCommand(command(1));
 expect(claimHumanCommand('first',owner,'worker')?.action_id).toBe('action-1');
 settleHumanCommand('action-1','first',400,{error:'invalid_input'},'preparation');
 expect(claimHumanCommand('second',owner,'worker')?.action_id).toBe('action-2');
});
test('live competing workers are fenced; same worker can recover its unconfirmed exchange',()=>{
 retainHumanCommand(command(1));
 expect(claimHumanCommand('old',owner,'worker-a')?.action_id).toBe('action-1');
 expect(claimHumanCommand('competing',owner,'worker-b')).toBeNull();
 expect(recoverHumanCommands()).toBe(0);
 prepareHumanCommand('action-1','old',{primaryBody:{text:'immutable preparation'},fallbackBody:null});
 expect(claimHumanCommand('new',owner,'worker-a')?.prepared_json).toContain('immutable preparation');
 expect(()=>settleHumanCommand('action-1','old',200,{ok:true},'owner')).toThrow();
 settleHumanCommand('action-1','new',200,{ok:true},'owner');
 expect(commandStatus('action-1')?.status).toBe('delivered');
});
test('a dead coordinator claim is recovered while the independent ingress stays running',()=>{
 retainHumanCommand(command(1));
 claimHumanCommand('dead',{pid:99999999,bootId:'dead-boot',startTicks:'0'},'old-worker');
 expect(claimHumanCommand('recovered',owner,'replacement')?.action_id).toBe('action-1');
});
test('exact cancellation freezes a pending target and can pass its predecessor',()=>{
 retainHumanCommand(command(1));
 retainHumanCommand(command(2,{path:'/sessions/v1/sessions/concierge%3A1/actions/action-1/cancel',body:{clientActionId:'action-2'}}));
 expect(commandStatus('action-1')?.status).toBe('canceled');
 expect(claimHumanCommand('cancel',owner,'worker')?.action_id).toBe('action-2');
 settleHumanCommand('action-2','cancel',200,{target:{state:'canceled_before_acceptance'}},'owner');
 retainHumanCommand(command(3));
 expect(claimHumanCommand('next',owner,'worker')?.action_id).toBe('action-3');
});
test('cancellation overtaking its target is retained without leaving a sequence hole',()=>{
 retainHumanCommand(command(2,{path:'/sessions/v1/sessions/concierge%3A1/actions/action-1/cancel',body:{clientActionId:'action-2'}}));
 expect(claimHumanCommand('cancel',owner,'worker')?.action_id).toBe('action-2');
 settleHumanCommand('action-2','cancel',200,{target:{state:'canceled_before_acceptance'}},'owner');
 retainHumanCommand(command(3));
 expect(claimHumanCommand('missing',owner,'worker')).toBeNull();
 retainHumanCommand(command(1));
 expect(claimHumanCommand('original',owner,'worker')?.action_id).toBe('action-1');
 settleHumanCommand('action-1','original',200,{status:'canceled'},'owner');
 expect(claimHumanCommand('next',owner,'worker')?.action_id).toBe('action-3');
});
