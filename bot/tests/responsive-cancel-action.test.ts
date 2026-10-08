import {expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {db} from '../src/state';
import {createNativeSession,getAcceptedSessionInput,retainSessionInput} from '../src/session-inputs';
import {SessionOwner} from '../src/session-owner';

function fixture(){
 const session=createNativeSession('claude-code',{title:'Cancellation acceptance fixture',cwd:'/tmp',project:'slack-concierge'});
 const owner=new SessionOwner({available:()=>true,wake:()=>{},steer:()=>{throw new Error('Canceled input must never steer');},stop:async()=>false},'/tmp');
 return {owner,session,id:`concierge:${session.id}`};
}
test('cancel before transport import retains both identities and never creates a turn',()=>{
 const {owner,session,id}=fixture(),targetActionId=randomUUID(),clientActionId=randomUUID();
 const first=owner.cancelAction(id,targetActionId,{clientActionId});
 expect(first.target).toMatchObject({targetActionId,targetOperationId:null,state:'canceled_before_acceptance'});
 expect(first.operation.state).toBe('completed');
 expect(owner.cancelAction(id,targetActionId,{clientActionId})).toEqual(first);
 const body={clientActionId:targetActionId,text:'Canceled before reaching the owner',delivery:'queue'};
 const admitted=owner.submit(id,body);
 expect(admitted.operation.state).toBe('canceled');
 expect(admitted.operation.operationId).not.toBe(first.operation.operationId);
 expect(owner.submit(id,body).operation.operationId).toBe(admitted.operation.operationId);
 expect(getAcceptedSessionInput(admitted.operation.operationId)?.turn_id).toBeNull();
 expect(db.query('SELECT COUNT(*) AS count FROM turns WHERE session_id=?').get(session.id)).toEqual({count:0});
});
test('a canceled action cannot be retargeted to another session or author',()=>{
 const a=fixture(),b=fixture(),target=randomUUID();
 a.owner.cancelAction(a.id,target,{clientActionId:randomUUID()});
 expect(()=>b.owner.submit(b.id,{clientActionId:target,text:'wrong conversation'})).toThrow();
 expect(()=>retainSessionInput({sessionId:a.session.id,scope:'surface:thinkering',actionId:target,kind:'input',origin:'agent',payload:{text:'wrong author'}})).toThrow();
 expect(db.query("SELECT id FROM session_inputs WHERE scope='surface:thinkering' AND action_id=?").get(target)).toBeNull();
});
test('already queued input cancels but an admitted turn is refused without leaving a tombstone',()=>{
 const {owner,id}=fixture(),queued=randomUUID();
 const accepted=owner.submit(id,{clientActionId:queued,text:'queued',delivery:'queue'});
 expect(owner.cancelAction(id,queued,{clientActionId:randomUUID()}).target.state).toBe('canceled');
 expect(getAcceptedSessionInput(accepted.operation.operationId)?.receipt_json).toContain('canceled');
 const running=randomUUID(),live=owner.submit(id,{clientActionId:running,text:'admitted',delivery:'queue'});
 const input=getAcceptedSessionInput(live.operation.operationId)!;
 db.query("UPDATE turns SET provider_admission_intended_at=CURRENT_TIMESTAMP WHERE id=?").run(input.turn_id);
 expect(()=>owner.cancelAction(id,running,{clientActionId:randomUUID()})).toThrow('Stop an admitted exact run');
 expect(db.query("SELECT action_id FROM session_input_cancellations WHERE scope='surface:thinkering' AND action_id=?").get(running)).toBeNull();
});
