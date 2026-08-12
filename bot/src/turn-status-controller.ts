import type { ProgressCb } from "./codex";
import { formatTurnStatusMessage } from "./text";
import { TurnStatusHeartbeat } from "./turn-status";

export interface TurnStatusUpdate {
  text: string;
  phase: "heartbeat" | "done" | "error";
}

export type TurnStatusProjectionOutcome = "delivered" | "stopped" | "permanent_failure";

interface TurnStatusControllerOptions {
  updateHeartbeat: (update: TurnStatusUpdate) => Promise<void>;
  projectTerminal: (update: TurnStatusUpdate) => Promise<TurnStatusProjectionOutcome>;
  onError?: (error: unknown, phase: TurnStatusUpdate["phase"]) => void;
  startedAt?: number;
  intervalMs?: number;
  now?: () => number;
}

export class TurnStatusController {
  private readonly heartbeat: TurnStatusHeartbeat;

  constructor(private readonly options: TurnStatusControllerOptions) {
    this.heartbeat = new TurnStatusHeartbeat({
      startedAt: options.startedAt,
      intervalMs: options.intervalMs,
      now: options.now,
      update: async ({ elapsedMs, lastUpdateAgeMs, toolCount }) => {
        await this.updateHeartbeat({
          phase: "heartbeat",
          text: formatTurnStatusMessage({
            state: "working",
            elapsedMs,
            lastUpdateAgeMs,
            toolCount,
          }),
        });
      },
      onError: (error) => options.onError?.(error, "heartbeat"),
    });
  }

  readonly recordProgress: ProgressCb = (event) => {
    this.heartbeat.recordProgress(event);
  };

  start() {
    this.heartbeat.start();
  }

  refresh() {
    return this.heartbeat.refresh();
  }

  async complete(input: {
    elapsedMs: number;
    toolCount: number;
    provider: string;
    tldr: string;
  }) {
    await this.heartbeat.stop();
    return this.options.projectTerminal({
      phase: "done",
      text: formatTurnStatusMessage({
        state: "done",
        elapsedMs: input.elapsedMs,
        toolCount: input.toolCount,
        provider: input.provider,
        tldr: input.tldr,
      }),
    });
  }

  async fail(detail: string) {
    await this.heartbeat.stop();
    return this.options.projectTerminal({
      phase: "error",
      text: formatTurnStatusMessage({
        state: "error",
        detail,
      }),
    });
  }

  stop() {
    return this.heartbeat.stop();
  }

  private async updateHeartbeat(update: TurnStatusUpdate) {
    try {
      await this.options.updateHeartbeat(update);
    } catch (error) {
      this.options.onError?.(error, update.phase);
    }
  }
}
