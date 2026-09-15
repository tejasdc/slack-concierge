// One completion only. No tool implementation, filesystem tools, extensions, or agent loop.
import fs from 'node:fs';
import path from 'node:path';
import { createModels } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { stream } from '@earendil-works/pi-ai/api/openai-codex-responses';

const [inputPath, outputPath, authPath] = process.argv.slice(2);
if (!inputPath || !outputPath || !authPath) throw new Error('input.json output.json private-codex-auth.json required');
if (fs.existsSync(outputPath)) throw new Error('Output exists; choose a new explicit attempt name before making a model call');
const outputParent=fs.realpathSync(path.dirname(outputPath));
for (const archiveRoot of ['/root/transcript-archive','/root/archives']) {
  if (outputParent===archiveRoot || outputParent.startsWith(archiveRoot+'/')) throw new Error('Experiment output cannot be inside an archive');
}
if ((fs.statSync(outputParent).mode & 0o077) !== 0) throw new Error('Output directory must have mode 0700');
for (let p=outputParent;;p=path.dirname(p)) {
  if (fs.existsSync(path.join(p,'.git'))) throw new Error('Private result output must be outside Git');
  if (p===path.dirname(p)) break;
}
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
const models = createModels();
models.setProvider(openaiCodexProvider());
const model = models.getModel('openai-codex', input.model);
if (!model) throw new Error(`Exact model missing from Pi catalog: ${input.model}`);
const emptyUsage = {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const messages = input.messages.map((m, i) => m.role === 'user'
  ? {role:'user',content:m.content,timestamp:i}
  : {role:'assistant',content:[{type:'text',text:m.content}],api:model.api,provider:model.provider,model:model.id,
     usage:emptyUsage,stopReason:'stop',timestamp:i});
const start = Date.now();
let payloadEvidence;
// The documented direct API accepts the current access token without copying or refreshing OAuth state.
const result = await stream(model, {systemPrompt:input.system,messages,tools:[]}, {
  apiKey:auth.tokens.access_token, reasoningEffort:input.reasoning ?? 'medium', transport:'sse',toolChoice:'none',
  signal:AbortSignal.timeout(input.timeout_ms ?? 180000), maxTokens:input.max_tokens ?? 6000,
  onPayload(payload) {
    payloadEvidence = {model:payload.model, tool_count:payload.tools?.length ?? 0,
      roles:(payload.input ?? []).map(m => m.role ?? m.type), input_items:payload.input?.length};
    if (payloadEvidence.tool_count) throw new Error('No-tools invariant violated');
  }
}).result();
const text = result.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
const toolCalls = result.content.filter(b => b.type === 'toolCall').length;
fs.writeFileSync(outputPath, JSON.stringify({requested_model:input.model,provider:result.provider,model:result.model,
  stop_reason:result.stopReason,error:result.errorMessage,usage:result.usage,duration_ms:Date.now()-start,
  payload_evidence:payloadEvidence,tool_calls:toolCalls,text}, null, 2), {mode:0o600,flag:'wx'});
console.log(JSON.stringify({output:outputPath,model:result.model,stop_reason:result.stopReason,tool_calls:toolCalls,duration_ms:Date.now()-start}));
if (toolCalls || result.stopReason === 'error' || result.stopReason === 'aborted') process.exitCode = 1;
