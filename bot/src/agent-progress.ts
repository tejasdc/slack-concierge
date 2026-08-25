import { createHash, randomUUID } from "node:crypto";
import type { ProgressCb, ProgressEvent } from "./codex";

export type SlackAgentProgressChunk =
  | { type: "markdown_text"; text: string }
  | { type: "plan_update"; title: string }
  | {
      type: "task_update";
      id: string;
      title: string;
      status: "in_progress" | "complete" | "error";
      details?: string;
    };

type ActivityEvent = Extract<ProgressEvent, { type: "activity" }>;

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

function operationTaskId(itemId: string) {
  const digest = createHash("sha256").update(itemId).digest("hex").slice(0, 24);
  return `operation-${digest}`;
}

export class AgentProgressController {
  private streamTs: string | null = null;
  private pendingCommentary: SlackAgentProgressChunk[] = [];
  private pendingActivities = new Map<string, Extract<SlackAgentProgressChunk, { type: "task_update" }>>();
  private pendingPlan: SlackAgentProgressChunk[] = [];
  private hasCommentary = false;
  private openActivities = new Map<string, string>();
  private fallbackActivityId: string | null = null;
  private readonly operationNamespace = randomUUID();
  private readonly startingTaskId = `operation-${this.operationNamespace}-starting`;
  private readonly resultTaskId = `operation-${this.operationNamespace}-result`;
  private sequence = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pendingWrite: Promise<void> = Promise.resolve();
  private pendingRenewal: Promise<void> = Promise.resolve();
  private terminal = false;

  constructor(private readonly options: AgentProgressControllerOptions) {}

  async start() {
    if (this.streamTs) return this.streamTs;
    const startingTask = this.taskUpdate(this.startingTaskId, "Starting agent", "in_progress");
    this.streamTs = await this.options.start([startingTask]);
    this.openActivities.set(startingTask.id, startingTask.title);
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
      this.closeStartingActivity();
      this.closeFallbackActivity();
      const taskId = `operation-${this.operationNamespace}-${++this.sequence}`;
      const title = safeToolTitle(event.toolName);
      this.fallbackActivityId = taskId;
      this.openActivities.set(taskId, title);
      this.queueActivity(this.taskUpdate(taskId, title, "in_progress"));
      this.scheduleFlush();
      return;
    }
    if (event.type === "started") {
      this.openActivities.set(this.startingTaskId, "Thinking");
      this.queueActivity(this.taskUpdate(this.startingTaskId, "Thinking", "in_progress"));
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
    const terminalStatus = outcome === "error" ? "error" : "complete";
    const closingActivities = [...this.openActivities].map(([id, title]) => (
      this.taskUpdate(id, title, terminalStatus)
    ));
    this.openActivities.clear();
    const terminalChunk = this.taskUpdate(
      this.resultTaskId,
      outcome === "complete" ? "Work complete" : outcome === "cancelled" ? "Stopped" : "Work stopped with an error",
      terminalStatus,
    );
    const chunks = [...this.takePendingChunks(), ...closingActivities, terminalChunk];
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
    for (const [id, title] of this.openActivities) {
      this.queueActivity(this.taskUpdate(id, title, "complete"));
    }
    this.openActivities.clear();
    this.fallbackActivityId = null;
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
    this.closeStartingActivity();
    this.discardPendingFallbackActivity();
    const taskId = operationTaskId(event.itemId);
    const title = concise(event.title, MAX_TASK_TITLE_CHARS);
    if (event.status === "in_progress") this.openActivities.set(taskId, title);
    else this.openActivities.delete(taskId);
    this.queueActivity(this.taskUpdate(taskId, title, event.status));
    this.scheduleFlush();
  }

  private taskUpdate(
    id: string,
    title: string,
    status: "in_progress" | "complete" | "error",
  ): Extract<SlackAgentProgressChunk, { type: "task_update" }> {
    return { type: "task_update", id, title, status };
  }

  private queueActivity(chunk: Extract<SlackAgentProgressChunk, { type: "task_update" }>) {
    this.pendingActivities.set(chunk.id, chunk);
  }

  private closeStartingActivity() {
    const title = this.openActivities.get(this.startingTaskId);
    if (!title) return;
    this.openActivities.delete(this.startingTaskId);
    this.queueActivity(this.taskUpdate(this.startingTaskId, title, "complete"));
  }

  private closeFallbackActivity() {
    if (!this.fallbackActivityId) return;
    const title = this.openActivities.get(this.fallbackActivityId);
    if (title) {
      this.openActivities.delete(this.fallbackActivityId);
      this.queueActivity(this.taskUpdate(this.fallbackActivityId, title, "complete"));
    }
    this.fallbackActivityId = null;
  }

  private discardPendingFallbackActivity() {
    if (!this.fallbackActivityId) return;
    this.pendingActivities.delete(this.fallbackActivityId);
    this.openActivities.delete(this.fallbackActivityId);
    this.fallbackActivityId = null;
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
      ...this.pendingActivities.values(),
    ];
    this.pendingCommentary = [];
    this.pendingPlan = [];
    this.pendingActivities.clear();
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
