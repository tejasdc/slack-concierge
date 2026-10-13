/**
 * Release gate: who an agent is and what it is doing have one rule (`src/session-presence.ts`),
 * and provider names one table (`providerDisplayName` in `src/aliases.ts`). This refuses the
 * three shapes that made one Gemini agent read "Gemini" in the sidebar, "Claude" on its answer,
 * and "running" in the sidebar while its page said "Completed" (2026-10-13, third report):
 *
 * 1. a provider named by guess, `provider === "codex" ? "Codex" : "Claude"`, which calls every
 *    other provider Claude;
 * 2. an unknown provider defaulted to a real one, `provider ?? "claude-code"`, in place of unknown;
 * 3. a second copy of the running/completed rule (the turn-status table) outside the presence rule.
 *
 * It reads source text, so it catches the shapes, not every conceivable spelling; the shapes are
 * the ones that actually shipped. Run by `bun run build`.
 */
import {readdirSync,readFileSync,statSync} from 'node:fs';
import {join,relative} from 'node:path';

const root=process.argv[2]??join(import.meta.dir,'..','src');
const PROVIDER_ID=String.raw`['"\`](?:codex|claude-code|claude|antigravity|chatgpt)['"\`]`;
const PROVIDER_NAME=String.raw`['"\`](?:Codex|Claude(?: Code)?|Gemini|Google|ChatGPT)['"\`]`;
const rules:{name:string;pattern:RegExp;owner:string}[]=[
  {name:'provider named by guess (use providerDisplayName)',owner:'aliases.ts',
    pattern:new RegExp(String.raw`[!=]==?\s*${PROVIDER_ID}\s*\?\s*${PROVIDER_NAME}`)},
  {name:'unknown provider defaulted to a real one (unknown stays null)',owner:'aliases.ts',
    pattern:new RegExp(String.raw`\bprovider\s*:[^,;]*(?:\?\?|\|\|)\s*${PROVIDER_ID}`)},
  {name:'second copy of the turn-state table (use TURN_STATE in session-receipt-state.ts)',owner:'session-receipt-state.ts',
    pattern:/\bdone\s*:\s*['"]completed['"]\s*,\s*error\s*:\s*['"]failed['"]/},
];

function files(dir:string):string[]{
  return readdirSync(dir).flatMap(name=>{
    const path=join(dir,name);
    if(statSync(path).isDirectory())return files(path);
    return /\.tsx?$/.test(name)&&!/\.test\.tsx?$/.test(name)?[path]:[];
  });
}

export function agentPresenceViolations(sources:{path:string;text:string}[]){
  const found:string[]=[];
  for(const {path,text} of sources){
    text.split('\n').forEach((line,index)=>{
      for(const rule of rules){
        if(path.endsWith(rule.owner))continue;
        if(rule.pattern.test(line))found.push(`${path}:${index+1}: ${rule.name}\n    ${line.trim().slice(0,160)}`);
      }
    });
  }
  return found;
}

if(import.meta.main){
  const found=agentPresenceViolations(files(root).map(path=>({path:relative(join(root,'..'),path),text:readFileSync(path,'utf8')})));
  if(found.length){
    console.error(`agent presence check refused ${found.length} second source(s):\n${found.join('\n')}`);
    process.exit(1);
  }
  console.log('agent presence check: one identity and status rule');
}
