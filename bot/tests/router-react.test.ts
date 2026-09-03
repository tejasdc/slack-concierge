import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let directory = "";

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "concierge-router-react-"));
  writeFileSync(join(directory, "slack.toml"), 'bot_token = "test-bot-token"\n');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

type SlackReactionResponse = Record<string, unknown>;

async function runReact(
  responses: SlackReactionResponse[],
  options: { args?: string[]; configPath?: string } = {},
) {
  const preload = join(directory, "preload.ts");
  const callsPath = join(directory, "calls.json");
  writeFileSync(callsPath, "[]");
  writeFileSync(preload, `const responses = ${JSON.stringify(responses)};
const calls = [];
globalThis.fetch = async (input, init = {}) => {
  const method = new URL(String(input)).pathname.split('/').at(-1);
  const payload = Object.fromEntries(new URLSearchParams(String(init.body)));
  calls.push({ method, payload });
  await Bun.write(${JSON.stringify(callsPath)}, JSON.stringify(calls));
  return Response.json(responses.shift() || { ok: false, error: 'unexpected_request' });
};`);
  const child = Bun.spawn([
    "bash",
    join(import.meta.dir, "../../systemd/router-actions.sh"),
    "react",
    ...(options.args || ["D123ABC", "123.456789", "thumbsup"]),
  ], {
    env: {
      ...process.env,
      BUN_OPTIONS: `--preload=${preload}`,
      CONCIERGE_ROUTER_BOT_DIR: join(import.meta.dir, ".."),
      CONCIERGE_SLACK_CONFIG: options.configPath || join(directory, "slack.toml"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    stdout,
    stderr,
    exitCode,
    calls: await Bun.file(callsPath).json() as Array<{ method: string; payload: Record<string, string> }>,
  };
}

test("returns an exact success receipt for the targeted message", async () => {
  const result = await runReact([{ ok: true }, { ok: true }]);

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    ok: true,
    channel: "D123ABC",
    message_ts: "123.456789",
    reaction: "thumbsup",
    outcome_reaction: "added",
    in_progress_reaction: "removed",
  });
  expect(result.calls).toEqual([
    { method: "reactions.add", payload: { channel: "D123ABC", timestamp: "123.456789", name: "thumbsup" } },
    { method: "reactions.remove", payload: { channel: "D123ABC", timestamp: "123.456789", name: "hourglass_flowing_sand" } },
  ]);
});

test("reports idempotent reaction outcomes as proven success", async () => {
  const result = await runReact([{ ok: false, error: "already_reacted" }, { ok: false, error: "no_reaction" }]);

  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    channel: "D123ABC",
    message_ts: "123.456789",
    outcome_reaction: "already_reacted",
    in_progress_reaction: "already_absent",
  });
});

test("returns a structured partial-failure error instead of silent output", async () => {
  const result = await runReact([{ ok: false, error: "message_not_found" }, { ok: false, error: "no_reaction" }]);

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toEqual({
    ok: false,
    channel: "D123ABC",
    message_ts: "123.456789",
    reaction: "thumbsup",
    outcome_reaction: "failed",
    in_progress_reaction: "already_absent",
    add_error: "message_not_found",
    error: "reaction_projection_failed",
  });
});

test("rejects a truthy non-boolean Slack ok field instead of reporting false success", async () => {
  const result = await runReact([{ ok: "false" }, { ok: true }]);

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toMatchObject({
    ok: false,
    error: "reaction_projection_unproven",
    channel: "D123ABC",
    message_ts: "123.456789",
    reaction: "thumbsup",
    detail: "Slack reactions.add returned a malformed response",
  });
});

test("returns an identity-bearing error when the Slack config cannot be read", async () => {
  const result = await runReact([], { configPath: join(directory, "missing.toml") });

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toMatchObject({
    ok: false,
    error: "reaction_projection_unproven",
    channel: "D123ABC",
    message_ts: "123.456789",
    reaction: "thumbsup",
  });
});

test("returns an identity-bearing error when the Slack token is missing", async () => {
  writeFileSync(join(directory, "slack.toml"), "signing_secret = \"test\"\n");
  const result = await runReact([]);

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toEqual({
    ok: false,
    error: "reaction_projection_unproven",
    channel: "D123ABC",
    message_ts: "123.456789",
    reaction: "thumbsup",
    detail: "Slack configuration is missing bot_token",
  });
});

test("returns structured usage output for incomplete router arguments", async () => {
  const result = await runReact([], { args: ["D123ABC", "123.456789"] });

  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toEqual({
    ok: false,
    error: "usage",
    detail: "usage: router-react <channel-id> <message-ts> <emoji>",
  });
});
