import { App, LogLevel } from "@slack/bolt";
import toml from "@iarna/toml";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  addDir,
  appendInbox,
  appendTodo,
  ensureChannelProject,
  newProject,
  promoteChannel,
  removeDir,
  slugifySlackChannelName,
} from "./channel";
import { ARTIFACT_SCAN_GRACE_MS, findNewArtifacts } from "./artifacts";
import { errorFields, log } from "./log";
import { providers, providerFromText } from "./providers";
import {
  attachBotMessage,
  ChannelMode,
  createOrGetSession,
  finishTurn,
  getAllChannels,
  getChannel,
  getSessionForThread,
  parseAdditionalPaths,
  ProviderId,
  acquireSessionTurn,
  resolveForkParentSession,
  setSessionStatus,
  updateChannelMode,
  updateChannelProvider,
  upsertSession,
} from "./state";
import { slackCall } from "./rate-limit";
import { postLongReply, uploadArtifacts } from "./slack-post";
import { formatDuration } from "./text";
import { agentsFingerprint, syncAgentsCanvas } from "./canvas";
import {
  appendListItem,
  buildListPromptContext,
  completeListItem,
  parseAgentListOps,
  refreshListMirror,
} from "./lists";
import { isPaidPlanListError, slackErrorCode } from "./slack-errors";

const cfg: any = toml.parse(readFileSync(`${homedir()}/.config/concierge/slack.toml`, "utf-8"));
const claudeCodeBotUserId = cfg.claude_code_bot_user_id || process.env.CLAUDE_CODE_BOT_USER_ID || null;

const app = new App({
  token: cfg.bot_token,
  appToken: cfg.app_token,
  signingSecret: cfg.signing_secret,
  socketMode: true,
  logLevel: LogLevel.INFO,
  ignoreSelf: false,
});

let myBotUserId: string | null = null;
let myBotId: string | null = null;
let startedAt = Date.now();
let botStatusChannelId: string | null | undefined;

const skillRoutes = [
  {
    name: "substack-editor",
    userId: cfg.substack_editor_bot_user_id || process.env.SUBSTACK_EDITOR_BOT_USER_ID,
    match: /@substack-editor/i,
    skillPath: "/root/workspace/skills/substack-editor/SKILL.md",
  },
];

function commandChannelName(command: any) {
  return String(command.channel_name || command.channel_id || "").trim().replace(/^#/, "");
}

function selectSkill(text: string) {
  return skillRoutes.find((route) => (route.userId && text.includes(`<@${route.userId}>`)) || route.match.test(text));
}

function skillPrompt(skill: ReturnType<typeof selectSkill>) {
  if (!skill) return undefined;
  if (existsSync(skill.skillPath)) return readFileSync(skill.skillPath, "utf-8");
  return `You are acting as ${skill.name}. The skill file is expected at ${skill.skillPath}, but it is not present yet.`;
}

function stripBotMentions(text: string) {
  return text.replace(/<@[A-Z0-9]+>\s*/g, "").replace(/@substack-editor/gi, "").replace(/^@claude-code\b/i, "").trim();
}

function runHostCommand(input: { command: string; cwd: string; timeoutMs: number }) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
    const proc = spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, input.timeoutMs);
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

async function ensureChannelFromCommand(command: any) {
  const existing = getChannel(command.channel_id);
  if (existing) return existing;
  return ensureChannelProject(command.channel_id, commandChannelName(command));
}

app.command("/cping", async ({ ack, respond }) => {
  await ack();
  await respond({
    text: `pong - concierge alive at ${new Date().toISOString()} - uptime ${formatDuration(Date.now() - startedAt)}`,
    response_type: "ephemeral",
  });
});

async function createProjectFromSlash(input: { respond: any; command: any; client: any }) {
  const { respond, command, client } = input;
  const name = command.text.trim();
  if (!name) {
    await respond({ text: "usage: /new <name>", response_type: "ephemeral" });
    return;
  }
  const slug = slugifySlackChannelName(name);
  if (slug !== name) {
    log("info", "new_channel_name_slugified", {
      requested_name: name,
      slack_channel_name: slug,
      channel: command.channel_id,
      user: command.user_id,
    });
  }

  try {
    const created: any = await slackCall(client, "conversations.create", { name: slug, is_private: false }, {
      channel: command.channel_id,
      user: command.user_id,
    });
    const chan = created.channel!;
    try {
      await slackCall(client, "conversations.join", { channel: chan.id }, { channel: chan.id, user: command.user_id });
    } catch {}
    try {
      await slackCall(client, "conversations.invite", { channel: chan.id, users: command.user_id }, {
        channel: chan.id,
        user: command.user_id,
      });
    } catch {}

    const paths = newProject(chan.id, chan.name);
    const channelRow = getChannel(chan.id);
    if (channelRow) await ensureChannelSurfaces(client, channelRow, command.user_id, "new_channel");
    await respond({ text: `created <#${chan.id}> - vault: ${paths.vault} - code: ${paths.code}`, response_type: "ephemeral" });
    await slackCall(client, "chat.postMessage", {
      channel: chan.id,
      text: `Concierge ready. Vault: ${paths.vault}\nCode: ${paths.code}`,
    });
  } catch (err) {
    log("error", "new_command_failed", errorFields(err));
    await respond({ text: `could not create project: ${(err as Error).message}`, response_type: "ephemeral" });
  }
}

app.command("/new", async ({ ack, respond, command, client }) => {
  await ack();
  await createProjectFromSlash({ respond, command, client });
});

app.command("/create-channel", async ({ ack, respond, command, client }) => {
  await ack();
  await createProjectFromSlash({ respond, command, client });
});

app.command("/promote", async ({ ack, respond, command, client }) => {
  await ack();
  try {
    const channel = await ensureChannelFromCommand(command);
    const paths = promoteChannel(channel);
    const fresh = getChannel(channel.slack_channel_id) || channel;
    await ensureChannelSurfaces(client, fresh, command.user_id, "promote");
    await respond({ text: `promoted #${channel.slack_channel_name} - code: ${paths.code}`, response_type: "ephemeral" });
  } catch (err) {
    await respond({ text: `promote failed: ${(err as Error).message}`, response_type: "ephemeral" });
  }
});

app.command("/add-dir", async ({ ack, respond, command }) => {
  await ack();
  const path = command.text.trim();
  if (!path) return respond({ text: "usage: /add-dir <path>", response_type: "ephemeral" });
  const channel = await ensureChannelFromCommand(command);
  const paths = addDir(channel, path);
  await respond({ text: `additional dirs: ${paths.join(", ") || "(none)"}`, response_type: "ephemeral" });
});

app.command("/remove-dir", async ({ ack, respond, command }) => {
  await ack();
  const path = command.text.trim();
  if (!path) return respond({ text: "usage: /remove-dir <path>", response_type: "ephemeral" });
  const channel = await ensureChannelFromCommand(command);
  const paths = removeDir(channel, path);
  await respond({ text: `additional dirs: ${paths.join(", ") || "(none)"}`, response_type: "ephemeral" });
});

app.command("/mode", async ({ ack, respond, command }) => {
  await ack();
  const mode = command.text.trim() as ChannelMode;
  if (!["agent-auto", "agent-tag", "silent"].includes(mode)) {
    return respond({ text: "usage: /mode <agent-auto|agent-tag|silent>", response_type: "ephemeral" });
  }
  const channel = await ensureChannelFromCommand(command);
  updateChannelMode(channel.slack_channel_id, mode);
  await respond({ text: `mode set to ${mode}`, response_type: "ephemeral" });
});

app.command("/switch-provider", async ({ ack, respond, command }) => {
  await ack();
  const provider = command.text.trim() as ProviderId;
  if (!["codex", "claude-code"].includes(provider)) {
    return respond({ text: "usage: /switch-provider <codex|claude-code>", response_type: "ephemeral" });
  }
  const channel = await ensureChannelFromCommand(command);
  updateChannelProvider(channel.slack_channel_id, provider);
  await respond({ text: `default provider set to ${provider}. Existing threads keep their original provider.`, response_type: "ephemeral" });
});

app.command("/todo", async ({ ack, respond, command, client }) => {
  await ack();
  const text = command.text.trim();
  if (!text) return respond({ text: "usage: /todo <text>", response_type: "ephemeral" });
  const channel = await ensureChannelFromCommand(command);
  const file = appendTodo(channel, text, `/todo by ${command.user_name || command.user_id}`);
  let listText = "";
  try {
    const itemId = await appendListItem({ client, channel, text, source: "todo", user: command.user_id });
    await refreshListMirror({
      client,
      channel,
      user: command.user_id,
      onPaidPlanError: (err) => postListPaidPlanError(client, channel, err),
    });
    listText = itemId ? `; Slack List row ${itemId}` : "; Slack List write skipped";
  } catch (err) {
    await maybeReportListFailure(client, channel, err);
    listText = `; Slack List write failed: ${slackErrorCode(err)}`;
  }
  await respond({ text: `todo appended to ${file}${listText}`, response_type: "ephemeral" });
});

app.command("/note", async ({ ack, respond, command, client }) => {
  await ack();
  const text = command.text.trim();
  if (!text) return respond({ text: "usage: /note <text>", response_type: "ephemeral" });
  const channel = await ensureChannelFromCommand(command);
  const file = appendInbox(channel, text, `/note by ${command.user_name || command.user_id}`);
  let listText = "";
  try {
    const itemId = await appendListItem({ client, channel, text, source: "note", user: command.user_id });
    await refreshListMirror({
      client,
      channel,
      user: command.user_id,
      onPaidPlanError: (err) => postListPaidPlanError(client, channel, err),
    });
    listText = itemId ? `; Slack List row ${itemId}` : "; Slack List write skipped";
  } catch (err) {
    await maybeReportListFailure(client, channel, err);
    listText = `; Slack List write failed: ${slackErrorCode(err)}`;
  }
  await respond({ text: `note appended to ${file}${listText}`, response_type: "ephemeral" });
});

app.command("/auth-refresh", async ({ ack, respond, command }) => {
  await ack();
  const provider = command.text.trim() || "codex";
  if (!["codex", "claude-code"].includes(provider)) {
    return respond({ text: "usage: /auth-refresh <codex|claude-code>", response_type: "ephemeral" });
  }
  const refreshCommand =
    provider === "codex"
      ? cfg.codex_auth_refresh_command || "codex login"
      : cfg.claude_code_auth_refresh_command || "claude login";
  const cwd = homedir();
  log("info", "auth_refresh_started", { provider, command: refreshCommand, user: command.user_id });
  await respond({ text: `starting ${provider} auth refresh on this host...`, response_type: "ephemeral" });
  const result = await runHostCommand({ command: refreshCommand, cwd, timeoutMs: 30_000 });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  log(result.code === 0 ? "info" : "warn", "auth_refresh_finished", {
    provider,
    exit_code: result.code,
    timed_out: result.timedOut,
    output_chars: output.length,
  });
  const url = output.match(/https?:\/\/\S+/)?.[0];
  await respond({
    text: result.code === 0 || url
      ? [`${provider} auth refresh output:`, url || output.slice(0, 1800) || "(no output)"].join("\n")
      : `${provider} auth refresh did not complete on this host. Output:\n${output.slice(0, 1600) || "(no output)"}`,
    response_type: "ephemeral",
  });
});

app.command("/creview", async ({ ack, respond, command }) => {
  await ack();
  const channel = await ensureChannelFromCommand(command);
  const cwd = channel.code_path || channel.vault_path;
  log("info", "review_command_started", { channel: command.channel_id, user: command.user_id, cwd });
  await respond({ text: `starting review in ${cwd}...`, response_type: "ephemeral" });
  const result = await runHostCommand({ command: "journalmaxx-review", cwd, timeoutMs: 120_000 });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (result.code === 127 || /not found/i.test(output)) {
    log("warn", "review_pipeline_missing", { channel: command.channel_id, cwd, exit_code: result.code });
    await respond({
      text: "review pipeline not yet installed on this host, see systemd/README.md",
      response_type: "ephemeral",
    });
    return;
  }
  log(result.code === 0 ? "info" : "error", "review_command_finished", {
    channel: command.channel_id,
    cwd,
    exit_code: result.code,
    timed_out: result.timedOut,
    output_chars: output.length,
  });
  await respond({
    text: result.code === 0
      ? `review complete:\n${output.slice(0, 1800) || "(no output)"}`
      : `review failed:\n${output.slice(0, 1800) || "(no output)"}`,
    response_type: "ephemeral",
  });
});

app.command("/fork", async ({ ack, respond, command, client }) => {
  await ack();
  try {
    const channel = await ensureChannelFromCommand(command);
    const requestedTs = command.text.trim();
    const parent = resolveForkParentSession(command.channel_id, requestedTs);
    log("info", "fork_parent_resolved", {
      channel: command.channel_id,
      requested_ts: requestedTs || null,
      parent_session_id: parent?.id || null,
      parent_thread_ts: parent?.slack_thread_ts || null,
    });
    if (!parent?.agent_session_uuid) {
      await respond({ text: "No persisted parent session found to fork in this channel.", response_type: "ephemeral" });
      return;
    }
    const provider = providers[parent.provider_id as ProviderId];
    const result = await provider.fork({
      cwd: channel.code_path || channel.vault_path,
      additionalDirs: parseAdditionalPaths(channel),
      sessionUUID: parent.agent_session_uuid,
    });
    const msg: any = await slackCall(client, "chat.postMessage", {
      channel: command.channel_id,
      text: `Forked ${parent.provider_id} session from ${parent.slack_thread_ts}.`,
    }, { channel: command.channel_id, user: command.user_id });
    upsertSession(command.channel_id, msg.ts, parent.provider_id as ProviderId, result.sessionUUID, {
      parentSessionId: parent.id,
      status: "idle",
    });
    await respond({ text: `fork created in <#${command.channel_id}> at ${msg.ts}`, response_type: "ephemeral" });
  } catch (err) {
    await respond({ text: `fork failed: ${(err as Error).message}`, response_type: "ephemeral" });
  }
});

async function handleInlineCapture(input: { text: string; channel: any; user: string; client: any; threadTs: string }) {
  const todo = input.text.match(/^[!/](?:todo)\s+([\s\S]+)/i);
  const note = input.text.match(/^[!/](?:note)\s+([\s\S]+)/i);
  if (!todo && !note) return false;
  if (todo) appendTodo(input.channel, todo[1], `inline by ${input.user}`);
  if (note) appendInbox(input.channel, note[1], `inline by ${input.user}`);
  try {
    await appendListItem({
      client: input.client,
      channel: input.channel,
      text: todo ? todo[1] : note![1],
      source: todo ? "todo" : "note",
      user: input.user,
    });
    await refreshListMirror({
      client: input.client,
      channel: input.channel,
      user: input.user,
      onPaidPlanError: (err) => postListPaidPlanError(input.client, input.channel, err),
    });
  } catch (err) {
    await maybeReportListFailure(input.client, input.channel, err);
  }
  await slackCall(input.client, "chat.postMessage", {
    channel: input.channel.slack_channel_id,
    thread_ts: input.threadTs,
    text: todo ? "todo captured" : "note captured",
  }, { channel: input.channel.slack_channel_id, user: input.user });
  return true;
}

async function syncCanvasIfAgentsChanged(
  client: any,
  channel: ReturnType<typeof getChannel>,
  user: string | null,
  before: string | null,
  reason: string,
) {
  if (!channel) return;
  const after = agentsFingerprint(channel);
  if (!after || after === before) return;
  const fresh = getChannel(channel.slack_channel_id) || channel;
  await syncAgentsCanvas({ client, channel: fresh, user, reason });
}

async function maybeReportListFailure(client: any, channel: ReturnType<typeof getChannel>, err: unknown) {
  if (!channel) return;
  if (isPaidPlanListError(err)) await postListPaidPlanError(client, channel, err);
}

async function ensureChannelSurfaces(
  client: any,
  channel: NonNullable<ReturnType<typeof getChannel>>,
  user: string | null,
  reason: string,
) {
  await syncAgentsCanvas({ client, channel, user, reason });
  try {
    await refreshListMirror({
      client,
      channel,
      user,
      onPaidPlanError: (err) => postListPaidPlanError(client, channel, err),
    });
  } catch (err) {
    await maybeReportListFailure(client, channel, err);
  }
}

async function handleUserMessage(opts: {
  channel: string;
  channelName?: string;
  threadTs: string;
  userMsgTs: string;
  user: string;
  text: string;
  client: any;
}) {
  let channel = getChannel(opts.channel);
  let channelName = opts.channelName;
  if (!channel && !channelName) {
    try {
      const info: any = await slackCall(opts.client, "conversations.info", { channel: opts.channel }, {
        channel: opts.channel,
        user: opts.user,
      });
      channelName = info.channel?.name;
    } catch (err) {
      log("warn", "channel_info_failed", { ...errorFields(err), channel: opts.channel });
    }
  }
  channel = channel || ensureChannelProject(opts.channel, channelName || opts.channel);
  if (await handleInlineCapture({ text: opts.text, channel, user: opts.user, client: opts.client, threadTs: opts.threadTs })) return;

  const mentionedConcierge = myBotUserId ? opts.text.includes(`<@${myBotUserId}>`) : false;
  const topLevelMessage = opts.threadTs === opts.userMsgTs;
  const mentionedClaudeCode =
    /^@claude-code\b/i.test(opts.text.trimStart()) ||
    (!!claudeCodeBotUserId && opts.text.trimStart().startsWith(`<@${claudeCodeBotUserId}>`));
  const skill = selectSkill(opts.text);
  if (channel.mode === "silent") return;
  if (channel.mode === "agent-tag" && !mentionedConcierge && !mentionedClaudeCode && !skill) return;

  const requestedProvider = providerFromText(opts.text, channel.provider_default, {
    topLevel: topLevelMessage,
    claudeCodeBotUserId,
  });
  const mentionedProvider = providerFromText(opts.text, channel.provider_default, {
    topLevel: true,
    claudeCodeBotUserId,
  });
  const existingThreadSession = getSessionForThread(opts.channel, opts.threadTs);
  const selectedProvider = (existingThreadSession?.provider_id as ProviderId | undefined) || requestedProvider;
  if (existingThreadSession && mentionedProvider !== selectedProvider) {
    log("info", "provider_switch_ignored_for_bound_thread", {
      channel: opts.channel,
      thread_ts: opts.threadTs,
      bound_provider: selectedProvider,
      requested_provider: mentionedProvider,
    });
  }
  const provider = providers[selectedProvider];
  const prompt = stripBotMentions(opts.text);
  if (!prompt) return;
  const session = createOrGetSession(opts.channel, opts.threadTs, selectedProvider);
  const turn = acquireSessionTurn(session.id, opts.userMsgTs, opts.text);
  if (turn.duplicate) {
    log("info", "duplicate_turn_skipped", { session_id: session.id, slack_user_msg_ts: opts.userMsgTs });
    return;
  }
  if (turn.busy) {
    log("warn", "session_turn_busy_rejected", {
      session_id: session.id,
      channel: opts.channel,
      thread_ts: opts.threadTs,
      slack_user_msg_ts: opts.userMsgTs,
      provider: selectedProvider,
    });
    await slackCall(opts.client, "chat.postMessage", {
      channel: opts.channel,
      thread_ts: opts.threadTs,
      text: "Concierge is already running a turn for this thread. Send this again after the current turn finishes.",
    }, { channel: opts.channel, user: opts.user });
    return;
  }
  log("info", "session_turn_lock_acquired", {
    session_id: session.id,
    channel: opts.channel,
    thread_ts: opts.threadTs,
    slack_user_msg_ts: opts.userMsgTs,
    provider: selectedProvider,
  });

  const cwd = channel.code_path || channel.vault_path;
  const additionalDirs = parseAdditionalPaths(channel);
  const agentsBefore = agentsFingerprint(channel);
  let listContext = "Slack List context is not currently readable.";
  try {
    const listPath = await refreshListMirror({
      client: opts.client,
      channel,
      user: opts.user,
      onPaidPlanError: (err) => postListPaidPlanError(opts.client, channel!, err),
    });
    if (listPath && existsSync(listPath)) listContext = readFileSync(listPath, "utf-8");
  } catch (err) {
    await maybeReportListFailure(opts.client, channel, err);
  }

  const turnStart = Date.now();
  let lastUpdate = turnStart;
  let toolCount = 0;
  const ack: any = await slackCall(opts.client, "chat.postMessage", {
    channel: opts.channel,
    thread_ts: opts.threadTs,
    text: `working - 0s elapsed, last update 0s ago, 0 tool calls`,
  }, { channel: opts.channel, user: opts.user });
  attachBotMessage(turn.id, ack.ts);

  const heartbeat = setInterval(async () => {
    try {
      await slackCall(opts.client, "chat.update", {
        channel: opts.channel,
        ts: ack.ts,
        text: `working - ${formatDuration(Date.now() - turnStart)} elapsed, last update ${formatDuration(Date.now() - lastUpdate)} ago, ${toolCount} tool calls`,
      }, { channel: opts.channel, user: opts.user });
    } catch (err) {
      log("warn", "heartbeat_failed", { ...errorFields(err), channel: opts.channel });
    }
  }, 30_000);

  try {
    const baseSystemPrompt = skillPrompt(skill);
    const systemPrompt = [
      baseSystemPrompt,
      buildListPromptContext(listContext),
    ].filter(Boolean).join("\n\n");
    const result = await provider.run({
      prompt,
      cwd,
      additionalDirs,
      sessionUUID: session.agent_session_uuid,
      systemPrompt,
      onProgress: (event) => {
        lastUpdate = Date.now();
        if (event.type === "tool_use") toolCount += 1;
      },
    });
    clearInterval(heartbeat);
    upsertSession(opts.channel, opts.threadTs, selectedProvider, result.sessionUUID, { status: "idle" });
    log("info", "session_turn_lock_released", {
      session_id: session.id,
      channel: opts.channel,
      thread_ts: opts.threadTs,
      slack_user_msg_ts: opts.userMsgTs,
      provider: selectedProvider,
      status: "idle",
    });
    finishTurn(turn.id, "done", result.text);
    await slackCall(opts.client, "chat.update", {
      channel: opts.channel,
      ts: ack.ts,
      text: `done - ${formatDuration(Date.now() - turnStart)} elapsed, ${result.toolsUsed.length} tool calls, provider ${selectedProvider}`,
    }, { channel: opts.channel, user: opts.user });
    const listOps = parseAgentListOps(result.text || "");
    if (listOps.adds.length || listOps.completes.length) {
      try {
        for (const itemText of listOps.adds) {
          await appendListItem({ client: opts.client, channel, text: itemText, source: "agent", user: opts.user });
        }
        for (const itemId of listOps.completes) {
          await completeListItem({ client: opts.client, channel, itemId, user: opts.user });
        }
        await refreshListMirror({
          client: opts.client,
          channel,
          user: opts.user,
          onPaidPlanError: (err) => postListPaidPlanError(opts.client, channel, err),
        });
        log("info", "agent_list_ops_applied", {
          channel: opts.channel,
          add_count: listOps.adds.length,
          complete_count: listOps.completes.length,
        });
      } catch (err) {
        await maybeReportListFailure(opts.client, channel, err);
        log("error", "agent_list_ops_failed", {
          channel: opts.channel,
          add_count: listOps.adds.length,
          complete_count: listOps.completes.length,
          ...errorFields(err),
        });
      }
    }
    const replyText = listOps.text || result.text || "(no output)";
    await postLongReply({
      client: opts.client,
      channel: opts.channel,
      threadTs: opts.threadTs,
      text: `${replyText}\n\n_provider: ${selectedProvider} - cwd: ${cwd}_`,
      user: opts.user,
    });
    const artifacts = findNewArtifacts(cwd, turnStart);
    log("info", "artifact_scan", {
      cwd,
      turnStart,
      scan_floor_ms: turnStart - ARTIFACT_SCAN_GRACE_MS,
      artifact_scan_grace_ms: ARTIFACT_SCAN_GRACE_MS,
      artifact_count: artifacts.length,
      artifact_names: artifacts.map(a => a.filename),
    });
    if (artifacts.length > 0) {
      await uploadArtifacts({ client: opts.client, channel: opts.channel, threadTs: opts.threadTs, artifacts, user: opts.user });
      log("info", "artifact_upload_done", { count: artifacts.length });
    }
    await syncCanvasIfAgentsChanged(opts.client, channel, opts.user, agentsBefore, "turn_done");
  } catch (err) {
    clearInterval(heartbeat);
    finishTurn(turn.id, "error", String(err));
    setSessionStatus(session.id, "error");
    log("info", "session_turn_lock_released", {
      session_id: session.id,
      channel: opts.channel,
      thread_ts: opts.threadTs,
      slack_user_msg_ts: opts.userMsgTs,
      provider: selectedProvider,
      status: "error",
    });
    log("error", "turn_failed", { ...errorFields(err), channel: opts.channel, thread_ts: opts.threadTs });
    await slackCall(opts.client, "chat.update", {
      channel: opts.channel,
      ts: ack.ts,
      text: `error: ${(err as Error).message.slice(0, 1200)}`,
    }, { channel: opts.channel, user: opts.user });
    await syncCanvasIfAgentsChanged(opts.client, channel, opts.user, agentsBefore, "turn_error");
  }
}

app.message(async ({ message, client }) => {
  const m = message as any;
  if (m.subtype && m.subtype !== "thread_broadcast") return;
  if (myBotUserId && m.user === myBotUserId) return;
  if (myBotId && m.bot_id === myBotId) return;
  await handleUserMessage({
    channel: m.channel,
    channelName: m.channel_name,
    threadTs: m.thread_ts || m.ts,
    userMsgTs: m.ts,
    user: m.user,
    text: m.text || "",
    client,
  });
});

app.event("app_mention", async () => {});

app.event("channel_created", async ({ event, client }) => {
  const channel = (event as any).channel;
  if (!channel?.id || !channel?.name) return;
  let joined = true;
  let joinErrorMsg: string | null = null;
  try {
    await slackCall(client, "conversations.join", { channel: channel.id });
  } catch (err) {
    joined = false;
    joinErrorMsg = (err as any)?.data?.error || (err as Error).message;
    log("warn", "channel_join_failed", { ...errorFields(err), channel: channel.id });
  }
  newProject(channel.id, channel.name);
  const channelRow = getChannel(channel.id);
  if (channelRow && joined) await ensureChannelSurfaces(client, channelRow, null, "channel_created");
  log("info", "channel_created_project_ready", { channel: channel.id, name: channel.name, joined });
  // If we could not auto-join, tell the user in-channel via chat:write.public.
  // Without this, the channel appears dead to a user who created it via the Slack UI.
  if (!joined) {
    try {
      await slackCall(client, "chat.postMessage", {
        channel: channel.id,
        text: `⚠️ Concierge auto-scaffolded this project but couldn't join the channel (\`${joinErrorMsg || "unknown"}\`). Two ways to fix:\n1. Type \`/invite @Concierge\` in this channel (one-time).\n2. Reinstall the app manifest in admin to grant the \`channels:join\` scope; future channels will auto-join.\n\nUntil then, this channel won't receive agent responses.`,
      });
    } catch (postErr) {
      log("warn", "channel_join_failure_notice_failed", { ...errorFields(postErr), channel: channel.id });
    }
  }
});

app.shortcut("send_to_inbox", async ({ ack, shortcut, client }) => {
  await ack();
  const s: any = shortcut;
  const channel = ensureChannelProject(s.channel.id, s.channel.name || s.channel.id);
  const file = appendInbox(channel, s.message.text || "", `shortcut by ${s.user.id}`);
  try {
    await appendListItem({ client, channel, text: s.message.text || "", source: "note", user: s.user.id });
    await refreshListMirror({
      client,
      channel,
      user: s.user.id,
      onPaidPlanError: (err) => postListPaidPlanError(client, channel, err),
    });
  } catch (err) {
    await maybeReportListFailure(client, channel, err);
  }
  await slackCall(client, "chat.postEphemeral", {
    channel: s.channel.id,
    user: s.user.id,
    text: `sent to inbox: ${file}`,
  });
});

app.shortcut("turn_into_todo", async ({ ack, shortcut, client }) => {
  await ack();
  const s: any = shortcut;
  const channel = ensureChannelProject(s.channel.id, s.channel.name || s.channel.id);
  const file = appendTodo(channel, s.message.text || "", `shortcut by ${s.user.id}`);
  try {
    await appendListItem({ client, channel, text: s.message.text || "", source: "todo", user: s.user.id });
    await refreshListMirror({
      client,
      channel,
      user: s.user.id,
      onPaidPlanError: (err) => postListPaidPlanError(client, channel, err),
    });
  } catch (err) {
    await maybeReportListFailure(client, channel, err);
  }
  await slackCall(client, "chat.postEphemeral", {
    channel: s.channel.id,
    user: s.user.id,
    text: `todo created: ${file}`,
  });
});

app.shortcut("fork_from_here", async ({ ack, shortcut, client }) => {
  await ack();
  const s: any = shortcut;
  const channel = ensureChannelProject(s.channel.id, s.channel.name || s.channel.id);
  const selectedThreadTs = s.message.thread_ts || s.message.ts;
  const parent = resolveForkParentSession(s.channel.id, selectedThreadTs);
  log("info", "fork_shortcut_parent_resolved", {
    channel: s.channel.id,
    selected_thread_ts: selectedThreadTs,
    selected_message_ts: s.message.ts || null,
    parent_session_id: parent?.id || null,
    parent_thread_ts: parent?.slack_thread_ts || null,
  });
  if (!parent?.agent_session_uuid) {
    await slackCall(client, "chat.postEphemeral", {
      channel: s.channel.id,
      user: s.user.id,
      text: "No persisted session found to fork.",
    });
    return;
  }
  try {
    const result = await providers[parent.provider_id as ProviderId].fork({
      cwd: channel.code_path || channel.vault_path,
      additionalDirs: parseAdditionalPaths(channel),
      sessionUUID: parent.agent_session_uuid,
      atMessageIdx: Number(s.message.ts?.replace(".", "")) || undefined,
    });
    const msg: any = await slackCall(client, "chat.postMessage", {
      channel: s.channel.id,
      thread_ts: s.message.thread_ts || s.message.ts,
      text: `Forked from this message.`,
    }, { channel: s.channel.id, user: s.user.id });
    upsertSession(s.channel.id, msg.ts, parent.provider_id as ProviderId, result.sessionUUID, {
      parentSessionId: parent.id,
      parentMessageIdx: Number(s.message.ts?.replace(".", "")) || null,
    });
  } catch (err) {
    await slackCall(client, "chat.postEphemeral", {
      channel: s.channel.id,
      user: s.user.id,
      text: `fork failed: ${(err as Error).message}`,
    });
  }
});

async function resolveBotStatusChannelId(client: any): Promise<string | null> {
  if (botStatusChannelId !== undefined) return botStatusChannelId;
  const configured = String(
    cfg.bot_status_channel_id ||
      cfg.bot_status_channel ||
      process.env.CONCIERGE_BOT_STATUS_CHANNEL ||
      "bot-status",
  ).replace(/^#/, "");
  if (/^[CGD][A-Z0-9]+$/.test(configured)) {
    botStatusChannelId = configured;
    log("info", "bot_status_channel_resolved", { channel: configured, source: "id" });
    return botStatusChannelId;
  }

  let cursor: string | undefined;
  do {
    const listed: any = await slackCall(client, "conversations.list", {
      exclude_archived: true,
      limit: 1000,
      cursor,
    });
    const found = listed.channels?.find((channel: any) => channel.name === configured);
    if (found?.id) {
      botStatusChannelId = found.id;
      log("info", "bot_status_channel_resolved", { channel: found.id, name: configured, source: "name" });
      return botStatusChannelId;
    }
    cursor = listed.response_metadata?.next_cursor || undefined;
  } while (cursor);

  try {
    const created: any = await slackCall(client, "conversations.create", { name: configured, is_private: false });
    botStatusChannelId = created.channel?.id || null;
    log("info", "bot_status_channel_created", { channel: botStatusChannelId, name: configured });
    return botStatusChannelId;
  } catch (err) {
    botStatusChannelId = null;
    log("warn", "bot_status_channel_missing", { ...errorFields(err), name: configured });
    return null;
  }
}

async function postBotStatusHeartbeat(reason: "startup" | "interval") {
  const channel = await resolveBotStatusChannelId(app.client);
  if (!channel) return;
  try {
    await slackCall(app.client, "chat.postMessage", {
      channel,
      text: `Concierge uptime ${formatDuration(Date.now() - startedAt)}`,
    });
    log("info", "bot_status_heartbeat_posted", { channel, reason });
  } catch (err) {
    log("warn", "bot_status_heartbeat_failed", errorFields(err));
  }
}

async function postListPaidPlanError(client: any, channel: NonNullable<ReturnType<typeof getChannel>>, err: unknown) {
  const statusChannel = await resolveBotStatusChannelId(client);
  const code = slackErrorCode(err);
  log("error", "list_paid_plan_failure", {
    channel: channel.slack_channel_id,
    list_id: channel.list_id,
    error: code,
  });
  if (!statusChannel) return;
  try {
    await slackCall(client, "chat.postMessage", {
      channel: statusChannel,
      text: `Slack Lists are unavailable for <#${channel.slack_channel_id}>: ${code}. Concierge kept markdown writes, but Slack List mirroring needs Slack Lists enabled on a paid workspace.`,
    });
  } catch (postErr) {
    log("warn", "list_paid_plan_status_post_failed", {
      channel: channel.slack_channel_id,
      status_channel: statusChannel,
      ...errorFields(postErr),
    });
  }
}

async function rerenderAllCanvases(reason: "startup" | "interval") {
  for (const channel of getAllChannels()) {
    await syncAgentsCanvas({ client: app.client, channel, user: null, reason: `scheduled_${reason}` });
  }
}

setInterval(async () => {
  await postBotStatusHeartbeat("interval");
}, 60 * 60 * 1000);

setInterval(async () => {
  await rerenderAllCanvases("interval");
}, 6 * 60 * 60 * 1000);

(async () => {
  await app.start();
  try {
    const auth: any = await app.client.auth.test();
    myBotUserId = auth.user_id as string;
    myBotId = (auth.bot_id as string) || null;
    log("info", "concierge_bot_online", {
      bot_user_id: myBotUserId,
      bot_id: myBotId,
      token_suffix: String(cfg.bot_token || "").slice(-4),
    });
    log("warn", "canvas_bidirectional_sync_not_supported", {
      reason: "Slack Canvas Web API exposes create/edit and section lookup, but no deterministic raw document read path; Concierge re-renders AGENTS.md to Canvas instead.",
    });
    await postBotStatusHeartbeat("startup");
    await rerenderAllCanvases("startup");
  } catch (err) {
    log("error", "auth_test_failed", errorFields(err));
  }
})();
