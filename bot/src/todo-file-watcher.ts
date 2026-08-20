import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { log } from "./log";
import type { ChannelRow } from "./state";

type ProjectionReason = "startup" | "file-change" | "capture" | "channel-created";

export class TodoFileWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly pending = new Map<string, {
    channel: ChannelRow;
    reason: ProjectionReason;
    timer: ReturnType<typeof setTimeout>;
    runAt: number;
  }>();
  private closed = false;

  constructor(
    private readonly project: (channel: ChannelRow, reason: ProjectionReason) => Promise<unknown>,
    private readonly debounceMs = 100,
    private readonly retryMs = 30_000,
  ) {}

  start(channels: ChannelRow[]) {
    for (const channel of channels) {
      this.watchChannel(channel);
      this.schedule(channel, "startup");
    }
  }

  watchChannel(channel: ChannelRow) {
    if (this.closed || this.watchers.has(channel.slack_channel_id)) return;
    const notesDirectory = join(channel.vault_path, "notes");
    mkdirSync(notesDirectory, { recursive: true });
    const watcher = watch(notesDirectory, (_eventType, filename) => {
      if (filename && String(filename) !== "TODOS.md") return;
      this.schedule(channel, "file-change");
    });
    watcher.on("error", (error) => {
      log("error", "todo_file_watcher_failed", {
        channel: channel.slack_channel_id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.watchers.set(channel.slack_channel_id, watcher);
  }

  schedule(channel: ChannelRow, reason: ProjectionReason = "capture") {
    this.scheduleAfter(channel, reason, this.debounceMs);
  }

  private scheduleAfter(channel: ChannelRow, reason: ProjectionReason, delayMs: number) {
    if (this.closed) return;
    this.watchChannel(channel);
    const key = channel.slack_channel_id;
    const existing = this.pending.get(key);
    if (existing) {
      existing.channel = channel;
      existing.reason = reason;
      if (existing.runAt <= Date.now() + delayMs) return;
      clearTimeout(existing.timer);
      this.pending.delete(key);
    }
    const pending = {
      channel,
      reason,
      runAt: Date.now() + delayMs,
      timer: setTimeout(() => {
        this.pending.delete(key);
        void this.project(pending.channel, pending.reason).catch((error) => {
          log("error", "todo_projection_failed", {
            channel: pending.channel.slack_channel_id,
            reason: pending.reason,
            error: error instanceof Error ? error.message : String(error),
          });
          this.scheduleAfter(pending.channel, pending.reason, this.retryMs);
        });
      }, delayMs),
    };
    this.pending.set(key, pending);
  }

  close() {
    this.closed = true;
    for (const watcher of this.watchers.values()) watcher.close();
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.watchers.clear();
    this.pending.clear();
  }
}
