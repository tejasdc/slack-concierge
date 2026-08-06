import { App, LogLevel } from "@slack/bolt";
import toml from "@iarna/toml";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { newProject } from "./channel";
import { getChannel, getSession, upsertSession } from "./state";
import { runCodexTurn } from "./codex";

const cfg: any = toml.parse(readFileSync(`${homedir()}/.config/concierge/slack.toml`, "utf-8"));

const app = new App({
  token: cfg.bot_token,
  appToken: cfg.app_token,
  signingSecret: cfg.signing_secret,
  socketMode: true,
  logLevel: LogLevel.INFO,
  // Off: messages posted through this app via a user token carry a bot_id
  // matching the app, so ignoreSelf would silently drop them. We filter our
  // own bot's messages explicitly in the handler below.
  ignoreSelf: false,
});

app.command("/ping", async ({ ack, respond }) => {
  await ack();
  await respond({ text: `pong — concierge alive at ${new Date().toISOString()}`, response_type: "ephemeral" });
});

app.command("/new", async ({ ack, respond, command, client }) => {
  await ack();
  const name = command.text.trim();
  if (!name) return respond({ text: "usage: `/new <name>` — creates a channel-linked project", response_type: "ephemeral" });

  let created;
  try {
    created = await client.conversations.create({ name, is_private: false });
  } catch (e: any) {
    return respond({ text: `couldn't create channel #${name}: ${e.data?.error || e.message}`, response_type: "ephemeral" });
  }
  const chan = created.channel!;

  // Bot joins the new channel (needs channels:join or channels:manage scope)
  try { await client.conversations.join({ channel: chan.id! }); } catch {}

  // Invite the user who ran /new so they don't have to click Join
  try { await client.conversations.invite({ channel: chan.id!, users: command.user_id }); } catch {}

  const { vault, code } = newProject(chan.id!, chan.name!);
  await respond({
    text: `created <#${chan.id}> — vault: \`${vault}\`, code: \`${code}\``,
    response_type: "ephemeral",
  });
  await client.chat.postMessage({
    channel: chan.id!,
    text: `Concierge ready. Every message here starts or continues an agent turn.\nVault: \`${vault}\`  ·  Code: \`${code}\``,
  });
});

// Track our own bot user id AND bot id so we can skip only our own posts.
// Messages posted through the app via a user token also carry a bot_id
// (a *different* one from ours), so we must not filter every bot_id.
let myBotUserId: string | null = null;
let myBotId: string | null = null;

// Handler that runs a Codex turn from a user message.
async function handleUserMessage(opts: {
  channel: string;
  threadTs: string;
  text: string;
  client: any;
  logger: any;
}) {
  const chanRow = getChannel(opts.channel);
  if (!chanRow) return; // not a Concierge-managed channel
  const cwd = chanRow.code_path || chanRow.vault_path || "/root/workspace";
  const provider = "codex";
  const session = getSession(opts.channel, opts.threadTs, provider);
  const sessionUUID = session?.agent_session_uuid || null;

  const prompt = opts.text.replace(/<@[A-Z0-9]+>\s*/g, "").trim();
  if (!prompt) return;

  const ack = await opts.client.chat.postMessage({
    channel: opts.channel,
    thread_ts: opts.threadTs,
    text: `working... (${new Date().toISOString().slice(11, 19)})`,
  });
  const startedAt = Date.now();
  let lastUpdate = startedAt;
  const heartbeat = setInterval(async () => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const sinceUpdate = Math.round((Date.now() - lastUpdate) / 1000);
    try {
      await opts.client.chat.update({
        channel: opts.channel,
        ts: ack.ts!,
        text: `still working — ${elapsed}s elapsed, ${sinceUpdate}s since last event`,
      });
    } catch {}
  }, 30_000);

  try {
    const result = await runCodexTurn({
      prompt, cwd, sessionUUID,
      onProgress: () => { lastUpdate = Date.now(); },
    });
    clearInterval(heartbeat);
    upsertSession(opts.channel, opts.threadTs, provider, result.sessionUUID);
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const footer = `\n_provider: codex · ${elapsed}s · ${result.toolsUsed.length} tool calls · cwd: \`${cwd}\`_`;
    await opts.client.chat.update({
      channel: opts.channel,
      ts: ack.ts!,
      text: (result.text || "(no output)") + footer,
    });
  } catch (err: any) {
    clearInterval(heartbeat);
    opts.logger.error(err);
    await opts.client.chat.update({
      channel: opts.channel,
      ts: ack.ts!,
      text: `error: ${err.message?.slice(0, 500) || err}`,
    });
  }
}

// Every user message in a Concierge-managed channel triggers a turn.
// Skip: our own bot's messages, message_changed/deleted subtypes, bot messages,
// messages from apps other than a human.
app.message(async ({ message, client, logger }) => {
  const m = message as any;
  if (m.subtype && m.subtype !== "thread_broadcast") return; // edits/deletes/joins
  // Skip only OUR OWN bot's posts (identified by either its user_id or bot_id).
  // Do NOT filter every bot_id — messages sent via the user token from the
  // installed Concierge app also carry a bot_id but originate from Tejas.
  if (myBotUserId && m.user === myBotUserId) return;
  if (myBotId && m.bot_id === myBotId) return;
  const threadTs = m.thread_ts || m.ts;
  await handleUserMessage({
    channel: m.channel,
    threadTs,
    text: m.text || "",
    client,
    logger,
  });
});

// Keep app_mention as a no-op — message handler above already catches it.
app.event("app_mention", async () => {});

(async () => {
  await app.start();
  try {
    const auth: any = await app.client.auth.test();
    myBotUserId = auth.user_id as string;
    myBotId = (auth.bot_id as string) || null;
    console.log(`concierge bot online. bot_user=${myBotUserId} bot_id=${myBotId} bot_token=xoxb-...${cfg.bot_token.slice(-4)}`);
  } catch (e) {
    console.error("auth.test failed:", e);
  }
})();
