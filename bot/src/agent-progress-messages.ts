import { randomUUID } from "node:crypto";
import { webApi } from "@slack/bolt";
import { progressActivityIdAfterChunks, type SlackAgentProgressChunk } from "./agent-progress";
import { paginateProgress, progressBlocks, splitRejectedProgressPage } from "./agent-progress-pages";
import { agentProgressSlackCall } from "./rate-limit";
import { beginTurnProgressStream, db, getTurnProgressStream, recordTurnProgressStreamStarted } from "./state";

interface ProgressPage {
  turn_id: number;
  page_number: number;
  message_ts: string | null;
  client_msg_id: string;
  chunks_json: string;
  creation_state: "pending" | "posting" | "posted";
  dirty: number;
}

export function createProgressMessageClient(token: string, transport: Pick<webApi.WebClientOptions, "adapter" | "slackApiUrl"> = {}) {
  // The ordinary Bolt client retries transport errors automatically. Message
  // creation must return ambiguity to our durable owner instead of reposting.
  return new webApi.WebClient(token, {
    ...transport,
    retryConfig: { retries: 0 }, rejectRateLimitedCalls: true,
  });
}

export function beginAgentProgressMessages(turnId: number, chunks: SlackAgentProgressChunk[]) {
  // Page presence also distinguishes this transport from historical streams.
  // Commit it with the lifecycle transition so a crash cannot erase that proof.
  db.transaction(() => {
    beginTurnProgressStream(turnId);
    queueAgentProgressMessages(turnId, chunks);
  })();
}

export function hasAgentProgressMessages(turnId: number) {
  return Boolean(db.query("SELECT 1 FROM agent_progress_messages WHERE turn_id=? LIMIT 1").get(turnId));
}

function savePage(turnId: number, pageNumber: number, chunks: SlackAgentProgressChunk[]) {
  db.query(`INSERT INTO agent_progress_messages (turn_id, page_number, client_msg_id, chunks_json)
    VALUES (?, ?, ?, ?) ON CONFLICT(turn_id, page_number) DO UPDATE
    SET chunks_json=excluded.chunks_json, dirty=1`).run(turnId, pageNumber, randomUUID(), JSON.stringify(chunks));
}

export function queueAgentProgressMessages(turnId: number, chunks: SlackAgentProgressChunk[], terminal = false) {
  db.transaction(() => {
    const turn = getTurnProgressStream(turnId);
    if (!turn || !["starting", "streaming", "stopping"].includes(turn.progress_stream_state)) {
      throw new Error(`Turn ${turnId} cannot change its progress messages.`);
    }
    const finalized = db.query("SELECT progress_terminal_requested FROM turns WHERE id=?").get(turnId) as { progress_terminal_requested: number };
    if (finalized.progress_terminal_requested) return;
    const current = db.query("SELECT * FROM agent_progress_messages WHERE turn_id=? ORDER BY page_number DESC LIMIT 1")
      .get(turnId) as ProgressPage | null;
    const pages = paginateProgress(current ? JSON.parse(current.chunks_json) : [], chunks, terminal);
    for (const [offset, page] of pages.entries()) savePage(turnId, (current?.page_number ?? 0) + offset, page);
    db.query("UPDATE turns SET progress_activity_id=? WHERE id=?")
      .run(progressActivityIdAfterChunks(chunks, turn.progress_activity_id), turnId);
    if (terminal) db.query("UPDATE turns SET progress_terminal_requested=1 WHERE id=?").run(turnId);
  })();
}

function isRenderedBlockLimit(error: any) {
  return error?.data?.error === "invalid_blocks"
    && error.data.response_metadata?.messages?.some((message: unknown) =>
      typeof message === "string" && message.includes("no more than 50 items") && message.includes("/blocks"));
}

function repartitionPage(page: ProgressPage) {
  const split = splitRejectedProgressPage(JSON.parse(page.chunks_json));
  db.transaction(() => {
    // Only not-yet-published successors can exist while this dirty page is at
    // the head of the single writer's queue.
    const later = db.query("SELECT * FROM agent_progress_messages WHERE turn_id=? AND page_number>? ORDER BY page_number DESC")
      .all(page.turn_id, page.page_number) as ProgressPage[];
    if (later.some((row) => row.creation_state !== "pending")) throw new Error("Cannot reorder published progress pages.");
    for (const row of later) db.query("UPDATE agent_progress_messages SET page_number=page_number+? WHERE turn_id=? AND page_number=?")
      .run(split.length - 1, page.turn_id, row.page_number);
    db.query("UPDATE agent_progress_messages SET creation_state=? WHERE turn_id=? AND page_number=?")
      .run(page.message_ts ? "posted" : "pending", page.turn_id, page.page_number);
    split.forEach((chunks, offset) => savePage(page.turn_id, page.page_number + offset, chunks));
  })();
}

export async function projectAgentProgressMessages(client: any, turnId: number) {
  const turn = getTurnProgressStream(turnId);
  if (!turn) throw new Error(`Missing Agent turn ${turnId}.`);
  for (;;) {
    const page = db.query("SELECT * FROM agent_progress_messages WHERE turn_id=? AND dirty=1 ORDER BY page_number LIMIT 1")
      .get(turnId) as ProgressPage | null;
    if (!page) return;
    if (page.creation_state === "posting") throw new Error(`Progress page ${page.page_number} creation is ambiguous; refusing duplicate post.`);
    const args = {
      channel: turn.slack_channel_id,
      text: "Agent task progress",
      blocks: progressBlocks(JSON.parse(page.chunks_json)),
    };
    if (!page.message_ts) db.query("UPDATE agent_progress_messages SET creation_state='posting' WHERE turn_id=? AND page_number=?")
      .run(turnId, page.page_number);
    try {
      const result: any = page.message_ts
        ? await agentProgressSlackCall(client, "chat.update", { ...args, ts: page.message_ts })
        : await agentProgressSlackCall(client, "chat.postMessage", {
            ...args, thread_ts: turn.slack_thread_ts, client_msg_id: page.client_msg_id,
            unfurl_links: false, unfurl_media: false,
          });
      const ts = page.message_ts ?? result.ts;
      if (!ts) throw new Error("Slack returned no progress-message timestamp.");
      db.transaction(() => {
        db.query("UPDATE agent_progress_messages SET message_ts=?, creation_state='posted', dirty=0 WHERE turn_id=? AND page_number=?")
          .run(ts, turnId, page.page_number);
        if (page.page_number === 0 && !getTurnProgressStream(turnId)?.progress_stream_ts) {
          recordTurnProgressStreamStarted(turnId, ts, getTurnProgressStream(turnId)?.progress_activity_id);
        }
      })();
    } catch (error) {
      if (!isRenderedBlockLimit(error)) throw error;
      repartitionPage(page);
    }
  }
}
