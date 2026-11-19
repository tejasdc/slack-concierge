/** PreToolUse hook for both providers; the canonical owner counts recognized edits before execution. */
import {randomUUID} from 'node:crypto';
import {existsSync, lstatSync, realpathSync} from 'node:fs';
import {dirname, isAbsolute, resolve} from 'node:path';
import {isCodeEditTool} from '../src/implementation-models';
import {terminalClaudePid} from '../src/claude-terminal-process';
import {requestApiResponse} from './router-request-client';
import {RETRY_POLICIES} from '../src/retry-policies';

let hook:any={};
try{hook=JSON.parse((await Bun.stdin.text())||'{}');}catch{process.exit(0);}
const toolName=String(hook.tool_name??'');
const toolInput=hook.tool_input??{};
const sessionId=String(hook.session_id??'');
const sourceRunId=process.env.CONCIERGE_SOURCE_RUN_ID?.trim()||'';
if(hook.hook_event_name==='UserPromptSubmit'||hook.hook_event_name==='Stop'){
  if(sourceRunId)process.exit(0);
  const pid=terminalClaudePid(sessionId);
  if(!pid)process.exit(0);
  const event=hook.hook_event_name==='Stop'?'stop':'start';
  const response=await requestApiResponse('/session-communication/claude-terminal-turn',{
    sessionId,pid,event,...(event==='start'?{action_id:randomUUID()}:{})
  },RETRY_POLICIES.ownerRestartInHook);
  if(event==='start'){
    const source=response.ok?response.result?.source:null;
    if(source)console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',
      additionalContext:`This Claude Code terminal prompt has a Concierge turn. For router-actions.sh commands that require source flags, use --source-input ${source.inputId} --source-run ${source.runId} from this prompt and a stable action ID. Earlier prompts have different source flags.`}}));
    else if(!response.ok)console.log('Concierge could not register this terminal prompt for router commands. '+String(response.result?.error??'The owner did not respond.'));
  }
  process.exit(0);
}
if(!isCodeEditTool(toolName,toolInput))process.exit(0);
if(isScratchFile(toolName,toolInput,hook.cwd))process.exit(0);
const toolId=String(hook.tool_use_id??hook.tool_id??'');
if((!sessionId&&!sourceRunId)||!toolId){deny('Concierge cannot identify this edit tool call. Retry it with the provider hook identity present.');}
const ownerTurnId=Number(process.env.CONCIERGE_TURN_ID??'');
const terminalPid=!sourceRunId&&typeof hook.turn_id!=='string'?terminalClaudePid(sessionId):null;
const response=await requestApiResponse('/session-communication/edit-gate',{
  providerSessionId:sessionId,...(sourceRunId?{sourceRunId}:{}),providerTurnId:typeof hook.turn_id==='string'?hook.turn_id:undefined,
  ...(terminalPid?{terminalPid}:{}),
  ...(typeof hook.model==='string'?{providerModel:hook.model}:{}),
  ...(typeof hook.agent_id==='string'?{providerAgentId:hook.agent_id}:{}),
  ...(Number.isSafeInteger(ownerTurnId)&&ownerTurnId>0?{ownerTurnId}:{}),
  toolId,toolName,toolInput,
},RETRY_POLICIES.ownerRestartInHook);
if(!response.ok)deny('Concierge cannot check this code edit right now. Retry after the owner answers.');
if(response.result?.hold)deny(String(response.result.message??'The fifth edit is held; use sessions implement or sessions edit-reason.'));

function deny(reason:string):never{
  process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}})+'\n');
  process.exit(0);
}

/** A named file operation outside every Git worktree is outside the implementation budget. */
function isScratchFile(tool:string,input:any,cwd:unknown):boolean{
  const file=tool==='NotebookEdit'?input.notebook_path:input.file_path;
  if(!['Edit','MultiEdit','Write','NotebookEdit'].includes(tool)||typeof file!=='string'||!file
    ||typeof cwd!=='string'||!isAbsolute(cwd))return false;
  try{
    let path=resolve(cwd,file);
    while(true){
      try{lstatSync(path);break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const parent=dirname(path);
      if(parent===path)return false;
      path=parent;
    }
    path=realpathSync(path);
    while(!existsSync(resolve(path,'.git'))){
      const parent=dirname(path);
      if(parent===path)return true;
      path=parent;
    }
  }catch{ /* Fall back to the edit gate if the filesystem cannot classify the target. */ }
  return false;
}
