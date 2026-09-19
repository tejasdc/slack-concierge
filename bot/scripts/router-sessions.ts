#!/usr/bin/env bun
import { requestApiResponse } from "./router-request-client";
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {parseProviderSelector,normalizeReasoningEffort} from '../src/aliases';

const usage = `router-actions.sh sessions projects <source-flags> [--peer <instance>]
router-actions.sh sessions peers <source-flags>
router-actions.sh sessions search <source-flags> [--limit N] [--peer <instance>] -- <concept...>
router-actions.sh sessions context <address> <source-flags>
router-actions.sh sessions ask <address> <source-flags> --action-id A [--after-request <request-id> ...] -- <text>
router-actions.sh sessions ask --provider <alias> --project <registered-project> [--effort <level>] --session-name <title> <source-flags> --action-id A [--file <path> ...] [--capture-id <id>] -- <text>
router-actions.sh sessions ask --provider chatgpt <source-flags> --action-id A -- <text>
router-actions.sh sessions ask --peer <instance> --provider <alias> --project <peer-project> [--effort <level>] --session-name <title> <source-flags> --action-id A -- <text>
router-actions.sh sessions ask <peer-address> <source-flags> --action-id A [--resurrect] -- <text>
router-actions.sh sessions note <captureId> <source-flags> --action-id A
router-actions.sh sessions title <source-flags> --action-id A -- <title>
router-actions.sh sessions post <source-flags> --action-id A --thread <message-id> -- <text>
router-actions.sh sessions reply <request-id> <source-flags> --action-id A [--partial | --work-disposition completed|failed|needs_decision] -- <text>
router-actions.sh sessions get <request-id> <source-flags>
router-actions.sh sessions cancel <request-id> <source-flags> --action-id A

Every command requires one exact source pair:
  --source-input <inputId> --source-run <runId> from this concierge-session-input identity header's input.id and input.runId
  --source-channel <channelId> --source-ts <messageTs> from this input's slack-message-context
Do not mix source pairs. No source or run is inferred from the environment.
Search returns {results:[{session,evidence}],coverage} for both source forms.
Copy results[i].session.address and returned request IDs exactly. A concierge:<id> is not an address. The service chooses delivery.
Continue the session that owns the surface when search/context establish one unambiguous, messageable live or recently completed owner. Title, project, source and dialogue must show ownership; topical similarity and consultation-only evidence are insufficient. Clarify ambiguous ownership. When no session owns the work or the surface differs, use --provider cc-opus to create a fresh native session and first input. A human's explicit session/provider/model/effort choice takes precedence. An addressed ask requires the exact discovered address. A registered project with its own selected default keeps that selection. Codex/Claude require --project from sessions projects; the owner resolves its cwd. ChatGPT accepts no project or effort. No provider fallback or Slack publication occurs.
Supply --session-name "Meaningful topic" for that new session. It uses the same canonical title shown in Thinkering.
Use sessions title from an admitted run to name only its own unnamed session. Explicit requester and human titles are preserved.
Use sessions post to answer a thread of your own Inbox deliberately: --thread is the exact message ID the thread is rooted at or continues. The post becomes the thread's reply; your other working output does not. Only the Inbox accepts posts. A post starts no turn and owes no reply.
Use --text-file <path> instead of -- <text> for long prompts. Repeated --file retains exact bytes before dispatch; local paths are never sent to the owner. --capture-id includes retained Inbox source bytes and attachments. Forward only material authorized by the current human request.
Use distinct action IDs for distinct asks/replies; retries retain the original source, action ID and payload.
Sessions live on several Concierge instances (sessions peers lists them; mac is Tejas's laptop). sessions search covers every instance by default, from the transcript archive on this instance first — it holds both machines' history and answers whether the peer is on or off — plus the live peer when it answers: a session on a peer carries id <peer>:<n>, address <peer>/session:… and availability {reachable,note}; coverage.peers says which peers answered. sessions ask/context take that address as they take any other, so a session is addressed the same way wherever it runs. Each peer session's availability.state is live (the running peer confirmed it) or archived-only (found in the transcript archive or the peer's last catalogue; the peer did not confirm). When the peer is offline, search still returns its sessions as archived-only, an ask is accepted with status queued_offline and delivered when the peer wakes (its receipt says so; never a hard failure), and context comes from the archived transcript. To continue an archived-only session now, sessions ask <peer-address> --resurrect starts a new process on this instance from the archived transcript (the provider's own resume, fed the transcript) as a distinct session titled “… (resurrected from <peer>)”; the peer's original stays parked and can still be resumed there later. Nothing merges the two. Use --peer <instance> only to restrict search/projects to one instance or to create a new session there (sessions ask --peer <instance> --provider … --project <its project>). Choose the machine from the work, not by asking: a local file path, Xcode/iMessage/Finder or another Mac app, or a #mac chip means the Mac; ChatGPT or server-only work means here; “on the Mac” or “on my laptop” names it outright; with no signal, use the machine the most recent session in the same project folder ran on (sessions search shows each session's owner), else here. Every project folder exists on both machines, so the folder alone never decides. The request keeps its return obligation here; the peer session replies with the ordinary sessions reply on its own machine. A peer request cannot use --after-request.
Reply to every request this run received. When one answer covers several, a single final reply naming the others settles them too; say which ones it covers. A run that follows an interruption can still answer requests delivered to the earlier run.
--after-request waits for the named request to settle. When it settles without confirmed success (unanswered, decision needed, or a work answer without a disposition), a request you asked before that outcome reached you stays held for your decision: cancel it with sessions cancel, or ask again. A request you ask after seeing that outcome is your decision and is delivered.
Use sessions cancel <request-id> to withdraw your own request, for example one you have superseded; a request not yet handed to its recipient is never delivered afterwards.`;

type Source = { channel_id: string; message_ts: string } | { input_id: string; run_id: string };
export type SessionCommunicationRequest =
  | { operation: "projects"; body: { source: Source; peer?: string } }
  | { operation: "peers"; body: { source: Source } }
  | { operation: "search"; body: { source: Source; concepts: string[]; limit?: number; peer?: string } }
  | { operation: "context"; body: { source: Source; address: string } }
  | { operation: "ask"; body: { source: Source; action_id: string; address?: string; provider?: string; effort?:string; project?:string; title?: string; text: string; after?: string[]; files?:{name:string;contentType:string;base64:string}[];captureId?:string;requestedEffect?:'informational'|'work'; peer?: string; resurrect?: boolean } }
  | { operation: "note"; body: { source: Source; action_id:string; captureId:string } }
  | { operation: "title"; body: { source: Source; action_id:string; title:string } }
  | { operation: "post"; body: { source: Source; action_id:string; thread:string; text:string } }
  | { operation: "reply"; body: { source: Source; action_id: string; request_id: string; text: string; final: boolean; workDisposition?:'completed'|'failed'|'needs_decision' } }
  | { operation: "get"; body: { source: Source; request_id: string } }
  | { operation: "cancel"; body: { source: Source; action_id: string; request_id: string } };

class SessionUsageError extends Error {}

function invalid(detail: string): never {
  throw new SessionUsageError(detail);
}

export function parseRouterSessionsArgs(argv: string[]): SessionCommunicationRequest {
  const [operation, ...args] = argv;
  if (operation !== "projects" && operation !== "peers" && operation !== "note" && operation !== "title" && operation !== "post" && operation !== "search" && operation !== "context" && operation !== "ask" && operation !== "reply" && operation !== "get" && operation !== "cancel") {
    invalid("Choose a session command: projects, peers, search, context, ask, note, title, post, reply, get, or cancel.");
  }
  const separator = args.indexOf("--");
  const options = separator < 0 ? [...args] : args.slice(0, separator);
  const content = separator < 0 ? [] : args.slice(separator + 1);
  const identity = operation === "projects" || operation === "peers" || operation === "search" || operation === "title" || operation === "post" || operation === "ask" && options[0]?.startsWith('--') ? undefined : options.shift();
  if (operation !== "projects" && operation !== "peers" && operation !== "search" && operation !== "title" && operation !== "post" && operation !== "ask" && (!identity?.trim() || identity.startsWith("--"))) {
    invalid(`${operation} requires an exact ${operation === "context" ? "discovered address" : "request ID"}.`);
  }
  const flags = new Map<string, string>();
  const after: string[] = [];
  const paths: string[] = [];
  let partial = false;
  let resurrect = false;
  while (options.length) {
    const flag = options.shift()!;
    if (flag === "--partial" && operation === "reply") {
      if (partial) invalid("Repeated --partial option.");
      partial = true;
      continue;
    }
    if (flag === "--resurrect" && operation === "ask") {
      if (resurrect) invalid("Repeated --resurrect option.");
      resurrect = true;
      continue;
    }
    const allowed = flag === "--source-channel" || flag === "--source-ts" || flag === "--source-input" || flag === "--source-run"
      || (flag === "--limit" && operation === "search")
      || (flag === "--peer" && (operation === "search" || operation === "projects" || operation === "ask"))
      || (flag === "--resurrect" && operation === "ask")
      || (flag === "--action-id" && (operation === "ask" || operation === "reply" || operation === "note" || operation === "title" || operation === "post" || operation === "cancel"))
      || (flag === "--thread" && operation === "post")
      || (flag === "--provider" && operation === "ask")
      || (flag === "--session-name" && operation === "ask")
      || (["--effort","--project","--file","--capture-id","--requested-effect","--after-request"].includes(flag) && operation === "ask")
      || (flag === '--text-file' && (operation === 'ask' || operation === 'reply' || operation === 'post'))
      || (flag === '--work-disposition' && operation === 'reply');
    if (!allowed) invalid(`Unexpected option or positional argument: ${flag}`);
    const value = options.shift();
    if (!value?.trim() || value.startsWith("--")) invalid(`${flag} requires a value.`);
    if(flag==='--file')paths.push(value);
    else if (flag === "--after-request") {
      if (after.includes(value)) invalid("Repeated dependency request ID.");
      after.push(value);
    } else {
      if (flags.has(flag)) invalid(`Repeated ${flag} option.`);
      flags.set(flag, value);
    }
  }
  const channel = flags.get("--source-channel");
  const timestamp = flags.get("--source-ts");
  const inputId = flags.get("--source-input");
  const runId = flags.get("--source-run");
  let source: Source;
  if (inputId || runId) {
    if (!inputId || !runId || channel || timestamp) invalid("Use exact --source-input and --source-run together, without Slack source flags.");
    source = { input_id: inputId, run_id: runId };
  } else {
    if (!channel && !timestamp) invalid("Provide this input's exact --source-input/--source-run or --source-channel/--source-ts pair.");
    if (!channel || !/^[CGD][A-Z0-9]+$/.test(channel)) invalid("--source-channel requires this input's exact Slack channel ID.");
    if (!timestamp || !/^\d+\.\d+$/.test(timestamp)) invalid("--source-ts requires this input's exact Slack message timestamp.");
    source = { channel_id: channel, message_ts: timestamp };
  }

  const peer=flags.get('--peer');
  if(operation==='projects') {
    if(separator>=0)invalid('projects does not accept text.');
    return {operation,body:{source,...(peer?{peer}:{})}};
  }
  if(operation==='peers') {
    if(separator>=0)invalid('peers does not accept text.');
    return {operation,body:{source}};
  }
  if (operation === "search") {
    if (separator < 0 || content.length < 1 || content.length > 8 || content.some(concept => !concept.trim())) {
      invalid("search requires 1–8 nonempty concepts after --, each quoted as one argument.");
    }
    const rawLimit = flags.get("--limit");
    if (rawLimit !== undefined && (!/^[1-9]\d*$/.test(rawLimit) || !Number.isSafeInteger(Number(rawLimit)))) {
      invalid("--limit requires a positive integer.");
    }
    return { operation, body: { source, concepts: content, ...(rawLimit !== undefined ? { limit: Number(rawLimit) } : {}), ...(peer?{peer}:{}) } };
  }
  if (operation === "context" || operation === "get") {
    if (separator >= 0) invalid(`${operation} does not accept text or a -- separator.`);
    return operation === "context"
      ? { operation, body: { source, address: identity! } }
      : { operation, body: { source, request_id: identity! } };
  }
  const actionId = flags.get("--action-id");
  if (!actionId) invalid(`${operation} requires an explicit stable --action-id.`);
  if(operation==='cancel') {
    if(separator>=0)invalid('cancel does not accept text or a -- separator.');
    return {operation,body:{source,action_id:actionId,request_id:identity!}};
  }
  if(operation==='note') {
    if(separator>=0)invalid('note accepts a capture ID, not replacement source text.');
    return {operation,body:{source,action_id:actionId,captureId:identity!}};
  }
  const textFile=flags.get('--text-file');
  if(textFile) {
    if(separator>=0)invalid('Choose --text-file or text after --.');
    content.push(readFileSync(textFile,'utf8'));
  }
  if ((!textFile && separator < 0) || content.length !== 1 || !content[0]!.trim()) {
    invalid(`${operation} requires exactly one nonempty text argument after --.`);
  }
  if(operation==='title') {
    const title=content[0]!.trim();
    if(title.length>120)invalid('Session title must contain 1–120 characters.');
    return {operation,body:{source,action_id:actionId,title}};
  }
  if(operation==='post') {
    const thread=flags.get('--thread');
    if(!thread)invalid('post requires --thread with the exact message ID the thread is rooted at or continues.');
    return {operation,body:{source,action_id:actionId,thread,text:content[0]!}};
  }
  const provider=flags.get('--provider');
  const title=flags.get('--session-name')?.trim();
  if(title!==undefined&&title.length>120)invalid('--session-name must contain 1–120 characters.');
  if(title!==undefined&&!provider)invalid('--session-name names a newly created session; use the session title action to rename an existing session.');
  const effort=flags.get('--effort'),project=flags.get('--project'),requestedEffect=flags.get('--requested-effect');
  const workDisposition=flags.get('--work-disposition');
  if(workDisposition&&(!['completed','failed','needs_decision'].includes(workDisposition)||partial))
    invalid('--work-disposition requires a final reply and one of completed, failed, or needs_decision.');
  if(effort&&!normalizeReasoningEffort(effort))invalid('Invalid reasoning effort.');
  if(requestedEffect&&!['informational','work'].includes(requestedEffect))invalid('--requested-effect must be informational or work.');
  if(operation==='ask'&&(provider!==undefined?(provider!=='chatgpt'&&!parseProviderSelector(provider)||identity!==undefined):!identity?.trim())) {
    invalid('ask requires either an exact discovered address or --provider with a supported alias.');
  }
  if(!provider&&(project||effort))invalid('--project and --effort require new session creation.');
  if(provider&&provider!=='chatgpt'&&!project)invalid(peer?'New coding sessions on a peer require --project from sessions projects --peer <instance>.':'New coding sessions require --project from sessions projects.');
  if(peer&&after.length)invalid('A peer request cannot wait on --after-request.');
  if(provider==='chatgpt'&&(project||effort))invalid('ChatGPT accepts no project or reasoning effort.');
  const files=paths.map(path=>({name:basename(path),contentType:Bun.file(path).type||'application/octet-stream',base64:readFileSync(path).toString('base64')}));
  return operation === "ask"
    ? { operation, body: { source, action_id: actionId, ...(provider?{provider}:{address:identity!}), ...(title===undefined?{}:{title}), text: content[0]!, ...(after.length ? { after } : {}),...(effort?{effort}:{}),...(project?{project}:{}),...(files.length?{files}:{}),...(flags.has('--capture-id')?{captureId:flags.get('--capture-id')!}:{}),...(requestedEffect?{requestedEffect:requestedEffect as 'informational'|'work'}:{}),...(peer?{peer}:{}),...(resurrect?{resurrect:true}:{}) } }
    : { operation, body: { source, action_id: actionId, request_id: identity!, text: content[0]!, final: !partial,
        ...(workDisposition?{workDisposition:workDisposition as 'completed'|'failed'|'needs_decision'}:{}) } };
}

export function runRouterSessions(request: SessionCommunicationRequest) {
  return requestApiResponse(`/session-communication/${request.operation}`, request.body);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let request: SessionCommunicationRequest | undefined;
  try {
    if (args.length === 1 && (args[0] === "help" || args[0] === "--help")) console.log(usage);
    else {
      request = parseRouterSessionsArgs(args);
      const response = await runRouterSessions(request);
      if (response.ok) console.log(JSON.stringify(response.result));
      else {
        console.error(JSON.stringify(response.result));
        process.exitCode = 1;
      }
    }
  } catch (error) {
    const invalidArguments = error instanceof SessionUsageError;
    console.error(JSON.stringify({
      ok: false,
      error: invalidArguments ? "invalid_session_arguments" : "session_communication_unavailable",
      detail: error instanceof Error ? error.message : String(error),
      ...(invalidArguments ? { usage } : request ? {
        operation: request.operation,
        source: request.body.source,
        ...("action_id" in request.body ? { action_id: request.body.action_id } : {}),
        ...("address" in request.body ? { address: request.body.address } : {}),
        ...("request_id" in request.body ? { request_id: request.body.request_id } : {}),
      } : {}),
    }));
    process.exitCode = invalidArguments ? 2 : 1;
  }
}
