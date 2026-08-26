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
function uploadResponses(info: any = fileInfo()) {
  return {
    "files.getUploadURLExternal": [{ ok: true, file_id: "F123", upload_url: "https://files.slack.com/upload/123" }],
    bytes: [new Response("OK")],
    "files.completeUploadExternal": [{ ok: true, files: [{ id: "F123", title: "two words.txt" }] }],
    "files.info": [info],
    "chat.getPermalink": [{ ok: true, channel, permalink }],
  };
}
async function failure(action: string[], request: typeof fetch) {
  try { await runRouterAction(parseRouterAction(action), request); }
  catch (error) {
    expect(error).toBeInstanceOf(RouterActionError);
    return error as RouterActionError;
  }
  throw new Error("expected failure");
}

test.each(["post", "resume", "audit"])("%s owns its token, thread targeting, mrkdwn, and exact message receipt", async verb => {
  const fixture = slackFixture({
    "chat.postMessage": [{ ok: true, channel, ts: postedTs }],
    "chat.getPermalink": [{ ok: true, channel, permalink }],
  });
  const args = [verb, "#target", ...(verb === "post" ? [] : [rootTs]), "--", "**Title** [link](https://example.com)"];
  const result = await runRouterAction(parseRouterAction(args), fixture.request);
  expect(result).toEqual({ channel, ts: postedTs, permalink, thread_ts: verb === "post" ? null : rootTs, file_ids: [] });
  expect(fixture.calls.map(call => call.token)).toEqual(Array(2).fill(`Bearer test-${verb === "audit" ? "bot" : "user"}-token`));
  expect(fixture.calls[0]!.payload).toEqual({ channel, text: "*Title* <https://example.com|link>", unfurl_links: false, unfurl_media: false,
    ...(verb === "post" ? {} : { thread_ts: rootTs }) });
  expect(fixture.calls[1]!.payload).toEqual({ channel, message_ts: postedTs });
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

test("delayed share metadata fails closed and recovers by file ID without any second write", async () => {
  const fixture = slackFixture(uploadResponses({ ok: true, file: { id: "F123", shares: {} } }));
  const error = await failure(["upload", channel, rootTs, "--file", filePath], fixture.request);
  expect(error.message).toContain("not yet visible");
  expect(error.context).toEqual({ delivery: "confirmed", channel, thread_ts: rootTs, file_ids: ["F123"],
    recover: ["resolve-upload", channel, "--thread", rootTs, "--file-id", "F123"] });
  expect(fixture.calls.map(call => call.method)).not.toContain("chat.getPermalink");
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
  await failure(["resolve-upload", channel, "--thread", rootTs, "--file-id", "F123"], fixture.request);
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
  const fixture = slackFixture({ "chat.postMessage": [{ ok: true, channel, ts: postedTs }],
    "chat.getPermalink": [{ ok: false, error: "ratelimited" }] });
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
])("malformed arguments are rejected before posting (%#)", args => {
  expect(() => parseRouterAction(args)).toThrow(RouterActionError);
});

test("shell dispatch and CLI emit a single JSON receipt with no caller-managed token or link", async () => {
  const preload = join(directory, "preload.ts");
  writeFileSync(preload, `globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const token = new Headers(init.headers).get('Authorization');
    if (token !== 'Bearer test-bot-token') throw new Error('wrong token');
    if (url.pathname.endsWith('/chat.postMessage')) {
      const body = JSON.parse(init.body);
      if (body.thread_ts !== '${rootTs}' || body.text !== '*audit*') throw new Error('wrong body');
      return Response.json({ok:true,channel:'${channel}',ts:'${postedTs}'});
    }
    if (url.pathname.endsWith('/chat.getPermalink') && url.searchParams.get('message_ts') === '${postedTs}') {
      return Response.json({ok:true,channel:'${channel}',permalink:'${permalink}'});
    }
    throw new Error('unexpected request');
  };`);
  const child = Bun.spawn(["bash", join(import.meta.dir, "../../systemd/router-actions.sh"), "audit", "target", rootTs, "--", "**audit**"], {
    env: { ...process.env, BUN_OPTIONS: `--preload=${preload}`, CONCIERGE_ROUTER_BOT_DIR: join(import.meta.dir, "..") },
    stdout: "pipe", stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual({ channel, ts: postedTs, permalink, thread_ts: rootTs, file_ids: [] });
});

test("CLI failure leaves stdout empty and exposes only structured recovery on stderr", async () => {
  const preload = join(directory, "failure-preload.ts");
  writeFileSync(preload, `globalThis.fetch = async input => Response.json(String(input).includes('chat.postMessage')
    ? {ok:true,channel:'${channel}',ts:'${postedTs}'} : {ok:false,error:'ratelimited'});`);
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
