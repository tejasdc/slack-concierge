import type { ProgressCb } from "./codex";

export const TURN_STATUS_HEARTBEAT_MS = 30_000;

export interface TurnStatusSnapshot {
  elapsedMs: number;
  lastUpdateAgeMs: number;
  toolCount: number;
}

interface TurnStatusHeartbeatOptions {
  update: (snapshot: TurnStatusSnapshot) => Promise<void>;
  onError?: (error: unknown) => void;
  intervalMs?: number;
  startedAt?: number;
  now?: () => number;
}

export class TurnStatusHeartbeat {
  private readonly startedAt: number;
  private lastProgressAt: number;
  private toolCount = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingUpdate: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly options: TurnStatusHeartbeatOptions) {
    this.startedAt = options.startedAt ?? this.now();
    this.lastProgressAt = this.startedAt;
  }

  readonly recordProgress: ProgressCb = (event) => {
    if (this.stopped) return;
    this.lastProgressAt = this.now();
    if (event.type === "tool_use") this.toolCount += 1;
  };

  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.options.intervalMs ?? TURN_STATUS_HEARTBEAT_MS);
  }

  refresh() {
    this.pendingUpdate = this.pendingUpdate.then(async () => {
      if (this.stopped) return;
      try {
        await this.options.update(this.snapshot());
      } catch (error) {
        this.options.onError?.(error);
      }
    });
    return this.pendingUpdate;
  }

  async stop() {
    if (!this.stopped) {
      this.stopped = true;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    }
    await this.pendingUpdate;
  }

  private snapshot(): TurnStatusSnapshot {
    const now = this.now();
    return {
      elapsedMs: now - this.startedAt,
      lastUpdateAgeMs: now - this.lastProgressAt,
      toolCount: this.toolCount,
    };
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }
}
