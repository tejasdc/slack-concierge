import assert from 'node:assert/strict';
import {captureResponseSummary} from './agent-test-capture-response';
const previewLimit = 2000;

const full = {operation: {operationId:'op-1',inputId:'input-2',sessionId:'concierge:3',origin:'agent',humanAuthored:false,
  kind:'inbox-capture',state:'saved',request:{text:'private request'.repeat(500)}},
  agentTest:{notificationRequest:'result',result:'result',humanNotificationArmed:false}};
const raw = JSON.stringify(full);
assert.ok(raw.length > previewLimit);
const summary = captureResponseSummary(raw);
assert.equal(summary.body.length, previewLimit);
assert.deepEqual(summary.operation,{operationId:'op-1',inputId:'input-2',sessionId:'concierge:3',origin:'agent',humanAuthored:false,kind:'inbox-capture',state:'saved'});
assert.deepEqual(summary.agentTest,{notificationRequest:'result',humanNotificationArmed:false});
assert.equal(JSON.stringify({operation:summary.operation,agentTest:summary.agentTest}).includes('private request'),false);

const invalid = captureResponseSummary('x'.repeat(previewLimit + 40));
assert.equal(invalid.body.length,previewLimit);
assert.equal('operation' in invalid,false);
assert.equal('agentTest' in invalid,false);

const malformedShape = captureResponseSummary(JSON.stringify({
  operation:{operationId:{request:'z'.repeat(5000)},inputId:['nested'],sessionId:'concierge:4',origin:'agent',
    humanAuthored:false,kind:'inbox-capture',state:'saved',request:{payload:'z'.repeat(5000)}},
  agentTest:{notificationRequest:{payload:'z'.repeat(5000)},humanNotificationArmed:false,secret:['nested']},
}));
assert.deepEqual(malformedShape.operation,{sessionId:'concierge:4',origin:'agent',humanAuthored:false,kind:'inbox-capture',state:'saved'});
assert.deepEqual(malformedShape.agentTest,{humanNotificationArmed:false});
assert.ok(malformedShape.body.length <= previewLimit);
assert.equal(JSON.stringify({operation:malformedShape.operation,agentTest:malformedShape.agentTest}).includes('zzzz'),false);
assert.deepEqual(captureResponseSummary(JSON.stringify({agentTest:{notificationRequest:null,humanNotificationArmed:false}})).agentTest,
  {notificationRequest:null,humanNotificationArmed:false},'Null classifier result is meaningful');
console.log(JSON.stringify({fixture:'agent-test-capture-response',literalPreviewLimit:previewLimit,largeResponseProjected:true,
  malformedTextBounded:true,malformedShapeSafe:true,nullDiagnosticPreserved:true}));
