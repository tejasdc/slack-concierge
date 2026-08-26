import { watch, type FSWatcher } from "node:fs";
import { log } from "./log";
import type { ChannelRow } from "./state";

export interface ProjectionWatchTarget {
  directory: string;
  filename: string;
}

interface WatchedTarget {
  key: string;
  watcher: FSWatcher;
}

interface PendingProjection<Reason extends string> {
  channel: ChannelRow;
  reason: Reason;
  timer: ReturnType<typeof setTimeout>;
  runAt: number;
}

export class ProjectionWatcher<Reason extends string> {
  private readonly watchers = new Map<string, WatchedTarget>();
  private readonly pending = new Map<string, PendingProjection<Reason>>();
  private closed = false;

  constructor(
    private readonly options: {
      name: string;
      startupReason: Reason;
      resolveTarget: (channel: ChannelRow) => ProjectionWatchTarget | null;
      project: (channel: ChannelRow, reason: Reason) => Promise<unknown>;
      changedReason: Reason;
      debounceMs?: number;
      retryMs?: number | null;
      shouldRetry?: (error: unknown) => boolean;
    },
  ) {}

  start(channels: ChannelRow[]) {
    for (const channel of channels) {
      this.schedule(channel, this.options.startupReason);
    }
  }

  watchChannel(channel: ChannelRow): boolean {
    if (this.closed) return false;

    const channelId = channel.slack_channel_id;
    const target = this.options.resolveTarget(channel);
    const existing = this.watchers.get(channelId);

    if (!target) {
      existing?.watcher.close();
      this.watchers.delete(channelId);
      const pending = this.pending.get(channelId);
      if (pending) clearTimeout(pending.timer);
      this.pending.delete(channelId);
      return false;
    }

    const targetKey = `${target.directory}\0${target.filename}`;
    if (existing?.key === targetKey) return true;

    existing?.watcher.close();
    this.watchers.delete(channelId);

    try {
      const watcher = watch(target.directory, (_eventType, filename) => {
        if (filename && String(filename) !== target.filename) return;
        this.schedule(channel, this.options.changedReason);
      });
      watcher.on("error", (error) => {
        if (this.watchers.get(channelId)?.watcher === watcher) this.watchers.delete(channelId);
        watcher.close();
        log("error", "projection_source_watch_failed", {
          projection: this.options.name,
          channel: channelId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      this.watchers.set(channelId, { key: targetKey, watcher });
      return true;
    } catch (error) {
      log("error", "projection_source_watch_failed", {
        projection: this.options.name,
        channel: channelId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  schedule(channel: ChannelRow, reason: Reason) {
    this.scheduleAfter(channel, reason, this.options.debounceMs ?? 100);
  }

  private scheduleAfter(channel: ChannelRow, reason: Reason, delayMs: number) {
    if (this.closed || !this.watchChannel(channel)) return;

    const key = channel.slack_channel_id;
    const existing = this.pending.get(key);
    if (existing) {
      existing.channel = channel;
      existing.reason = reason;
      if (existing.runAt <= Date.now() + delayMs) return;
      clearTimeout(existing.timer);
      this.pending.delete(key);
    }

    const pending: PendingProjection<Reason> = {
      channel,
      reason,
      runAt: Date.now() + delayMs,
      timer: setTimeout(() => {
        this.pending.delete(key);
        void this.options.project(pending.channel, pending.reason).catch((error) => {
          log("error", "projection_failed", {
            projection: this.options.name,
            channel: pending.channel.slack_channel_id,
            reason: pending.reason,
            error: error instanceof Error ? error.message : String(error),
          });
          if (this.options.retryMs != null && (this.options.shouldRetry?.(error) ?? true)) {
            this.scheduleAfter(pending.channel, pending.reason, this.options.retryMs);
          }
        });
      }, delayMs),
    };
    this.pending.set(key, pending);
  }

  close() {
    this.closed = true;
    for (const watchedTarget of this.watchers.values()) watchedTarget.watcher.close();
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.watchers.clear();
    this.pending.clear();
  }
}
