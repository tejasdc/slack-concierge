import assert from 'node:assert/strict';
import {proveCodexInputNeverAcknowledged} from '../src/codex-unacknowledged-proof';
import {parseRouterSessionsArgs} from './router-sessions';

const attempts=[{dispatchAttempt:1,providerTurnId:'native-one'},{dispatchAttempt:2,providerTurnId:'native-two'}];
const thread={thread:{id:'thread-exact',turns:[
  {id:'prior-work',status:'completed',error:null,items:[{type:'userMessage',clientId:'slack-concierge:turn:12:attempt:1'},{type:'agentMessage',text:'work'}]},
  {id:'earlier-watch-empty',status:'completed',error:null,items:[]},
  {id:'native-one',status:'completed',error:null,items:[]},
  {id:'native-two',status:'completed',error:null,items:[]},
]}};
assert.deepEqual(proveCodexInputNeverAcknowledged({thread,threadId:'thread-exact',attempts}),{
  attempts:[{dispatchAttempt:1,providerTurnId:'native-one',status:'completed',itemCount:0},
    {dispatchAttempt:2,providerTurnId:'native-two',status:'completed',itemCount:0}],unmappedEmptyTurns:0});
assert.equal(proveCodexInputNeverAcknowledged({thread,threadId:'other-thread',attempts}),null,'wrong thread refuses');
assert.ok(proveCodexInputNeverAcknowledged({thread,threadId:'thread-exact',attempts:attempts.slice(1)}),
  'a separate earlier empty watch turn does not invalidate an exact selected attempt');
assert.equal(proveCodexInputNeverAcknowledged({thread,threadId:'thread-exact',attempts:[
  {dispatchAttempt:1,providerTurnId:'unknown-native-turn'}]}),null,'an unknown selected attempt refuses');
assert.equal(proveCodexInputNeverAcknowledged({thread:{thread:{...thread.thread,turns:[
  ...thread.thread.turns.slice(0,2),{id:'native-one',status:'completed',error:null,items:[{type:'userMessage'}],
    run_id:undefined},thread.thread.turns[3]]}},
  threadId:'thread-exact',attempts}),null,'any acknowledged attempt refuses');
assert.equal(proveCodexInputNeverAcknowledged({thread:{thread:{...thread.thread,turns:[
  ...thread.thread.turns.slice(0,1),{id:'native-one',status:'inProgress',error:null,items:[]},thread.thread.turns[2]]}},
  threadId:'thread-exact',attempts}),null,'nonterminal attempt refuses');
assert.equal(proveCodexInputNeverAcknowledged({thread:{thread:{id:'thread-exact',turns:[
  {id:'native-one',status:'completed',error:null},{id:'native-two',status:'completed',error:null}]}},threadId:'thread-exact',attempts}),null,
  'missing complete item arrays refuse');
const command=parseRouterSessionsArgs(['codex-recover','original-request','--source-input','request:repair',
  '--source-run','run-repair','--action-id','recover-3012']);
assert.equal(command.operation,'codex-recover');
assert.equal(command.body.request_id,'original-request');
assert.equal(command.body.action_id,'recover-3012');
assert.throws(()=>parseRouterSessionsArgs(['codex-recover','original-request','--source-input','request:repair',
  '--source-run','run-repair']),'a stable recovery action id is mandatory');
console.log('Codex unacknowledged recovery contract: all attempts, exact thread, terminal empty evidence and ambiguity refusals passed');
