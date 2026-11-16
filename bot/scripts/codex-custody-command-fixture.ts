import assert from 'node:assert/strict';
import {parseRouterSessionsArgs} from './router-sessions';

const flags=['work-request','--source-input','repair-input','--source-run','repair-run','--action-id','recover-once'];
const command=parseRouterSessionsArgs(['codex-recover',...flags,'--custody-successor']);
assert.equal(command.operation,'codex-recover');
assert.deepEqual(command.body,{source:{input_id:'repair-input',run_id:'repair-run'},action_id:'recover-once',
  request_id:'work-request',custody_successor:true});
assert.equal('custody_successor' in parseRouterSessionsArgs(['codex-recover',...flags]).body,false);
assert.throws(()=>parseRouterSessionsArgs(['codex-recover',...flags,'--custody-successor','--custody-successor']),/Repeated/);
assert.throws(()=>parseRouterSessionsArgs(['codex-recover',...flags,'--model','gpt-6-astra']),/Invalid/);
assert.throws(()=>parseRouterSessionsArgs(['codex-recover',...flags,'--effort','medium']),/Invalid/);
console.log('Custody recovery command fixture passed: explicit mode, unchanged default, exact source and no caller binding overrides.');
