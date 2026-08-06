import { App, LogLevel } from "@slack/bolt";
import toml from "@iarna/toml";
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
} from "./channel";
import { findNewArtifacts } from "./artifacts";
import { errorFields, log } from "./log";
import { providers, providerFromText } from "./providers";
import {
  attachBotMessage,
  ChannelMode,
  createOrGetSession,
  finishTurn,
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

async function ensureChannelFromCommand(command: any) {
  const existing = getChannel(command.channel_id);
  if (existing) return existing;
  return ensureChannelProject(command.channel_id, commandChannelName(command));
}

app.command("/ping", async ({ ack, respond }) => {
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

  try {
    const created: any = await slackCall(client, "conversations.create", { name, is_private: false }, {
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

app.command("/promote", async ({ ack, respond, command }) => {
  await ack();
  try {
    const channel = await ensureChannelFromCommand(command);
    const paths = promoteChannel(channel);
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

app.command("/todo", async ({ ack, respond, command }) => {
  await ack();
  const text = command.text.trim();
  if (!text) return respond({ text: "usage: /todo <text>", response_type: "ephemeral" });
  const channel = await ensureChannelFromCommand(command);
  const file = appendTodo(channel, text, `/todo by ${command.user_name || command.user_id}`);
  await respond({ text: `todo appended to ${file}`, response_type: "ephemeral" });
});

app.command("/note", async ({ ack, respond, command }) => {
  await ack();
  const text = command.text.trim();
  if (!text) return respond({ text: "usage: /note <text>", response_type: "ephemeral" });
  const channel = await ensureChannelFromCommand(command);
  const file = appendInbox(channel, text, `/note by ${command.user_name || command.user_id}`);
  await respond({ text: `note appended to ${file}`, response_type: "ephemeral" });
});

app.command("/auth-refresh", async ({ ack, respond, command }) => {
  await ack();
  const provider = command.text.trim() || "codex";
  await respond({
    text: `auth refresh requested for ${provider}. The command is registered; the pty code-entry flow is still stubbed in this build.`,
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
  const todo = input.text.match(/^!todo\s+([\s\S]+)/i);
  const note = input.text.match(/^!note\s+([\s\S]+)/i);
  if (!todo && !note) return false;
  if (todo) appendTodo(input.channel, todo[1], `inline by ${input.user}`);
  if (note) appendInbox(input.channel, note[1], `inline by ${input.user}`);
  await slackCall(input.client, "chat.postMessage", {
    channel: input.channel.slack_channel_id,
    thread_ts: input.threadTs,
    text: todo ? "todo captured" : "note captured",
  }, { channel: input.channel.slack_channel_id, user: input.user });
  return true;
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
    const result = await provider.run({
      prompt,
      cwd,
      additionalDirs,
      sessionUUID: session.agent_session_uuid,
      systemPrompt: skillPrompt(skill),
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
    await postLongReply({
      client: opts.client,
      channel: opts.channel,
      threadTs: opts.threadTs,
      text: `${result.text || "(no output)"}\n\n_provider: ${selectedProvider} - cwd: ${cwd}_`,
      user: opts.user,
    });
    const artifacts = findNewArtifacts(cwd, turnStart);
    log("info", "artifact_scan", { cwd, turnStart, artifact_count: artifacts.length, artifact_names: artifacts.map(a => a.filename) });
    if (artifacts.length > 0) {
      await uploadArtifacts({ client: opts.client, channel: opts.channel, threadTs: opts.threadTs, artifacts, user: opts.user });
      log("info", "artifact_upload_done", { count: artifacts.length });
    }
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
  try {
    await slackCall(client, "conversations.join", { channel: channel.id });
  } catch (err) {
    log("warn", "channel_join_failed", { ...errorFields(err), channel: channel.id });
  }
  newProject(channel.id, channel.name);
  log("info", "channel_created_project_ready", { channel: channel.id, name: channel.name });
});

app.shortcut("send_to_inbox", async ({ ack, shortcut, client }) => {
  await ack();
  const s: any = shortcut;
  const channel = ensureChannelProject(s.channel.id, s.channel.name || s.channel.id);
  const file = appendInbox(channel, s.message.text || "", `shortcut by ${s.user.id}`);
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

setInterval(async () => {
  if (!cfg.bot_status_channel_id) return;
  try {
    await slackCall(app.client, "chat.postMessage", {
      channel: cfg.bot_status_channel_id,
      text: `Concierge uptime ${formatDuration(Date.now() - startedAt)}`,
    });
  } catch (err) {
    log("warn", "bot_status_heartbeat_failed", errorFields(err));
  }
}, 60 * 60 * 1000);

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
  } catch (err) {
    log("error", "auth_test_failed", errorFields(err));
  }
})();
