#!/usr/bin/env bun
import { requestApiResponse } from "./router-request-client";
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {parseProviderSelector,normalizeReasoningEffort} from '../src/aliases';
import {REQUEST_PROTOCOL} from '../src/request-protocol';

const usage = `router-actions.sh sessions projects <source-flags> [--peer <instance>]
router-actions.sh projects new <name> --purpose "<one sentence>" [--here-only] [--source-input <id> --source-run <id>]
router-actions.sh projects share <name> --to <machine> [--source-input <id> --source-run <id>]
router-actions.sh projects status <name> [--to <machine>]
router-actions.sh projects cancel <name> --to <machine>  # only before delivery
router-actions.sh sessions peers <source-flags>
router-actions.sh sessions usage <source-flags> [--by-session] [--period today|week]
router-actions.sh sessions reset-credit <source-flags> --action-id A --provider codex [--account <address>] --reason <why>
router-actions.sh sessions search <source-flags> [--limit N] [--peer <instance>] [--thread <message-id>] -- <concept...>
router-actions.sh sessions context <address> <source-flags> [--thread <message-id>]
router-actions.sh sessions ask <address> <source-flags> --action-id A [--thread <message-id>] [--after-request <request-id> ...] -- <text>
router-actions.sh sessions ask --provider <alias> --project <registered-project> [--effort <level>] --session-name <title> [--consult <address>] <source-flags> --action-id A [--file <path> ...] [--capture-id <id>] -- <text>
router-actions.sh sessions ask --provider chatgpt <source-flags> --action-id A -- <text>
router-actions.sh sessions ask --peer <instance> --machine-need "<what only that machine can do>" --provider <alias> --project <peer-project> [--effort <level>] --session-name <title> <source-flags> --action-id A -- <text>
router-actions.sh sessions schedule --at <ISO-8601-time> [--expires <ISO-8601-time>] [--every-ms <interval>] --provider <alias> --project <registered-project> --session-name <title> <source-flags> --action-id A -- <text>
router-actions.sh sessions bank --provider <alias> --project <registered-project> --session-name <title> <source-flags> --action-id A -- <text>
router-actions.sh sessions ask <peer-address|imported-address> <source-flags> --action-id A --resurrect -- <text>
router-actions.sh sessions note <captureId> <source-flags> --action-id A --summary-file <markdown-path> [--add-to <earlier-captureId> | --person <name>]
router-actions.sh sessions title <source-flags> --action-id A -- <title>
router-actions.sh sessions post <source-flags> --action-id A --thread <message-id> [--topic <topicId>] [--keep-working] [--file <path> ...] [--attachment <custody-id> ...] [-- <text>]
router-actions.sh sessions outcome <done|response|needs_you|failed> <source-flags> --action-id A [--quiet-because "<why he need not read this>"] [--only-he-can sign-in|secret|device|ambiguous --his-words "<his exact words>" --why-not-answered "<what they leave open>"] [--text-file F | -- <text>]
router-actions.sh sessions thread <inputId> <source-flags> --action-id A --thread <message-id> | --detach
router-actions.sh sessions reply <request-id> <source-flags> --action-id A [--partial | --work-disposition completed|failed|needs_decision] [--all-done (--checked "<what you ran live and saw>" | --not-checked "<why no live check>")] [--only-he-can sign-in|secret|device|ambiguous --his-words "<his exact words>" --why-not-answered "<what they leave open>"] [--hand-back not-my-subject|too-loaded (with failed)] [--file <path> ...] [--attachment <custody-id> ...] [-- <text>]
router-actions.sh sessions get <request-id> <source-flags>
router-actions.sh sessions cancel <request-id> <source-flags> --action-id A
router-actions.sh sessions saved list <source-flags>
router-actions.sh sessions saved start|cancel <turn-id> <source-flags> --action-id A
router-actions.sh sessions watch file <absolute-path> --until <ISO time | 90s | 30m | 2h | 1d> <source-flags> --action-id A
router-actions.sh sessions watch command --cwd <dir> --until <ISO time | duration> <source-flags> --action-id A -- <argv...>
router-actions.sh sessions watch list <source-flags>
router-actions.sh sessions watch cancel <watch-id> <source-flags> --action-id A

A watch wakes this conversation once, with no model awake meanwhile: when the file or directory changes (a deletion counts), when the command finishes (with its exit code), or at --until, whichever comes first (at most 30 days). One service input watch:<id>:<fired|expired|failed|cancelled> then reaches this session and says what was observed and any gap in observation (a Concierge restart or a sleeping Mac is a recorded gap). Local to this machine; the same --action-id registers nothing twice.

Topics — the Inbox's recognizable conversations. Every mutation takes <source-flags> and --action-id A; --expected-revision N refuses a stale decision.
router-actions.sh sessions topics list <source-flags> [--state open|background|closed|all] [--query q] [--limit N] [--cursor C]
router-actions.sh sessions topics read <topicId> <source-flags> [--limit N]
router-actions.sh sessions topics questions-read <source-flags> [--state open|reading|history|deferred|checking]
router-actions.sh sessions topics resolve <messageId> <source-flags>
router-actions.sh sessions topics create <source-flags> --action-id A --title T [--summary S] [--root <inputId> ...] [--reason R]
router-actions.sh sessions topics place <topicId> <source-flags> --action-id A --root <inputId> [--root ...] [--reason R]
router-actions.sh sessions topics rename <topicId> <source-flags> --action-id A --reason R -- <title>
router-actions.sh sessions topics summary <topicId> <source-flags> --action-id A -- <current fact, one line>
router-actions.sh sessions topics merge <fromTopicId> <source-flags> --action-id A --into <topicId> --reason R
router-actions.sh sessions topics close <topicId> <source-flags> --action-id A --scope <text> -- <reason>
router-actions.sh sessions topics reopen <topicId> <source-flags> --action-id A -- <reason>
router-actions.sh sessions topics request add <topicId> <source-flags> --action-id A --title T [--source <inputId>[:passage] ...] -- <brief>
router-actions.sh sessions topics request amend <requestId> <source-flags> --action-id A [--title T] [--source ...] -- <what changed and why>
router-actions.sh sessions topics request link <requestId> <source-flags> --action-id A --dispatch <communicationRequestId>
router-actions.sh sessions topics request close <requestId> <source-flags> --action-id A --disposition completed|declined|withdrawn|superseded|failed [--evidence <id> ...] -- <reason>
router-actions.sh sessions topics request reopen <requestId> <source-flags> --action-id A -- <reason>
router-actions.sh sessions topics questions <topicId> <source-flags> --action-id A --json-file <file>
router-actions.sh sessions topics question settle <questionId> <source-flags> --action-id A --state answered|declined|withdrawn|superseded|deferred [--answer <inputId>] [--replacement <questionId>] -- <reason>
router-actions.sh sessions topics answer <inputId> <source-flags> --action-id A --json-file <file>
router-actions.sh sessions topics acknowledge <topicId> <source-flags> --action-id A --item <questionId|messageId> [...] --source <inputId>
router-actions.sh sessions topics file <topicId> <source-flags> --action-id A --need <attention entry id> [--reason R]
router-actions.sh sessions topics focus <topicId> <source-flags> --action-id A [--input <inputId> ...] -- <what the router is doing>
router-actions.sh sessions topics release <source-flags> --action-id A [--input <inputId> ...]

A topic owns thread roots, the human requests inside them, the questions waiting on Tejas and the router's declared focus. Place a capture before routing or answering it. topics questions takes the reconciliation JSON array (--json-file); topics answer takes {"mappings":[…],"unresolved":[…],"acknowledged":[…]}. Only this Inbox may change topics; a worker session may call topics questions/read for a topic it holds a linked dispatch for. sessions post releases focus for the inputs it covers unless --keep-working.

Every command requires one exact source pair:
  --source-input <inputId> --source-run <runId> from this concierge-session-input identity header's input.id and input.runId
  --source-channel <channelId> --source-ts <messageTs> from this input's slack-message-context
Do not mix source pairs. No source or run is inferred from the environment.
Search returns {results:[{session,evidence}],coverage} for both source forms.
Copy results[i].session.address and returned request IDs exactly. A concierge:<id> is not an address. The service chooses delivery.
Continue the session that owns the surface when search/context establish one unambiguous, messageable live or recently completed owner. Title, project, source and dialogue must show ownership; topical similarity and consultation-only evidence are insufficient. Clarify ambiguous ownership. When no session owns the work or the surface differs, use --provider cc-opus to create a fresh native session and first input. Each local candidate in search and context carries workload: context in use, running or idle, and the open Inbox topics it holds; with --thread (else the topic your work started from), forTopic says whether it already holds that topic. You choose. A new topic is best started fresh with --consult <address>, which gives the new session a pointer to the earlier one to ask for context informationally. The receiving session judges fit: it may hand a request back (failed with --hand-back not-my-subject|too-loaded), and its answer then opens with that and the ready-made fresh command; send it there. A human's explicit session/provider/model/effort choice takes precedence. An addressed ask requires the exact discovered address. A registered project with its own selected default keeps that selection. Codex/Claude require --project from sessions projects; the owner resolves its cwd. ChatGPT accepts no project or effort. No provider fallback or Slack publication occurs.
Supply --session-name "Meaningful topic" for that new session. It uses the same canonical title shown in Thinkering.
Use sessions title from an admitted run to name its own session, including renaming one it or its creator named badly. A title Tejas set himself is preserved.
Use sessions outcome once per live turn with that input's exact native source pair and a stable action ID. done takes no text; response says what to read, needs_you asks one question, and failed says why. Ask Tejas only for what no agent can do: needs_you (and a reply's --work-disposition needs_decision) requires --only-he-can sign-in|secret|device|ambiguous (ambiguous: readings of his words that lead to different things that cannot be undone), --his-words copied exactly from his message that started the work, and --why-not-answered; permission, approval and design choices are refused, because he said "just do as I say and fix or build things if it's not possible. Ask for forgiveness not permission". Do the work, build what is missing, and tell him afterwards. A reply with --work-disposition completed requires --all-done (everything he asked for was done; when part was not, do it, have it built, or reply failed saying what) and --checked, what you exercised on the real system (his surfaces through your own entrance, test-capture) and what you saw, or --not-checked with why no live check was possible; both are shown with your answer. Do not write unit tests to fill it. A turn that answers a message Tejas sent himself cannot end done without --quiet-because "<why he need not read this>": the owner refuses it, and a turn that ends without declaring is recorded as a response so he is told; the reason is shown under your reply. A turn that already answered with sessions post and declared its outcome needs no closing text. A turn opened by another agent's return or request into a thread must post its answer there before declaring; its closing text never shows in the thread, and an unposted one is relayed there by the owner as your reply.
Use sessions thread when one of his captures continues a thread you asked about, instead of opening a new request: name that accepted input and the thread's message ID. Use --detach to return it to its own row when it was not a reply. His own thread replies already carry their link; never thread one of those.
An Inbox request names the thread it works for: sessions ask … --thread <message-id> (the capture, reply or post the work is for). The owner refuses an Inbox ask without it, or naming a message that is not in the Inbox or whose thread is not yet placed, before anything is sent; it records the thread on the request, and its Timeline lists the dispatch, whatever input started the turn that sent it. The agent's own replies to a work request you sent for a thread are posted into that thread by the owner as the agent's words the moment they arrive, and a final one is filed for Tejas there (a question for needs_decision, a reading item otherwise, with his notification) and closes the thread request it is linked to when done; they never come back to you, and your next turn in that thread lists them as agentAnswers. Hand-backs, stalls, the owner's own settlements and answers to informational asks still return to you. A turn that asks or posts for another thread has its closing text kept out of every thread's Conversation; answer each thread with its own post. Use sessions post to answer a thread of your own Inbox deliberately: --thread is the exact message ID the thread is rooted at or continues. The post becomes the thread's reply; your other working output does not. Only the Inbox accepts posts. A post starts no turn and owes no reply.
Use --text-file <path> instead of -- <text> for long prompts. Repeated --file retains exact bytes before dispatch; local paths are never sent to the owner. --capture-id includes retained Inbox source bytes and attachments. Forward only material authorized by the current human request.
Answer a request or a thread with files: repeated --file <path> sends your own bytes, and repeated --attachment <custody-id> forwards an already retained file (a worker's returned image) without downloading it. ask, reply and post all take both. A reply or post carrying at least one file may omit its text; with neither text nor a file it is refused. The owner retains every file before it acknowledges the reply, and a retry with the same action ID and different bytes conflicts rather than sending a second copy.
Use distinct action IDs for distinct asks/replies; retries retain the original source, action ID and payload.
Sessions live on several Concierge instances (sessions peers lists them; mac is Tejas's laptop). sessions search covers every instance by default, from the transcript archive on this instance first — it holds both machines' history and answers whether the peer is on or off — plus the live peer when it answers: a session on a peer carries id <peer>:<n>, address <peer>/session:… and availability {reachable,note}; coverage.peers says which peers answered. sessions ask/context take that address as they take any other, so a session is addressed the same way wherever it runs. Each peer session's availability.state is live (the running peer confirmed it) or archived-only (found in the transcript archive or the peer's last catalogue; the peer did not confirm). When the peer is offline, search still returns its sessions as archived-only, an ask is accepted with status queued_offline and delivered when the peer wakes (its receipt says so; never a hard failure), and context comes from the archived transcript. sessions ask <peer-address> --resurrect keeps the existing archive-copy behavior: it starts a distinct session here from the mirrored transcript. sessions ask <imported-address> --resurrect continues that provider UUID in its original folder on the owning machine, provided the folder and transcript are present there; an unavailable machine refuses the action. Use --peer <instance> only to restrict search/projects to one instance or to create a new session there (sessions ask --peer <instance> --provider … --project <its project>). New work runs here, on the always-on server. A session goes on the Mac only for what the Mac alone can do — its Messages app, Xcode or the Simulator, a file or app that exists only there, a screenshot — or when Tejas names the Mac; creating one there requires --machine-need saying which, and the owner refuses it without. The laptop sleeps, so work that merely could run there, or whose last session happened to run there, runs here. The request keeps its return obligation here; the peer session replies with the ordinary sessions reply on its own machine. A peer request cannot use --after-request.
${REQUEST_PROTOCOL}
A run that follows an interruption can still answer requests delivered to the earlier run.
--after-request waits for the named request to settle. When it settles without confirmed success (decision needed, or an older request settled unanswered or undetermined), a request you asked before that outcome reached you stays held for your decision: cancel it with sessions cancel, or ask again. A request you ask after seeing that outcome is your decision and is delivered.
Use sessions cancel <request-id> to withdraw your own request, for example one you have superseded; a request not yet handed to its recipient is never delivered afterwards, and a worker already holding it is told to stop.`;

type Source = { channel_id: string; message_ts: string } | { input_id: string; run_id: string };
export type SessionCommunicationRequest =
  | { operation: "projects"; body: { source: Source; peer?: string } }
  | { operation: "peers"; body: { source: Source } }
  | { operation: "usage"; body: { source: Source; by_session?:boolean; period?:'today'|'week' } }
  | { operation: "reset-credit"; body: { source: Source; action_id: string; provider: string; account?: string; reason: string } }
  | { operation: "search"; body: { source: Source; concepts: string[]; limit?: number; peer?: string; thread?: string } }
  | { operation: "context"; body: { source: Source; address: string; thread?: string } }
  | { operation: "ask"; body: { source: Source; action_id: string; address?: string; provider?: string; effort?:string; project?:string; title?: string; text: string; after?: string[]; files?:{name:string;contentType:string;base64:string}[];captureId?:string;requestedEffect?:'informational'|'work'; peer?: string; machine_need?: string; consult?: string; resurrect?: boolean;saved?:{kind:'scheduled'|'banked';atMs?:number;expiresAtMs?:number;repeatEveryMs?:number} } }
  | { operation: "note"; body: { source: Source; action_id:string; captureId:string; summary:string; addTo?:string; person?:string } }
  | { operation: "title"; body: { source: Source; action_id:string; title:string } }
  | { operation: "post"; body: { source: Source; action_id:string; thread:string; text:string; topic?:string; keep_working?:boolean; attachments?:string[]; files?:{name:string;contentType:string;base64:string}[] } }
  | { operation: "outcome"; body: { source: Source; action_id:string; outcome:'done'|'response'|'needs_you'|'failed'; text?:string; quiet_because?:string; his_words?:string; why_not_answered?:string; only_he_can?:string } }
  | { operation: "topics"; body: { source: Source; verb: string; action_id?: string; [key: string]: unknown } }
  | { operation: "thread"; body: { source: Source; action_id:string; input_id:string; thread?:string; detach?:boolean } }
  | { operation: "reply"; body: { source: Source; action_id: string; request_id: string; text: string; final: boolean; workDisposition?:'completed'|'failed'|'needs_decision'; attachments?:string[]; files?:{name:string;contentType:string;base64:string}[]; his_words?:string; why_not_answered?:string; only_he_can?:string; checked?:string; not_checked?:string; all_done?:boolean; hand_back?:string } }
  | { operation: "get"; body: { source: Source; request_id: string } }
  | { operation: "cancel"; body: { source: Source; action_id: string; request_id: string } }
  | { operation: "watch"; body: { source: Source; verb: 'file'|'command'|'list'|'cancel'; action_id?: string; until?: string; path?: string; argv?: string[]; cwd?: string; watch_id?: string } }
  | { operation: "saved"; body: { source: Source; verb:'list'|'start'|'cancel'; turn_id?:number; action_id?:string } };

class SessionUsageError extends Error {}

function invalid(detail: string): never {
  throw new SessionUsageError(detail);
}

/** The one exact accepted source every command carries, in either of its two forms. */
function sourceFrom(flags: Map<string, string>): Source {
  const channel = flags.get("--source-channel");
  const timestamp = flags.get("--source-ts");
  const inputId = flags.get("--source-input");
  const runId = flags.get("--source-run");
  if (inputId || runId) {
    if (!inputId || !runId || channel || timestamp) invalid("Use exact --source-input and --source-run together, without Slack source flags.");
    return { input_id: inputId, run_id: runId };
  }
  if (!channel && !timestamp) invalid("Provide this input's exact --source-input/--source-run or --source-channel/--source-ts pair.");
  if (!channel || !/^[CGD][A-Z0-9]+$/.test(channel)) invalid("--source-channel requires this input's exact Slack channel ID.");
  if (!timestamp || !/^\d+\.\d+$/.test(timestamp)) invalid("--source-ts requires this input's exact Slack message timestamp.");
  return { channel_id: channel, message_ts: timestamp };
}

const TOPIC_VERBS = ["list","read","resolve","questions-read","create","place","rename","summary","merge","close","reopen","request","questions","question","answer","acknowledge","focus","release","file"];
const TOPIC_REPEATABLE = ["--root","--source","--item","--input","--evidence"];
const TOPIC_SINGLE = ["--source-channel","--source-ts","--source-input","--source-run","--action-id","--title","--summary","--reason",
  "--into","--scope","--dispatch","--disposition","--json-file","--state","--answer","--replacement","--limit","--cursor","--query","--expected-revision","--need"];
/** `sessions topics <verb> …`: parsed here, dispatched as one operation to the coordinator. */
function parseTopicsArgs(args: string[]): SessionCommunicationRequest {
  const separator = args.indexOf("--");
  const options = separator < 0 ? [...args] : args.slice(0, separator);
  const content = separator < 0 ? [] : args.slice(separator + 1);
  const head = options.shift();
  if (!head || !TOPIC_VERBS.includes(head)) invalid(`Choose a topics command: ${TOPIC_VERBS.join(", ")}.`);
  let verb = head!;
  if (head === "request") {
    const sub = options.shift();
    if (!sub || !["add","amend","link","close","reopen"].includes(sub)) invalid("topics request takes add, amend, link, close or reopen.");
    verb = `request.${sub}`;
  }
  if (head === "question") {
    const sub = options.shift();
    if (sub !== "settle") invalid("topics question takes settle.");
    verb = "question.settle";
  }
  const identified = !["list","create","release","questions-read"].includes(verb);
  let identity: string | undefined;
  if (identified) {
    identity = options.shift();
    if (!identity?.trim() || identity.startsWith("--")) invalid(`topics ${verb.replace(".", " ")} requires its exact id.`);
  }
  const flags = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  while (options.length) {
    const flag = options.shift()!;
    if (!TOPIC_REPEATABLE.includes(flag) && !TOPIC_SINGLE.includes(flag)) invalid(`Unexpected option or positional argument: ${flag}`);
    const value = options.shift();
    if (value === undefined || !value.trim() || value.startsWith("--")) invalid(`${flag} requires a value.`);
    if (TOPIC_REPEATABLE.includes(flag)) repeated.set(flag, [...(repeated.get(flag) ?? []), value]);
    else {
      if (flags.has(flag)) invalid(`Repeated ${flag} option.`);
      flags.set(flag, value);
    }
  }
  const source = sourceFrom(flags);
  const mutating = !["list","read","resolve","questions-read"].includes(verb);
  const actionId = flags.get("--action-id");
  if (mutating && !actionId) invalid(`topics ${verb.replace(".", " ")} requires an explicit stable --action-id.`);
  const takesText = ["rename","summary","close","reopen","request.add","request.amend","request.close","request.reopen","question.settle","focus"].includes(verb);
  if (takesText && (separator < 0 || content.length !== 1 || !content[0]!.trim())) invalid(`topics ${verb.replace(".", " ")} requires exactly one nonempty text argument after --.`);
  if (!takesText && separator >= 0) invalid(`topics ${verb.replace(".", " ")} does not accept text after --.`);
  const body: Record<string, unknown> = { source, verb, ...(actionId ? { action_id: actionId } : {}) };
  const copy = (flag: string, field: string) => { if (flags.has(flag)) body[field] = flags.get(flag); };
  copy("--reason", "reason"); copy("--title", "title"); copy("--into", "into"); copy("--scope", "scope");
  copy("--dispatch", "dispatch"); copy("--disposition", "disposition"); copy("--state", "state");
  copy("--answer", "answer"); copy("--replacement", "replacement"); copy("--query", "query"); copy("--cursor", "cursor"); copy("--need", "need");
  if (flags.has("--summary")) body.summary = flags.get("--summary");
  if (flags.has("--limit")) {
    if (!/^[1-9]\d*$/.test(flags.get("--limit")!)) invalid("--limit requires a positive integer.");
    body.limit = Number(flags.get("--limit"));
  }
  if (flags.has("--expected-revision")) {
    if (!/^\d+$/.test(flags.get("--expected-revision")!)) invalid("--expected-revision requires a whole number.");
    body.expected_revision = Number(flags.get("--expected-revision"));
  }
  if (repeated.has("--root")) body.roots = repeated.get("--root");
  if (repeated.has("--source")) body.sources = repeated.get("--source");
  if (repeated.has("--item")) body.items = repeated.get("--item");
  if (repeated.has("--input")) body.inputs = repeated.get("--input");
  if (repeated.has("--evidence")) body.evidence = repeated.get("--evidence");
  if (verb === "acknowledge") {
    const sources = repeated.get("--source");
    if (!sources || sources.length !== 1) invalid("topics acknowledge requires one --source naming the message he acknowledged with.");
    body.source_input = sources[0];
    delete body.sources;
  }
  if (verb === "questions" || verb === "answer") {
    const path = flags.get("--json-file");
    if (!path) invalid(`topics ${verb} requires --json-file with its reconciliation JSON.`);
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(path, "utf8")); }
    catch (error) { invalid(`--json-file could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`); }
    if (verb === "questions") {
      if (!Array.isArray(parsed)) invalid("topics questions expects a JSON array of question declarations.");
      body.questions = parsed;
    } else {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid("topics answer expects a JSON object with mappings.");
      body.answer = parsed;
    }
  }
  if (identity) {
    if (verb === "resolve") body.message_id = identity;
    // `request add` opens a request inside a topic; the other request verbs name the request.
    else if (verb.startsWith("request.") && verb !== "request.add") body.request_id = identity;
    else if (verb === "question.settle") body.question_id = identity;
    else if (verb === "answer") body.input_id = identity;
    else body.topic_id = identity;
  }
  if (takesText) {
    const value = content[0]!;
    if (verb === "rename") body.title = value;
    else if (verb === "summary" || verb === "focus") body.summary = value;
    else if (verb === "request.add") body.brief = value;
    else body.reason = value;
  }
  return { operation: "topics", body: body as { source: Source; verb: string } } as SessionCommunicationRequest;
}

export function parseRouterSessionsArgs(argv: string[]): SessionCommunicationRequest {
  const [first, ...args] = argv;
  if(first==='saved') {
    const sub=args.shift();
    if(sub!=='list'&&sub!=='start'&&sub!=='cancel')invalid('saved takes list, start or cancel.');
    const turnId=sub==='list'?undefined:args.shift();
    if(sub!=='list'&&(!turnId||!/^[1-9]\d*$/.test(turnId)||!Number.isSafeInteger(Number(turnId))))invalid('Name the exact saved turn ID.');
    const flags=new Map<string,string>();
    while(args.length){const flag=args.shift()!,value=args.shift();
      if(!['--source-channel','--source-ts','--source-input','--source-run','--action-id'].includes(flag)||!value?.trim()||flags.has(flag))invalid('Invalid saved work option.');
      flags.set(flag,value);
    }
    const source=sourceFrom(flags),actionId=flags.get('--action-id');
    if(sub==='list'&&actionId)invalid('Listing saved work takes no action ID.');
    if(sub!=='list'&&!actionId)invalid('Saved work control needs --action-id.');
    return {operation:'saved',body:{source,verb:sub, ...(turnId?{turn_id:Number(turnId)}:{}),...(actionId?{action_id:actionId}:{})}};
  }
  if(first==='watch') {
    const sub=args.shift();
    if(sub!=='file'&&sub!=='command'&&sub!=='list'&&sub!=='cancel')invalid('watch takes file, command, list or cancel.');
    const separatorAt=args.indexOf('--');
    const options=separatorAt<0?[...args]:args.slice(0,separatorAt);
    const argv=separatorAt<0?[]:args.slice(separatorAt+1);
    const target=sub==='file'||sub==='cancel'?options.shift():undefined;
    if((sub==='file'||sub==='cancel')&&(!target||target.startsWith('--')))invalid(sub==='file'?'watch file needs the absolute path to watch.':'watch cancel needs the watch id.');
    const flags=new Map<string,string>();
    while(options.length){const flag=options.shift()!,value=options.shift();
      if(!['--source-input','--source-run','--source-channel','--source-ts','--action-id','--until','--cwd'].includes(flag)||!value?.trim()||flags.has(flag))invalid(`Invalid watch option ${flag}.`);
      flags.set(flag,value);
    }
    const source=sourceFrom(flags),actionId=flags.get('--action-id'),until=flags.get('--until'),cwd=flags.get('--cwd');
    if(sub!=='list'&&!actionId)invalid('watch needs a stable --action-id.');
    if((sub==='file'||sub==='command')&&!until)invalid('watch needs --until.');
    if(sub==='command') {
      if(!cwd)invalid('watch command needs --cwd.');
      if(!argv.length)invalid('watch command needs the command after --.');
    } else if(separatorAt>=0||cwd)invalid(`watch ${sub} takes no command or --cwd.`);
    if(sub!=='file'&&sub!=='command'&&until)invalid(`watch ${sub} takes no --until.`);
    // A bare command name becomes the path the agent's own shell would run.
    const resolved=sub==='command'&&!argv[0]!.includes('/')?(Bun.which(argv[0]!)??argv[0]!):argv[0];
    return {operation:'watch',body:{source,verb:sub,...(actionId?{action_id:actionId}:{}),...(until?{until}:{}),
      ...(sub==='file'?{path:target!}:{}),...(sub==='cancel'?{watch_id:target!}:{}),
      ...(sub==='command'?{argv:[resolved!,...argv.slice(1)],cwd:cwd!}:{})}};
  }
  const savedKind=first==='schedule'?'scheduled':first==='bank'?'banked':null;
  const operation=savedKind?'ask':first;
  const outcome = operation === 'outcome' ? args.shift() : undefined;
  if(operation==='outcome'&&!['done','response','needs_you','failed'].includes(outcome??''))invalid('outcome requires done, response, needs_you or failed.');
  if (operation === "topics") return parseTopicsArgs(args);
  if (operation !== "projects" && operation !== "peers" && operation !== "usage" && operation !== "reset-credit" && operation !== "note" && operation !== "title" && operation !== "post" && operation !== "outcome" && operation !== "thread" && operation !== "search" && operation !== "context" && operation !== "ask" && operation !== "reply" && operation !== "get" && operation !== "cancel") {
    invalid("Choose a session command: thread, topics, projects, peers, usage, reset-credit, search, context, ask, note, title, post, outcome, reply, get, or cancel.");
  }
  const separator = args.indexOf("--");
  const options = separator < 0 ? [...args] : args.slice(0, separator);
  const content = separator < 0 ? [] : args.slice(separator + 1);
  const identity = operation === "projects" || operation === "peers" || operation === "usage" || operation === "reset-credit" || operation === "search" || operation === "title" || operation === "post" || operation === "outcome" || operation === "ask" && options[0]?.startsWith('--') ? undefined : options.shift();
  if (operation !== "projects" && operation !== "peers" && operation !== "usage" && operation !== "reset-credit" && operation !== "search" && operation !== "title" && operation !== "post" && operation !== "outcome" && operation !== "ask" && (!identity?.trim() || identity.startsWith("--"))) {
    invalid(`${operation} requires an exact ${operation === "context" ? "discovered address" : "request ID"}.`);
  }
  const flags = new Map<string, string>();
  const after: string[] = [];
  const paths: string[] = [];
  const custody: string[] = [];
  let partial = false;
  let allDone = false;
  let detach = false;
  let resurrect = false;
  let keepWorking = false;
  let bySession = false;
  while (options.length) {
    const flag = options.shift()!;
    if(flag==='--by-session'&&operation==='usage'){
      if(bySession)invalid('Repeated --by-session option.');
      bySession=true;continue;
    }
    if (flag === "--keep-working" && operation === "post") {
      if (keepWorking) invalid("Repeated --keep-working option.");
      keepWorking = true;
      continue;
    }
    if (flag === "--detach" && operation === "thread") {
      if (detach) invalid("Repeated --detach option.");
      detach = true;
      continue;
    }
    if (flag === "--all-done" && operation === "reply") {
      if (allDone) invalid("Repeated --all-done option.");
      allDone = true;
      continue;
    }
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
      || (flag==='--period'&&operation==='usage')
      || (flag === "--limit" && operation === "search")
      || ((flag === "--provider" || flag === "--account" || flag === "--reason") && operation === "reset-credit")
      || (flag === "--peer" && (operation === "search" || operation === "projects" || operation === "ask"))
      || (flag === "--resurrect" && operation === "ask")
      || (flag === "--action-id" && (operation === "reset-credit" || operation === "ask" || operation === "reply" || operation === "note" || operation === "title" || operation === "post" || operation === "outcome" || operation === "thread" || operation === "cancel"))
      || (flag === "--thread" && (operation === "post" || operation === "thread" || operation === "ask" || operation === "search" || operation === "context"))
      || (flag === "--topic" && operation === "post")
      || (flag === "--provider" && operation === "ask")
      || (flag === "--at" && savedKind==='scheduled')
      || (flag === "--expires" && savedKind==='scheduled')
      || (flag === "--every-ms" && savedKind==='scheduled')
      || (flag === "--session-name" && operation === "ask")
      || (["--effort","--project","--capture-id","--requested-effect","--after-request"].includes(flag) && operation === "ask")
      // A reply or post carries files the same way an ask does: own bytes, or already
      // retained custody a router forwards without downloading it.
      || (["--file","--attachment"].includes(flag) && (operation === "ask" || operation === "reply" || operation === "post"))
      || (flag === '--summary-file' && operation === 'note')
      || (flag === '--add-to' && operation === 'note')
      || (flag === '--person' && operation === 'note')
      || (flag === '--text-file' && (operation === 'ask' || operation === 'reply' || operation === 'post' || operation === 'outcome'))
      || (flag === '--quiet-because' && operation === 'outcome')
      || ((flag === '--his-words' || flag === '--why-not-answered' || flag === '--only-he-can') && (operation === 'outcome' || operation === 'reply'))
      || ((flag === '--checked' || flag === '--not-checked' || flag === '--hand-back') && operation === 'reply')
      || (flag === '--machine-need' && operation === 'ask')
      || (flag === '--consult' && operation === 'ask')
      || (flag === '--work-disposition' && operation === 'reply');
    if (!allowed) invalid(`Unexpected option or positional argument: ${flag}`);
    const value = options.shift();
    if (!value?.trim() || value.startsWith("--")) invalid(`${flag} requires a value.`);
    if(flag==='--file')paths.push(value);
    else if(flag==='--attachment') {
      if(custody.includes(value))invalid('Repeated --attachment custody ID.');
      custody.push(value);
    }
    else if (flag === "--after-request") {
      if (after.includes(value)) invalid("Repeated dependency request ID.");
      after.push(value);
    } else {
      if (flags.has(flag)) invalid(`Repeated ${flag} option.`);
      flags.set(flag, value);
    }
  }
  const source: Source = sourceFrom(flags);

  const peer=flags.get('--peer');
  if(operation==='projects') {
    if(separator>=0)invalid('projects does not accept text.');
    return {operation,body:{source,...(peer?{peer}:{})}};
  }
  if(operation==='peers') {
    if(separator>=0)invalid('peers does not accept text.');
    return {operation,body:{source}};
  }
  if(operation==='usage') {
    if(separator>=0)invalid('usage does not accept text.');
    const period=flags.get('--period');
    if(period!==undefined&&!bySession)invalid('--period requires --by-session.');
    if(period!==undefined&&period!=='today'&&period!=='week')invalid('--period requires today or week.');
    return {operation,body:{source,...(bySession?{by_session:true,period:(period??'today') as 'today'|'week'}:{})}};
  }
  if (operation === "search") {
    if (separator < 0 || content.length < 1 || content.length > 8 || content.some(concept => !concept.trim())) {
      invalid("search requires 1–8 nonempty concepts after --, each quoted as one argument.");
    }
    const rawLimit = flags.get("--limit");
    if (rawLimit !== undefined && (!/^[1-9]\d*$/.test(rawLimit) || !Number.isSafeInteger(Number(rawLimit)))) {
      invalid("--limit requires a positive integer.");
    }
    return { operation, body: { source, concepts: content, ...(rawLimit !== undefined ? { limit: Number(rawLimit) } : {}), ...(peer?{peer}:{}), ...(flags.has('--thread')?{thread:flags.get('--thread')!}:{}) } };
  }
  if (operation === "context" || operation === "get") {
    if (separator >= 0) invalid(`${operation} does not accept text or a -- separator.`);
    return operation === "context"
      ? { operation, body: { source, address: identity!, ...(flags.has('--thread')?{thread:flags.get('--thread')!}:{}) } }
      : { operation, body: { source, request_id: identity! } };
  }
  const actionId = flags.get("--action-id");
  if (!actionId) invalid(`${operation} requires an explicit stable --action-id.`);
  if(operation==='cancel') {
    if(separator>=0)invalid('cancel does not accept text or a -- separator.');
    return {operation,body:{source,action_id:actionId,request_id:identity!}};
  }
  // A planner asks for a grant to be spent; the owner's policy decides. The caller never
  // names a window, because a grant cannot be aimed at one: it carries its own reset type
  // and the provider reports which windows it cleared only afterwards.
  if(operation==='reset-credit') {
    if(separator>=0)invalid('reset-credit takes --reason, not text after --.');
    const provider=flags.get('--provider');
    if(provider!=='codex')invalid('--provider codex is required; no other provider grants resets to spend.');
    const reason=flags.get('--reason')?.trim();
    if(!reason)invalid('--reason is required: say what the spend is for, so the decision is readable later.');
    const account=flags.get('--account')?.trim();
    if(flags.has('--account')&&!account)invalid('--account takes the account address, or leave it off to let the policy choose.');
    return {operation,body:{source,action_id:actionId,provider,reason,...(account?{account}:{})}};
  }
  if(operation==='thread') {
    if(separator>=0)invalid('thread places an accepted input; it accepts no text.');
    const placement=flags.get('--thread');
    if(detach===!!placement)invalid('thread requires either --thread <message-id> or --detach.');
    return {operation,body:{source,action_id:actionId,input_id:identity!,...(detach?{detach:true}:{thread:placement!})}};
  }
  if(operation==='note') {
    if(separator>=0)invalid('note accepts a capture ID, not replacement source text.');
    // The note is a summary of the capture; his own words stay its source (Tejas, 2026-10-01:
    // "you should not dump my whole transcript here ... create like a nice bulleted list").
    const summaryFile=flags.get('--summary-file');
    if(!summaryFile)invalid('note needs --summary-file: a Markdown file with a title line and "- " bullets summarizing what he said, without the spoken command. His words stay the note\'s Source.');
    const summary=readFileSync(summaryFile!,'utf8');
    if(!summary.trim())invalid('The summary file is empty.');
    // A follow-up to a thread whose note already exists joins that note as a new section
    // (Tejas, 2026-10-01: "if my platform is built on threads ... where can I find the idea").
    const addTo=flags.get('--add-to');
    if(addTo!==undefined&&!/^[0-9a-f]{64}$/.test(addTo))invalid('--add-to takes the earlier capture ID whose note this one follows up.');
    // A fact about a person goes into that person's one note in thnkr.ing (Tejas, 2026-10-07:
    // "start a thread for each person and keep adding to a central note").
    const person=flags.get('--person')?.trim();
    if(flags.has('--person')&&!person)invalid('--person takes the person\'s name, as he says it.');
    if(person&&addTo)invalid('A note goes to one place: --person or --add-to, not both.');
    return {operation,body:{source,action_id:actionId,captureId:identity!,summary,...(addTo?{addTo}:{}),...(person?{person}:{})}};
  }
  if(operation==='outcome') {
    const textFile=flags.get('--text-file');
    if(textFile) {
      if(separator>=0)invalid('Choose --text-file or text after --.');
      content.push(readFileSync(textFile,'utf8'));
    }
    const quiet=flags.get('--quiet-because');
    if(quiet!==undefined&&outcome!=='done')invalid('--quiet-because belongs to done: it says why he need not read the answer.');
    if(outcome==='done') {
      if(separator>=0||textFile||content.length)invalid('done takes no text.');
      return {operation,body:{source,action_id:actionId,outcome,...(quiet?{quiet_because:quiet}:{})}};
    }
    if((!textFile&&separator<0)||content.length!==1||!content[0]?.trim())invalid(`${outcome} requires one nonempty text argument.`);
    const hisWords=flags.get('--his-words'),why=flags.get('--why-not-answered'),onlyHeCan=flags.get('--only-he-can');
    if((hisWords!==undefined||why!==undefined||onlyHeCan!==undefined)&&outcome!=='needs_you')invalid('--his-words, --why-not-answered and --only-he-can belong to needs_you.');
    return {operation,body:{source,action_id:actionId,outcome:outcome as 'response'|'needs_you'|'failed',text:content[0]!.trim(),
      ...(hisWords!==undefined?{his_words:hisWords}:{}),...(why!==undefined?{why_not_answered:why}:{}),...(onlyHeCan!==undefined?{only_he_can:onlyHeCan}:{})}};
  }
  const textFile=flags.get('--text-file');
  if(textFile) {
    if(separator>=0)invalid('Choose --text-file or text after --.');
    content.push(readFileSync(textFile,'utf8'));
  }
  // A reply or post that is only files is a valid message; with neither text nor a file
  // there is nothing to say.
  const attachmentOnly=(operation==='reply'||operation==='post')&&!!(paths.length||custody.length);
  if (attachmentOnly ? content.length > 1 : ((!textFile && separator < 0) || content.length !== 1 || !content[0]!.trim())) {
    invalid(attachmentOnly ? `${operation} accepts at most one text argument after --.`
      : `${operation} requires exactly one nonempty text argument after --.`);
  }
  const message=content[0]??'';
  const files=paths.map(path=>({name:basename(path),contentType:Bun.file(path).type||'application/octet-stream',base64:readFileSync(path).toString('base64')}));
  const attached={...(custody.length?{attachments:custody}:{}),...(files.length?{files}:{})};
  if(operation==='title') {
    const title=content[0]!.trim();
    if(title.length>120)invalid('Session title must contain 1–120 characters.');
    return {operation,body:{source,action_id:actionId,title}};
  }
  if(operation==='post') {
    const thread=flags.get('--thread');
    if(!thread)invalid('post requires --thread with the exact message ID the thread is rooted at or continues.');
    return {operation,body:{source,action_id:actionId,thread,text:message,...attached,
      ...(flags.has('--topic')?{topic:flags.get('--topic')!}:{}),...(keepWorking?{keep_working:true}:{})}};
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
  if(savedKind) {
    if(!provider||provider==='chatgpt'||identity||peer||after.length||!title)invalid('Saved work needs a named new local coding session.');
    if(savedKind==='scheduled'&&(!flags.get('--at')||!Number.isFinite(Date.parse(flags.get('--at')!))||Date.parse(flags.get('--at')!)<=Date.now()))
      invalid('schedule requires --at with a future ISO-8601 time.');
    if(flags.has('--expires')&&(!Number.isFinite(Date.parse(flags.get('--expires')!))||Date.parse(flags.get('--expires')!)<=Date.parse(flags.get('--at')!)))
      invalid('--expires must follow --at.');
    if(flags.has('--every-ms')&&(!/^\d+$/.test(flags.get('--every-ms')!)||Number(flags.get('--every-ms'))<60_000))
      invalid('--every-ms requires an interval of at least one minute.');
  }
  return operation === "ask"
    ? { operation, body: { source, action_id: actionId, ...(provider?{provider}:{address:identity!}), ...(title===undefined?{}:{title}), text: content[0]!, ...(after.length ? { after } : {}),...(effort?{effort}:{}),...(project?{project}:{}),...attached,...(flags.has('--thread')?{thread:flags.get('--thread')!}:{}),...(flags.has('--capture-id')?{captureId:flags.get('--capture-id')!}:{}),...(requestedEffect?{requestedEffect:requestedEffect as 'informational'|'work'}:{}),...(peer?{peer}:{}),...(flags.has('--machine-need')?{machine_need:flags.get('--machine-need')!}:{}),...(flags.has('--consult')?{consult:flags.get('--consult')!}:{}),...(resurrect?{resurrect:true}:{}),...(savedKind?{saved:{kind:savedKind,...(savedKind==='scheduled'?{atMs:Date.parse(flags.get('--at')!)}:{}),...(flags.has('--expires')?{expiresAtMs:Date.parse(flags.get('--expires')!)}:{}),...(flags.has('--every-ms')?{repeatEveryMs:Number(flags.get('--every-ms'))}:{})}}:{}) } }
    : { operation, body: { source, action_id: actionId, request_id: identity!, text: message, final: !partial,
        ...(workDisposition?{workDisposition:workDisposition as 'completed'|'failed'|'needs_decision'}:{}),...attached,
        ...Object.fromEntries([['--his-words','his_words'],['--why-not-answered','why_not_answered'],['--only-he-can','only_he_can'],['--checked','checked'],['--not-checked','not_checked'],['--hand-back','hand_back']]
          .filter(([flag])=>flags.has(flag)).map(([flag,key])=>[key,flags.get(flag)!])),...(allDone?{all_done:true}:{}) } };
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
