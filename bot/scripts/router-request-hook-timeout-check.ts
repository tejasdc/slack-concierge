#!/usr/bin/env bun
/** The hook's process deadline must outlast the owner's bounded wait, and restart retries stay usable. */
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {requestApiResponse} from './router-request-client';
import {RETRY_POLICIES,type RetryPolicy} from '../src/retry-policies';

const scratch=mkdtempSync(join(tmpdir(),'concierge-hook-owner-timeout-'));
const oldEnvironment={
  stateDir:process.env.CONCIERGE_STATE_DIR,
  stateDb:process.env.CONCIERGE_STATE_DB,
  runnerState:process.env.CONCIERGE_RUNNER_STATE,
  privateCodeState:process.env.CONCIERGE_PRIVATE_CODE_STATE,
  ownerUrl:process.env.CONCIERGE_OWNER_URL,
  agentToken:process.env.CONCIERGE_AGENT_TOKEN,
};
const originalFetch=globalThis.fetch;
const hookPolicy=RETRY_POLICIES.ownerRestartInHook;
const assert=(condition:unknown,message:string):asserts condition=>{if(!condition)throw new Error(message);};

try {
  const stateDir=join(scratch,'state');
  mkdirSync(stateDir,{recursive:true});
  process.env.CONCIERGE_STATE_DIR=stateDir;
  process.env.CONCIERGE_STATE_DB=join(stateDir,'state.db');
  process.env.CONCIERGE_RUNNER_STATE=stateDir;
  delete process.env.CONCIERGE_PRIVATE_CODE_STATE;
  delete process.env.CONCIERGE_OWNER_URL;
  delete process.env.CONCIERGE_AGENT_TOKEN;

  assert(hookPolicy.maxAgeMs<20_000,'managed hook retry budget must remain shorter than its 20-second provider timeout');
  let stalledCalls=0;
  globalThis.fetch=(async (_input,init) => {
    stalledCalls++;
    const signal=init?.signal;
    if(!signal)throw new Error('owner fetch had no timeout signal');
    return await new Promise<Response>((_resolve,reject)=>{
      if(signal.aborted){reject(signal.reason);return;}
      signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    });
  }) as typeof fetch;
  const shortPolicy:RetryPolicy={...hookPolicy,maxAttempts:2,maxAgeMs:140};
  const stalledAt=Date.now();
  const stalled=await requestApiResponse('/session-communication/edit-gate',{action_id:'timeout-fixture'},shortPolicy);
  const stalledMs=Date.now()-stalledAt;
  assert(!stalled.ok&&stalled.result.error==='owner_unconfirmed','a silent owner must return a refusal');
  assert(stalledCalls===1,'a hanging owner request must stop when the overall retry budget expires');
  assert(stalledMs>=100&&stalledMs<1_000,`the refusal took ${stalledMs} ms instead of respecting the 140 ms budget`);

  let retryCalls=0;
  const action={action_id:'restart-retry-fixture'};
  const serialized=JSON.stringify(action);
  globalThis.fetch=(async (_input,init) => {
    retryCalls++;
    assert(init?.body===serialized,'safe restart retry must reuse the original request body and action ID');
    if(retryCalls===1)throw Object.assign(new Error('owner socket is restarting'),{code:'ECONNREFUSED'});
    return new Response(JSON.stringify({known:true}),{status:200,headers:{'Content-Type':'application/json'}});
  }) as typeof fetch;
  const recovered=await requestApiResponse('/session-communication/model-start-gate',action,{
    ...hookPolicy,baseDelayMs:1,capDelayMs:1,jitterFraction:0,maxAgeMs:500,
  });
  assert(recovered.ok&&recovered.result.known===true,'a brief owner restart must recover through a safe retry');
  assert(retryCalls===2,'the client must retry once after a never-reached owner connection');

  console.log(`router-request-hook-timeout-check: refusal in ${stalledMs} ms; safe restart recovered on attempt ${retryCalls}`);
} finally {
  globalThis.fetch=originalFetch;
  for(const [key,value] of Object.entries({
    CONCIERGE_STATE_DIR:oldEnvironment.stateDir,
    CONCIERGE_STATE_DB:oldEnvironment.stateDb,
    CONCIERGE_RUNNER_STATE:oldEnvironment.runnerState,
    CONCIERGE_PRIVATE_CODE_STATE:oldEnvironment.privateCodeState,
    CONCIERGE_OWNER_URL:oldEnvironment.ownerUrl,
    CONCIERGE_AGENT_TOKEN:oldEnvironment.agentToken,
  })) {
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  rmSync(scratch,{recursive:true,force:true});
}
