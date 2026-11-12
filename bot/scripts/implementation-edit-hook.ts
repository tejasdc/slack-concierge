/** PreToolUse hook for both providers; the canonical owner counts recognized edits before execution. */
import {isCodeEditTool} from '../src/implementation-models';
import {requestApiResponse} from './router-request-client';
import {RETRY_POLICIES} from '../src/retry-policies';

let hook:any={};
try{hook=JSON.parse((await Bun.stdin.text())||'{}');}catch{process.exit(0);}
const toolName=String(hook.tool_name??'');
const toolInput=hook.tool_input??{};
if(!isCodeEditTool(toolName,toolInput))process.exit(0);
const sessionId=String(hook.session_id??'');
const sourceRunId=process.env.CONCIERGE_SOURCE_RUN_ID?.trim()||'';
const toolId=String(hook.tool_use_id??hook.tool_id??'');
if((!sessionId&&!sourceRunId)||!toolId){deny('Concierge cannot identify this edit tool call. Retry it with the provider hook identity present.');}
const ownerTurnId=Number(process.env.CONCIERGE_TURN_ID??'');
const response=await requestApiResponse('/session-communication/edit-gate',{
  providerSessionId:sessionId,...(sourceRunId?{sourceRunId}:{}),providerTurnId:typeof hook.turn_id==='string'?hook.turn_id:undefined,
  ...(typeof hook.model==='string'?{providerModel:hook.model}:{}),
  ...(Number.isSafeInteger(ownerTurnId)&&ownerTurnId>0?{ownerTurnId}:{}),
  toolId,toolName,toolInput,
},RETRY_POLICIES.ownerRestartInHook);
if(!response.ok)deny('Concierge cannot check this code edit right now. Retry after the owner answers.');
if(response.result?.hold)deny(String(response.result.message??'The fifth edit is held; use sessions implement or sessions edit-reason.'));

function deny(reason:string):never{
  process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}})+'\n');
  process.exit(0);
}
