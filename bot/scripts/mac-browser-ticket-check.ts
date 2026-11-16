import assert from 'node:assert/strict';
import {parseMacBrowserTicketResponse} from '../src/mac-browser-ticket';

const now=Date.parse('2026-11-07T06:00:00Z');
const valid=JSON.stringify({ticket:'thnk-agent-browser-v1.body.signature',expiresAt:'2026-11-07T06:15:00Z'})+'\n200';
assert.equal(parseMacBrowserTicketResponse(valid,now),'thnk-agent-browser-v1.body.signature');
assert.throws(()=>parseMacBrowserTicketResponse(valid.replace(/200$/,'403'),now));
assert.throws(()=>parseMacBrowserTicketResponse(valid,now+15*60_000));
assert.throws(()=>parseMacBrowserTicketResponse('{"ticket":"other"}\n200',now));
assert.throws(()=>parseMacBrowserTicketResponse('not JSON\n200',now));
console.log('Mac browser ticket response checks passed');
