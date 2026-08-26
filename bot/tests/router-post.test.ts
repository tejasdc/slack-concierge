import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { parseRouterAction, RouterActionError, runRouterAction } from "../scripts/router-post";

const channel = "C123ABC";
const rootTs = "1756000000.000001";
const priorTs = "1756000001.000002";
const postedTs = "1756000002.000003";
const permalink = `https://example.slack.com/archives/${channel}/p1756000002000003?thread_ts=${rootTs}&cid=${channel}`;
const originalConfig = process.env.CONCIERGE_SLACK_CONFIG;
const originalState = process.env.CONCIERGE_STATE_DB;
let directory: string;
let filePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "concierge-router-post-"));
  filePath = join(directory, "two words.txt");
  writeFileSync(filePath, "hello file");
  process.env.CONCIERGE_SLACK_CONFIG = join(directory, "slack.toml");
  process.env.CONCIERGE_STATE_DB = join(directory, "state.db");
  writeFileSync(process.env.CONCIERGE_SLACK_CONFIG, 'user_token = "test-user-token"\nbot_token = "test-bot-token"\n');
  const db = new Database(process.env.CONCIERGE_STATE_DB);
  db.run("CREATE TABLE channels (slack_channel_id TEXT, slack_channel_name TEXT)");
  db.query("INSERT INTO channels VALUES (?, ?)").run(channel, "target");
  db.close();
});

afterEach(() => {
  if (originalConfig === undefined) delete process.env.CONCIERGE_SLACK_CONFIG;
  else process.env.CONCIERGE_SLACK_CONFIG = originalConfig;
  if (originalState === undefined) delete process.env.CONCIERGE_STATE_DB;
  else process.env.CONCIERGE_STATE_DB = originalState;
  rmSync(directory, { recursive: true, force: true });
});

type Call = { method: string; token: string | null; payload: any; httpMethod: string };
function slackFixture(responses: Record<string, any[]>) {
  const calls: Call[] = [];
  const request = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = url.hostname === "files.slack.com" ? "bytes" : url.pathname.split("/").at(-1)!;
    const payload = method === "bytes" ? await new Response(init.body).text()
      : init.method === "GET" ? Object.fromEntries(url.searchParams) : JSON.parse(String(init.body));
    calls.push({ method, token: new Headers(init.headers).get("Authorization"), payload, httpMethod: init.method! });
    const queue = responses[method];
    if (!queue?.length) throw new Error(`unexpected request: ${method}`);
    const response = queue.shift();
    if (response instanceof Error) throw response;
    return response instanceof Response ? response : Response.json(response);
  }) as typeof fetch;
  return { calls, request };
}

function fileInfo(id = "F123", ts = postedTs, threadTs: string | undefined = rootTs, visibility = "public") {
  return { ok: true, file: { id, shares: { [visibility]: { [channel]: [{ ts, ...(threadTs ? { thread_ts: threadTs } : {}) }] } } } };
}
function messageInfo(ts = rootTs, threadTs: string | undefined = rootTs) {
  return { ok: true, type: "message", channel, message: { type: "message", ts, ...(threadTs ? { thread_ts: threadTs } : {}) } };
}
function uploadResponses(info: any = fileInfo()) {
  return {
    "files.getUploadURLExternal": [{ ok: true, file_id: "F123", upload_url: "https://files.slack.com/upload/123" }],
    bytes: [new Response("OK")],
    "files.completeUploadExternal": [{ ok: true, files: [{ id: "F123", title: "two words.txt" }] }],
    "files.info": [info],
    "chat.getPermalink": [{ ok: true, channel, permalink }],
  };
}
function receiptClock(budgetMs = 30_000) {
  let elapsed = 0;
  const sleeps: number[] = [];
  return { sleeps, budgetMs, now: () => elapsed, sleep: async (ms: number) => { sleeps.push(ms); elapsed += ms; } };
}

test("posting owns expected share propagation until it can return the exact receipt", async () => {
  const responses = uploadResponses({ ok: true, file: { id: "F123", shares: {} } });
  responses["files.info"].push(fileInfo());
  const fixture = slackFixture(responses);
  const clock = receiptClock();
  const receipt = await runRouterAction(parseRouterAction(["upload", channel, rootTs, "--file", filePath]), fixture.request, clock);
  expect(receipt).toEqual({ channel, ts: postedTs, permalink, thread_ts: rootTs, file_ids: ["F123"] });
  expect(clock.sleeps).toEqual([1000]);
  expect(fixture.calls.map(call => call.method)).toEqual([
    "files.getUploadURLExternal", "bytes", "files.completeUploadExternal", "files.info", "files.info", "chat.getPermalink",
  ]);
});
async function failure(action: string[], request: typeof fetch, timing = receiptClock()) {
  try { await runRouterAction(parseRouterAction(action), request, timing); }
  catch (error) {
    expect(error).toBeInstanceOf(RouterActionError);
    return error as RouterActionError;
  }
  throw new Error("expected failure");
}

test.each(["post", "resume", "audit"])("%s owns its token, thread targeting, mrkdwn, and exact message receipt", async verb => {
  const fixture = slackFixture({
    "reactions.get": [messageInfo()],
    "chat.postMessage": [{ ok: true, channel, ts: postedTs }],
    "chat.getPermalink": [{ ok: true, channel, permalink }],
  });
  const args = [verb, "#target", ...(verb === "post" ? [] : [rootTs]), "--", "**Title** [link](https://example.com)"];
  const result = await runRouterAction(parseRouterAction(args), fixture.request);
  expect(result).toEqual({ channel, ts: postedTs, permalink, thread_ts: verb === "post" ? null : rootTs, file_ids: [] });
  expect(fixture.calls.map(call => call.token)).toEqual(Array(verb === "audit" ? 3 : 2).fill(`Bearer test-${verb === "audit" ? "bot" : "user"}-token`));
  expect(fixture.calls.find(call => call.method === "chat.postMessage")!.payload).toEqual({ channel, text: "*Title* <https://example.com|link>", unfurl_links: false, unfurl_media: false,
    ...(verb === "post" ? {} : { thread_ts: rootTs }) });
  expect(fixture.calls.at(-1)!.payload).toEqual({ channel, message_ts: postedTs });
});

test("thread upload identifies its own file share even while the newest thread reply is still the previous message", async () => {
  const staleThread = { ok: true, messages: [{ ts: rootTs }, { ts: priorTs, files: [{ id: "FOLD" }] }] };
  expect(staleThread.messages.at(-1)!.ts).not.toBe(postedTs);
  const info = fileInfo();
  info.file.shares.public.COTHER = [{ ts: priorTs, thread_ts: rootTs }];
  info.file.shares.public[channel].unshift({ ts: priorTs, thread_ts: "1755999999.000001" });
  const fixture = slackFixture({ ...uploadResponses(info), "conversations.replies": [staleThread] });
  const result = await runRouterAction(parseRouterAction(["upload", channel, rootTs, "--file", filePath, "--", "**File**"]), fixture.request);
  expect(result).toEqual({ channel, ts: postedTs, permalink, thread_ts: rootTs, file_ids: ["F123"] });
  expect(fixture.calls.map(call => call.method)).toEqual([
    "files.getUploadURLExternal", "bytes", "files.completeUploadExternal", "files.info", "chat.getPermalink",
  ]);
  expect(fixture.calls[1]).toMatchObject({ token: null, payload: "hello file", httpMethod: "POST" });
  expect(fixture.calls.filter(call => call.method !== "bytes").every(call => call.token === "Bearer test-user-token")).toBe(true);
  expect(fixture.calls[2]!.payload).toEqual({ channel_id: channel, thread_ts: rootTs,
    files: [{ id: "F123", title: "two words.txt" }], initial_comment: "*File*" });
  expect(fixture.calls[3]!.payload).toEqual({ file: "F123" });
  expect(fixture.calls[4]!.payload).toEqual({ channel, message_ts: postedTs });
});

test.each(["post", "resume"])("%s supports existing --file syntax, file-only content, and private shares", async verb => {
  const info = fileInfo("F123", postedTs, verb === "post" ? "" : rootTs, "private");
  const fixture = slackFixture(uploadResponses(info));
  const result = await runRouterAction(parseRouterAction([verb, "target", ...(verb === "post" ? [] : [rootTs]), `--file=${filePath}`]), fixture.request);
  expect(result.ts).toBe(postedTs);
  expect(fixture.calls[2]!.payload.initial_comment).toBeUndefined();
  expect(fixture.calls[2]!.payload.thread_ts).toBe(verb === "post" ? undefined : rootTs);
});

test("share propagation beyond the budget times out distinctly and preserves exceptional recovery", async () => {
  const responses = uploadResponses();
  responses["files.info"] = Array(6).fill({ ok: true, file: { id: "F123", shares: {} } });
  const fixture = slackFixture(responses);
  const clock = receiptClock();
  const error = await failure(["upload", channel, rootTs, "--file", filePath], fixture.request, clock);
  expect(error.code).toBe("receipt_timeout");
  expect(clock.now()).toBe(30_000);
  expect(clock.sleeps).toEqual([1000, 2000, 4000, 8000, 8000, 7000]);
  expect(error.message).toContain("not yet visible");
  expect(error.context).toEqual({ delivery: "confirmed", channel, thread_ts: rootTs, file_ids: ["F123"],
    recover: ["resolve-upload", channel, "--thread", rootTs, "--file-id", "F123"] });
  expect(fixture.calls.map(call => call.method)).not.toContain("chat.getPermalink");
  expect(fixture.calls.filter(call => call.method === "files.completeUploadExternal")).toHaveLength(1);
  const recovery = slackFixture({ "files.info": [fileInfo()], "chat.getPermalink": [{ ok: true, channel, permalink }] });
  const recovered = await runRouterAction(parseRouterAction(error.context!.recover!), recovery.request);
  expect(recovered.ts).toBe(postedTs);
  expect(recovery.calls.map(call => call.httpMethod)).toEqual(["GET", "GET"]);
});

test.each([
  { ok: true, file: { id: "FWRONG", shares: {} } },
  fileInfo("F123", postedTs, "1755999999.000001"),
  { ok: true, file: { id: "F123", shares: { public: { COTHER: [{ ts: postedTs, thread_ts: rootTs }] } } } },
  { ok: true, file: { id: "F123", shares: { public: { [channel]: [{ ts: postedTs, thread_ts: rootTs }, { ts: priorTs, thread_ts: rootTs }] } } } },
])("missing, wrong, or ambiguous file identity never yields a permalink (%#)", async info => {
  const fixture = slackFixture({ "files.info": [info] });
  const clock = receiptClock();
  const error = await failure(["resolve-upload", channel, "--thread", rootTs, "--file-id", "F123"], fixture.request, clock);
  expect(["identity_mismatch", "ambiguous_share"]).toContain(error.code);
  expect(clock.sleeps).toEqual([]);
  expect(fixture.calls.map(call => call.method)).toEqual(["files.info"]);
});

test("every file in a multi-file upload must prove the same message", async () => {
  const fixture = slackFixture({ "files.info": [fileInfo(), fileInfo("F456", priorTs)] });
  const error = await failure(["resolve-upload", channel, "--thread", rootTs, "--file-id", "F123", "--file-id", "F456"], fixture.request);
  expect(error.message).toContain("do not identify one shared message");
  expect(error.context!.file_ids).toEqual(["F123", "F456"]);
});

test("multi-file completion is one user message with one verified receipt", async () => {
  const responses = uploadResponses();
  responses["files.getUploadURLExternal"].push({ ok: true, file_id: "F456", upload_url: "https://files.slack.com/upload/456" });
  responses.bytes.push(new Response("OK"));
  responses["files.info"].push(fileInfo("F456"));
  const fixture = slackFixture(responses);
  const result = await runRouterAction(parseRouterAction(["resume", channel, rootTs, "--file", filePath, "--file", filePath]), fixture.request);
  expect(result.file_ids).toEqual(["F123", "F456"]);
  expect(fixture.calls.filter(call => call.method === "files.completeUploadExternal")).toHaveLength(1);
  expect(fixture.calls.find(call => call.method === "files.completeUploadExternal")!.payload.files).toHaveLength(2);
});

test("a permalink failure preserves the confirmed timestamp for read-only recovery", async () => {
  const fixture = slackFixture({ "reactions.get": [messageInfo()], "chat.postMessage": [{ ok: true, channel, ts: postedTs }],
    "chat.getPermalink": [{ ok: false, error: "missing_scope" }] });
  const error = await failure(["audit", channel, rootTs, "--", "audit"], fixture.request);
  expect(error.context).toMatchObject({ delivery: "confirmed", ts: postedTs, recover: ["permalink", channel, postedTs] });
  expect(fixture.calls.filter(call => call.method === "chat.postMessage")).toHaveLength(1);
});

test.each(["chat.postMessage", "files.completeUploadExternal"])("ambiguous %s failure never retries the write", async method => {
  const responses = method === "chat.postMessage" ? {} : uploadResponses();
  const fixture = slackFixture({ ...responses, [method]: [new Error("network failed with test-user-token")] });
  const error = await failure(method === "chat.postMessage" ? ["resume", channel, rootTs, "--", "text"]
    : ["upload", channel, rootTs, "--file", filePath], fixture.request);
  expect(error.context!.delivery).toBe("unknown");
  expect(error.message).not.toContain("test-user-token");
  expect(fixture.calls.filter(call => call.method === method)).toHaveLength(1);
});

test("all local file paths are validated before the first Slack side effect", async () => {
  const fixture = slackFixture({});
  await failure(["post", channel, "--file", filePath, "--file", join(directory, "missing.txt")], fixture.request);
  expect(fixture.calls).toEqual([]);
});

test.each(["post", "audit"])("%s refuses a missing required credential instead of using the other token", async verb => {
  writeFileSync(process.env.CONCIERGE_SLACK_CONFIG!, verb === "audit" ? 'user_token = "test-user-token"' : 'bot_token = "test-bot-token"');
  const fixture = slackFixture({});
  const error = await failure([verb, channel, ...(verb === "audit" ? [rootTs] : []), "--", "text"], fixture.request);
  expect(error.message).toContain(`${verb === "audit" ? "bot" : "user"}_token not found`);
  expect(fixture.calls).toEqual([]);
});

test.each([
  { ok: false, error: "invalid_auth" },
  { ok: true, channel },
  { ok: true, channel: "COTHER", ts: postedTs },
  new Response("not-json", { status: 502 }),
  Response.json({ ok: true, channel, ts: postedTs }, { status: 503 }),
])("bad chat responses cannot produce partial success or a guessed link (%#)", async response => {
  const fixture = slackFixture({ "chat.postMessage": [response] });
  await failure(["post", channel, "text"], fixture.request);
  expect(fixture.calls.map(call => call.method)).toEqual(["chat.postMessage"]);
});

test("failed byte transfer never completes a file share", async () => {
  const fixture = slackFixture({ ...uploadResponses(), bytes: [new Response("failed", { status: 500 })] });
  const error = await failure(["upload", channel, rootTs, "--file", filePath], fixture.request);
  expect(error.context).toMatchObject({ delivery: "not_sent", file_ids: ["F123"] });
  expect(fixture.calls.map(call => call.method)).toEqual(["files.getUploadURLExternal", "bytes"]);
});

test("root upload recovery cannot select a share in a thread", async () => {
  const fixture = slackFixture({ "files.info": [fileInfo()] });
  await failure(["resolve-upload", channel, "--file-id", "F123"], fixture.request);
  expect(fixture.calls.map(call => call.method)).toEqual(["files.info"]);
});

test.each([{ ok: true, channel }, { ok: true, channel: "COTHER", permalink }])("invalid permalink responses fail with the exact timestamp preserved (%#)", async response => {
  const fixture = slackFixture({ "chat.getPermalink": [response] });
  const error = await failure(["permalink", channel, postedTs], fixture.request);
  expect(error.context!.ts).toBe(postedTs);
});

test.each([
  ["resume", channel, "text"], ["audit", channel, "--", "text"], ["upload", channel, rootTs, "text"],
  ["post", channel, "--file"], ["post", channel, "--thread", rootTs, "--", "text"],
  ["audit", channel, rootTs, "--file", "somewhere"], ["resume", channel, rootTs, "--token", "wrong", "text"],
  ["resolve-upload", channel], ["resolve-upload", channel, "--file-id", "not-an-id"],
  ["permalink", channel, postedTs, "extra"],
].map(args => ({ args })))("malformed arguments are rejected before posting (%#)", ({ args }) => {
  expect(() => parseRouterAction(args)).toThrow(RouterActionError);
});

const receiptVerbs = ["post", "resume", "upload", "audit", "thread-of", "resolve-upload", "permalink"];

async function runShell(args: string[], responses: Record<string, any[]> = {}) {
  const preload = join(directory, "preload.ts");
  const callsPath = join(directory, "calls.json");
  writeFileSync(callsPath, "[]");
  writeFileSync(preload, `const responses = ${JSON.stringify(responses)};
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = url.hostname === 'files.slack.com' ? 'bytes' : url.pathname.split('/').at(-1);
    const token = new Headers(init.headers).get('Authorization');
    const payload = method === 'bytes' ? await new Response(init.body).text()
      : init.method === 'GET' ? Object.fromEntries(url.searchParams) : JSON.parse(String(init.body));
    calls.push({method, token, payload, httpMethod: init.method});
    await Bun.write(${JSON.stringify(callsPath)}, JSON.stringify(calls));
    const response = responses[method]?.shift();
    if (!response) return Response.json({ok:false,error:'unexpected_request'});
    return Response.json(response);
  };`);
  const child = Bun.spawn(["bash", join(import.meta.dir, "../../systemd/router-actions.sh"), ...args], {
    env: { ...process.env, BUN_OPTIONS: `--preload=${preload}`, CONCIERGE_ROUTER_BOT_DIR: join(import.meta.dir, "..") },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode, calls: await Bun.file(callsPath).json() as Call[] };
}

test("every advertised receipt verb has a shell execution case", async () => {
  const result = await runShell(["--help"]);
  expect(result.exitCode).toBe(0);
  expect([...result.stdout.matchAll(/^  ([a-z-]+) </gm)].map(match => match[1])).toEqual(receiptVerbs);
});

test.each(receiptVerbs)("shell dispatch executes %s and returns its exact JSON receipt", async verb => {
  const args: Record<string, string[]> = {
    post: ["--", "**audit**"], resume: [rootTs, "--", "**audit**"],
    upload: [rootTs, "--file", filePath, "--", "**audit**"],
    audit: [priorTs, "--", "**audit**"], "thread-of": [priorTs],
    "resolve-upload": ["--thread", rootTs, "--file-id", "F123"], permalink: [postedTs],
  };
  const ts = verb === "thread-of" ? priorTs : postedTs;
  const expectedLink = `https://example.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
  const result = await runShell([verb, "target", ...args[verb]!], {
    ...uploadResponses(), bytes: [{ ok: true }],
    "reactions.get": [messageInfo(priorTs)],
    "chat.postMessage": [{ ok: true, channel, ts: postedTs }],
    "chat.getPermalink": [{ ok: true, channel, permalink: expectedLink }],
  });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({ channel, ts, permalink: expectedLink,
    thread_ts: ["post", "permalink"].includes(verb) ? null : rootTs,
    file_ids: ["upload", "resolve-upload"].includes(verb) ? ["F123"] : [] });
  const methods: Record<string, string[]> = {
    post: ["chat.postMessage"], resume: ["chat.postMessage"],
    upload: ["files.getUploadURLExternal", "bytes", "files.completeUploadExternal", "files.info"],
    audit: ["reactions.get", "chat.postMessage"], "thread-of": ["reactions.get"],
    "resolve-upload": ["files.info"], permalink: [],
  };
  expect(result.calls.map(call => call.method)).toEqual([...methods[verb]!, "chat.getPermalink"]);
  for (const call of result.calls) {
    expect(call.token).toBe(call.method === "bytes" ? null : `Bearer test-${verb === "audit" ? "bot" : "user"}-token`);
    if (call.method === "reactions.get") expect(call.payload).toEqual({ channel, timestamp: priorTs });
    if (call.method === "chat.postMessage") expect(call.payload).toMatchObject({ channel, text: "*audit*",
      ...(verb === "post" ? {} : { thread_ts: rootTs }) });
  }
  expect(result.calls.at(-1)!.payload).toEqual({ channel, message_ts: ts });
});

test.each([true, false])("thread-of shell preserves exact root lookup or structured not-found failure (%#)", async found => {
  const result = await runShell(["thread-of", channel, rootTs], {
    "reactions.get": [found ? messageInfo(rootTs, "") : { ok: false, error: "message_not_found" }],
    "chat.getPermalink": [{ ok: true, channel, permalink }],
  });
  expect(result.exitCode).toBe(found ? 0 : 1);
  if (found) {
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ channel, ts: rootTs, thread_ts: rootTs, permalink, file_ids: [] });
  } else {
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: "reactions.get: message_not_found",
      delivery: "not_sent", message_ts: rootTs, thread_ts: null });
    expect(result.calls.map(call => call.method)).toEqual(["reactions.get"]);
  }
});

test("CLI failure leaves stdout empty and exposes only structured recovery on stderr", async () => {
  const preload = join(directory, "failure-preload.ts");
  writeFileSync(preload, `globalThis.fetch = async input => Response.json(String(input).includes('chat.postMessage')
    ? {ok:true,channel:'${channel}',ts:'${postedTs}'} : {ok:false,error:'missing_scope'});`);
  const child = Bun.spawn(["bash", join(import.meta.dir, "../../systemd/router-actions.sh"), "resume", channel, rootTs, "--", "text"], {
    env: { ...process.env, BUN_OPTIONS: `--preload=${preload}`, CONCIERGE_ROUTER_BOT_DIR: join(import.meta.dir, "..") },
    stdout: "pipe", stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited).toBe(1);
  expect(stdout).toBe("");
  expect(JSON.parse(stderr)).toMatchObject({ ok: false, delivery: "confirmed", ts: postedTs, recover: ["permalink", channel, postedTs] });
  expect(stderr).not.toContain("test-user-token");
});

test.each(["post", "resume", "upload", "resolve-upload"])("%s hides transient share propagation from its caller", async verb => {
  const thread = verb === "post" ? "" : rootTs;
  const responses = uploadResponses();
  responses["files.info"] = [{ ok: true, file: { id: "F123" } }, fileInfo("F123", postedTs, thread)];
  const fixture = slackFixture(responses);
  const args = verb === "resolve-upload" ? [verb, channel, "--thread", rootTs, "--file-id", "F123"]
    : [verb, channel, ...(thread ? [thread] : []), "--file", filePath];
  const receipt = await runRouterAction(parseRouterAction(args), fixture.request, receiptClock());
  expect(receipt.ts).toBe(postedTs);
  expect(receipt.permalink).toBe(permalink);
  expect(fixture.calls.filter(call => call.method === "files.completeUploadExternal")).toHaveLength(verb === "resolve-upload" ? 0 : 1);
});

test("transient receipt reads honor Retry-After and back off without repeating the confirmed post", async () => {
  const fixture = slackFixture({
    "chat.postMessage": [{ ok: true, channel, ts: postedTs }],
    "chat.getPermalink": [new Response("rate limited", { status: 429, headers: { "Retry-After": "3" } }),
      new Response("upstream failed", { status: 503 }), new Error("socket reset"), { ok: true, channel, permalink }],
  });
  const clock = receiptClock();
  const receipt = await runRouterAction(parseRouterAction(["post", channel, "text"]), fixture.request, clock);
  expect(receipt.ts).toBe(postedTs);
  expect(clock.sleeps).toEqual([3000, 2000, 4000]);
  expect(fixture.calls.filter(call => call.method === "chat.postMessage")).toHaveLength(1);
});

test("a disconnected read body retries but malformed successful JSON fails immediately", async () => {
  const interrupted = Response.json({ ok: true });
  interrupted.json = async () => { throw new TypeError("connection reset during body read"); };
  const fixture = slackFixture({ "chat.getPermalink": [interrupted, { ok: true, channel, permalink }] });
  const clock = receiptClock();
  expect((await runRouterAction(parseRouterAction(["permalink", channel, postedTs]), fixture.request, clock)).permalink).toBe(permalink);
  expect(clock.sleeps).toEqual([1000]);
  const malformed = slackFixture({ "chat.getPermalink": [new Response("not JSON")] });
  const noWait = receiptClock();
  expect((await failure(["permalink", channel, postedTs], malformed.request, noWait)).code).toBe("action_failed");
  expect(noWait.sleeps).toEqual([]);
  expect(malformed.calls).toHaveLength(1);
});

test.each(["ratelimited", "internal_error", "service_unavailable", "request_timeout"])("Slack read error %s is retried within the same receipt budget", async error => {
  const fixture = slackFixture({ "chat.getPermalink": [{ ok: false, error }, { ok: true, channel, permalink }] });
  const clock = receiptClock();
  expect((await runRouterAction(parseRouterAction(["permalink", channel, postedTs]), fixture.request, clock)).permalink).toBe(permalink);
  expect(clock.sleeps).toEqual([1000]);
});

test("a Retry-After outside the read budget exits explicitly without retrying too early", async () => {
  const fixture = slackFixture({ "chat.getPermalink": [new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } })] });
  const clock = receiptClock();
  const error = await failure(["permalink", channel, postedTs], fixture.request, clock);
  expect(error.code).toBe("receipt_timeout");
  expect(error.context!.retry_after_ms).toBe(60_000);
  expect(clock.sleeps).toEqual([]);
  expect(fixture.calls).toHaveLength(1);
});

test.each(["invalid_auth", "missing_scope", "file_not_found"])("permanent file-read error %s is not treated as propagation", async error => {
  const fixture = slackFixture({ "files.info": [{ ok: false, error }] });
  const clock = receiptClock();
  const failed = await failure(["resolve-upload", channel, "--file-id", "F123"], fixture.request, clock);
  expect(failed.code).toBe("action_failed");
  expect(clock.sleeps).toEqual([]);
  expect(fixture.calls).toHaveLength(1);
});

test("all files and the permalink share one deadline and resolved files are not polled again", async () => {
  const fixture = slackFixture({ "files.info": [
    { ok: true, file: { id: "F123" } }, fileInfo(),
    { ok: true, file: { id: "F456" } }, fileInfo("F456"),
  ], "chat.getPermalink": Array(4).fill({ ok: false, error: "internal_error" }) });
  const clock = receiptClock();
  const error = await failure(["resolve-upload", channel, "--thread", rootTs, "--file-id", "F123", "--file-id", "F456"], fixture.request, clock);
  expect(error.code).toBe("receipt_timeout");
  expect(clock.now()).toBe(30_000);
  expect(clock.sleeps).toEqual([1000, 2000, 4000, 8000, 8000, 7000]);
  expect(fixture.calls.filter(call => call.method === "files.info").map(call => call.payload.file)).toEqual(["F123", "F123", "F456", "F456"]);
  expect(error.context).toMatchObject({ delivery: "confirmed", ts: postedTs, file_ids: ["F123", "F456"] });
});

test.each(["chat.postMessage", "files.completeUploadExternal"])("even transient %s errors never enter the read retry loop", async method => {
  const fixture = slackFixture({ ...uploadResponses(), [method]: [new Response("upstream failed", { status: 503 })] });
  const clock = receiptClock();
  const error = await failure(method === "chat.postMessage" ? ["post", channel, "text"] : ["upload", channel, rootTs, "--file", filePath], fixture.request, clock);
  expect(error.context!.delivery).toBe("unknown");
  expect(clock.sleeps).toEqual([]);
  expect(fixture.calls.filter(call => call.method === method)).toHaveLength(1);
});

test.each(["headers", "body"])("receipt deadline aborts a stalled response %s", async stall => {
  let aborted = false;
  const request = (async (_input, init) => {
    const waitForAbort = () => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
    });
    if (stall === "headers") return await waitForAbort();
    const response = Response.json({ ok: true });
    response.json = waitForAbort;
    return response;
  }) as typeof fetch;
  const started = performance.now();
  const error = await failure(["permalink", channel, postedTs], request,
    { ...receiptClock(30), now: () => performance.now(), sleep: ms => Bun.sleep(ms) });
  expect(error.code).toBe("receipt_timeout");
  expect(aborted).toBe(true);
  expect(performance.now() - started).toBeLessThan(1000);
});

test.each([messageInfo(priorTs), messageInfo(rootTs), messageInfo(rootTs, "")])("thread-of confirms root and reply identity without a history query (%#)", async info => {
  const fixture = slackFixture({ "reactions.get": [info], "chat.getPermalink": [{ ok: true, channel, permalink }] });
  const receipt = await runRouterAction(parseRouterAction(["thread-of", channel, info.message.ts]), fixture.request, receiptClock());
  expect(receipt.thread_ts).toBe(rootTs);
  expect(receipt.ts).toBe(info.message.ts);
  expect(fixture.calls.map(call => call.method)).toEqual(["reactions.get", "chat.getPermalink"]);
  expect(fixture.calls[0]).toMatchObject({ token: "Bearer test-user-token", payload: { channel, timestamp: info.message.ts } });
});

test.each([
  { ...messageInfo(priorTs), channel: "COTHER" }, messageInfo(rootTs),
  { ...messageInfo(priorTs), type: "file" }, { ok: true, type: "message", channel },
  { ...messageInfo(priorTs), message: { type: "message", ts: priorTs, thread_ts: null } },
  { ...messageInfo(priorTs), message: { type: "message", ts: priorTs, thread_ts: 123 } },
  { ok: false, error: "message_not_found" }, { ok: false, error: "channel_not_found" },
])("wrong or unknown message identity never becomes a plausible thread or an audit write (%#)", async response => {
  for (const verb of ["thread-of", "audit"]) {
    const fixture = slackFixture({ "reactions.get": [response] });
    const clock = receiptClock();
    const error = await failure([verb, channel, priorTs, ...(verb === "audit" ? ["--", "audit"] : [])], fixture.request, clock);
    expect(error.context!.delivery).toBe("not_sent");
    expect(error.context).toMatchObject({ message_ts: priorTs, thread_ts: null });
    expect(clock.sleeps).toEqual([]);
    expect(fixture.calls.map(call => call.method)).toEqual(["reactions.get"]);
  }
});

test("audit uses the triggering reply's confirmed root, not a nearby top-level message", async () => {
  const fixture = slackFixture({
    "conversations.history": [{ ok: true, messages: [{ ts: "1700000000.000001" }] }],
    "reactions.get": [messageInfo(priorTs)], "chat.postMessage": [{ ok: true, channel, ts: postedTs }],
    "chat.getPermalink": [{ ok: true, channel, permalink }],
  });
  const result = await runRouterAction(parseRouterAction(["audit", channel, priorTs, "--", "audit"]), fixture.request, receiptClock());
  expect(result.thread_ts).toBe(rootTs);
  expect(fixture.calls.map(call => call.method)).toEqual(["reactions.get", "chat.postMessage", "chat.getPermalink"]);
  expect(fixture.calls[1]!.payload.thread_ts).toBe(rootTs);
  expect(fixture.calls.every(call => call.token === "Bearer test-bot-token")).toBe(true);
});

test("audit preflight retry time cannot consume the post-write receipt budget", async () => {
  const fixture = slackFixture({
    "reactions.get": [new Response("rate limited", { status: 429, headers: { "Retry-After": "20" } }), messageInfo(priorTs)],
    "chat.postMessage": [{ ok: true, channel, ts: postedTs }],
    "chat.getPermalink": [new Response("rate limited", { status: 429, headers: { "Retry-After": "20" } }), { ok: true, channel, permalink }],
  });
  const clock = receiptClock();
  expect((await runRouterAction(parseRouterAction(["audit", channel, priorTs, "--", "audit"]), fixture.request, clock)).permalink).toBe(permalink);
  expect(clock.now()).toBe(40_000);
  expect(fixture.calls.filter(call => call.method === "chat.postMessage")).toHaveLength(1);
});

test.each([
  { public: { [channel]: [{ ts: postedTs, thread_ts: rootTs }, { thread_ts: rootTs }] } },
  { public: { [channel]: [{ ts: postedTs, thread_ts: rootTs }, { ts: priorTs, thread_ts: null }] } },
  { public: { [channel]: [{ ts: Number(postedTs), thread_ts: rootTs }] } },
  { public: { [channel]: [null] } },
  { public: { [channel]: {} } },
  { public: [] }, { private: [] }, { public: null }, { public: "invalid" }, [], null,
].map(shares => ({ shares })))("malformed share data never masquerades as propagation or a unique receipt (%#)", async ({ shares }) => {
  const fixture = slackFixture({ "files.info": [{ ok: true, file: { id: "F123", shares } }],
    "chat.getPermalink": [{ ok: true, channel, permalink }] });
  const clock = receiptClock();
  const error = await failure(["resolve-upload", channel, "--thread", rootTs, "--file-id", "F123"], fixture.request, clock);
  expect(error.code).toBe("action_failed");
  expect(error.message).toContain("invalid share metadata");
  expect(clock.sleeps).toEqual([]);
  expect(fixture.calls.map(call => call.method)).toEqual(["files.info"]);
});
