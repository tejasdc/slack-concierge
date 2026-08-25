import type { ProgressCb, ProgressEvent } from "./codex";

export type SlackAgentProgressChunk =
  | { type: "markdown_text"; text: string }
  | { type: "plan_update"; title: string }
  | {
      type: "task_update";
      id: "current-activity" | "plan-progress";
      title: string;
      status: "in_progress" | "complete" | "error";
      details?: string;
    };

type ActivityEvent = Extract<ProgressEvent, { type: "activity" }>;

interface ActiveActivity {
  id: string;
  title: string;
  sequence: number;
}

interface AgentProgressControllerOptions {
  start(chunks: SlackAgentProgressChunk[]): Promise<string>;
  append(streamTs: string, chunks: SlackAgentProgressChunk[]): Promise<void>;
  stop(streamTs: string, chunks: SlackAgentProgressChunk[]): Promise<void>;
  renew?(streamTs: string): Promise<void>;
  onError?: (error: unknown, phase: "append" | "stop" | "renew") => void;
  flushDelayMs?: number;
  heartbeatIntervalMs?: number;
}

const MAX_COMMENTARY_CHARS = 12_000;
const MAX_TASK_TITLE_CHARS = 240;

function concise(value: string, limit: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

export function redactAgentProgressText(value: string) {
  return value
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/gi, "[REDACTED SLACK WEBHOOK]")
    .replace(/\bAuthorization\s*[:=]\s*[^\r\n]+/gi, "Authorization: [REDACTED]")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g, "[REDACTED TOKEN]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED AWS ACCESS KEY]")
    .replace(/\b([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[REDACTED JWT]")
    .replace(/\b([a-z0-9_-]*(?:api[_-]?key|token|secret|password|passwd)|authorization|cookie)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, "$1[REDACTED]@");
}

function safeToolTitle(toolName: string | undefined) {
  const safeName = concise(String(toolName || "tool").replace(/[^a-zA-Z0-9_. -]/g, ""), 80) || "tool";
  return `Using ${safeName}`;
}

export class AgentProgressController {
  private streamTs: string | null = null;
  private pendingCommentary: SlackAgentProgressChunk[] = [];
  private pendingActivity: SlackAgentProgressChunk | null = null;
  private pendingPlan: SlackAgentProgressChunk[] = [];
  private hasCommentary = false;
  private activeActivities = new Map<string, ActiveActivity>();
  private sequence = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pendingWrite: Promise<void> = Promise.resolve();
  private pendingRenewal: Promise<void> = Promise.resolve();
  private terminal = false;

  constructor(private readonly options: AgentProgressControllerOptions) {}

  async start() {
    if (this.streamTs) return this.streamTs;
    this.streamTs = await this.options.start([
      {
        type: "task_update",
        id: "current-activity",
        title: "Starting agent",
        status: "in_progress",
      },
    ]);
    this.scheduleHeartbeat();
    return this.streamTs;
  }

  readonly recordProgress: ProgressCb = (event) => {
    if (this.terminal) return;
    if (event.type === "commentary") {
      this.queueCommentary(event.text);
      return;
    }
    if (event.type === "activity") {
      this.recordActivity(event);
      return;
    }
    if (event.type === "plan") {
      this.pendingPlan = [
        { type: "plan_update", title: concise(event.planTitle || "Plan", MAX_TASK_TITLE_CHARS) },
        {
          type: "task_update",
          id: "plan-progress",
          title: concise(event.title, MAX_TASK_TITLE_CHARS),
          status: event.status === "pending" ? "in_progress" : event.status,
        },
      ];
      this.scheduleFlush();
      return;
    }
    if (event.type === "compaction") {
      this.pendingCommentary.push({ type: "markdown_text", text: "_Context compacted; continuing._" });
      this.scheduleFlush();
      return;
    }
    if (event.type === "tool_use") {
      this.pendingActivity = {
        type: "task_update",
        id: "current-activity",
        title: safeToolTitle(event.toolName),
        status: "in_progress",
      };
      this.scheduleFlush();
      return;
    }
    if (event.type === "started") {
      this.pendingActivity = {
        type: "task_update",
        id: "current-activity",
        title: "Thinking",
        status: "in_progress",
      };
      this.scheduleFlush();
    }
  };

  private queueCommentary(value: string) {
    const commentary = value.trim();
    if (!commentary) return;
    const separator = this.hasCommentary ? "\n\n" : "";
    this.pendingCommentary.push({
      type: "markdown_text",
      text: `${separator}${commentary.slice(0, MAX_COMMENTARY_CHARS - separator.length)}`,
    });
    this.hasCommentary = true;
    this.scheduleFlush();
  }

  async finish(outcome: "complete" | "error" | "cancelled") {
    if (this.terminal) return;
    this.terminal = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    await this.pendingWrite;
    await this.pendingRenewal;
    const streamTs = this.streamTs;
    if (!streamTs) return;
    const terminalChunk: SlackAgentProgressChunk = {
      type: "task_update",
      id: "current-activity",
      title: outcome === "complete" ? "Work complete" : outcome === "cancelled" ? "Stopped" : "Work stopped with an error",
      status: outcome === "complete" ? "complete" : outcome === "cancelled" ? "complete" : "error",
    };
    const chunks = [...this.takePendingChunks(), terminalChunk];
    try {
      await this.options.stop(streamTs, chunks);
    } catch (error) {
      this.options.onError?.(error, "stop");
      throw error;
    }
  }

  async pauseForRetry() {
    if (this.terminal) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    await this.flush();
    this.terminal = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    await this.pendingWrite;
    await this.pendingRenewal;
  }

  async flush() {
    if (!this.streamTs || this.terminal) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const chunks = this.takePendingChunks();
    if (chunks.length === 0) return this.pendingWrite;
    const streamTs = this.streamTs;
    this.pendingWrite = this.pendingWrite.then(async () => {
      try {
        await this.options.append(streamTs, chunks);
      } catch (error) {
        this.options.onError?.(error, "append");
      }
    });
    return this.pendingWrite;
  }

  private recordActivity(event: ActivityEvent) {
    if (event.status === "in_progress") {
      this.activeActivities.set(event.itemId, {
        id: event.itemId,
        title: concise(event.title, MAX_TASK_TITLE_CHARS),
        sequence: ++this.sequence,
      });
    } else {
      this.activeActivities.delete(event.itemId);
    }
    const current = [...this.activeActivities.values()]
      .sort((left, right) => right.sequence - left.sequence)[0];
    this.pendingActivity = current
      ? {
          type: "task_update",
          id: "current-activity",
          title: current.title,
          status: "in_progress",
        }
      : {
          type: "task_update",
          id: "current-activity",
          title: concise(event.title, MAX_TASK_TITLE_CHARS),
          status: event.status,
        };
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.flushTimer || !this.streamTs || this.terminal) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.options.flushDelayMs ?? 750);
    this.flushTimer.unref?.();
  }

  private scheduleHeartbeat() {
    if (!this.options.renew || !this.streamTs || this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (!this.streamTs || this.terminal) return;
      const streamTs = this.streamTs;
      this.pendingRenewal = this.pendingRenewal.then(async () => {
        if (this.terminal) return;
        try {
          await this.options.renew!(streamTs);
        } catch (error) {
          this.options.onError?.(error, "renew");
        }
      });
    }, this.options.heartbeatIntervalMs ?? 45 * 60_000);
    this.heartbeatTimer.unref?.();
  }

  private takePendingChunks() {
    const chunks = [
      ...this.pendingCommentary,
      ...this.pendingPlan,
      ...(this.pendingActivity ? [this.pendingActivity] : []),
    ];
    this.pendingCommentary = [];
    this.pendingPlan = [];
    this.pendingActivity = null;
    return chunks.map((chunk) => {
      if (chunk.type === "markdown_text" || chunk.type === "plan_update") {
        return { ...chunk, [chunk.type === "markdown_text" ? "text" : "title"]: redactAgentProgressText(chunk.type === "markdown_text" ? chunk.text : chunk.title) } as SlackAgentProgressChunk;
      }
      return {
        ...chunk,
        title: redactAgentProgressText(chunk.title),
        ...(chunk.details ? { details: redactAgentProgressText(chunk.details) } : {}),
      };
    });
  }
}
