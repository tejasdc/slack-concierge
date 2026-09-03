import { randomUUID } from "node:crypto";
import type { ProgressCb, ProgressEvent } from "./codex";
import { formatDuration } from "./text";

export type SlackAgentProgressChunk =
  | { type: "markdown_text"; text: string; commentaryId?: string; isCompaction?: true }
  | { type: "history_boundary" }
  | { type: "steering_boundary"; id: string }
  | { type: "plan_update"; title: string }
  | {
      type: "task_update";
      id: string;
      title: string;
      status: "in_progress" | "complete" | "error";
      details?: string;
    };

type ActivityEvent = Extract<ProgressEvent, { type: "activity" }>;
type TaskChunk = Extract<SlackAgentProgressChunk, { type: "task_update" }>;
type RecentActivity = { summary: string; status?: ActivityEvent["status"] };

export function legacyProgressChunks(chunks: SlackAgentProgressChunk[]) {
  return chunks.filter(chunk => chunk.type !== "steering_boundary" && chunk.type !== "history_boundary")
    .map(chunk => chunk.type === "markdown_text" ? { type: chunk.type, text: chunk.text } : chunk);
}

interface AgentProgressControllerOptions {
  resume?: { streamTs: string; activityId: string | null };
  start(chunks: SlackAgentProgressChunk[]): Promise<string>;
  append(streamTs: string, chunks: SlackAgentProgressChunk[]): Promise<void>;
  stop(streamTs: string, chunks: SlackAgentProgressChunk[]): Promise<void>;
  renew?(streamTs: string): Promise<void>;
  onError?: (error: unknown, phase: "append" | "stop" | "renew") => void;
  flushDelayMs?: number;
  heartbeatIntervalMs?: number;
  refreshIntervalMs?: number;
}

const MAX_COMMENTARY_CHUNK_CHARS = 12_000;
export const MAX_TASK_TITLE_CHARS = 240;
export const MAX_RECENT_ACTIVITIES = 10;
const MAX_ACTIVITY_SUMMARY_CHARS = 400;

function splitCommentaryForSlack(value: string) {
  const characters = Array.from(value);
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length; offset += MAX_COMMENTARY_CHUNK_CHARS) {
    chunks.push(characters.slice(offset, offset + MAX_COMMENTARY_CHUNK_CHARS).join(""));
  }
  return chunks;
}

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
    .replace(/\b([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, (candidate) => {
      try {
        const header = JSON.parse(Buffer.from(candidate.split(".")[0]!, "base64url").toString("utf8"));
        return header && typeof header.alg === "string" ? "[REDACTED JWT]" : candidate;
      } catch {
        return candidate;
      }
    })
    .replace(/\b([a-z0-9_-]*(?:api[_-]?key|token|secret|password|passwd)|authorization|cookie)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, "$1[REDACTED]@");
}

function safeToolTitle(toolName: string | undefined) {
  const knownTitles: Record<string, string> = {
    Read: "Reading files", Glob: "Listing files", Grep: "Searching files",
    Edit: "Editing files", MultiEdit: "Editing files", Write: "Writing files",
    Bash: "Running bash", WebSearch: "Searching the web", WebFetch: "Reading a web page",
    Agent: "Working with a sub-agent", Task: "Working with a sub-agent",
    TodoWrite: "Updating the plan", TaskCreate: "Updating the plan", TaskUpdate: "Updating the plan",
  };
  if (toolName && Object.hasOwn(knownTitles, toolName)) return knownTitles[toolName]!;
  const safeName = concise(String(toolName || "tool").replace(/[^a-zA-Z0-9_. -]/g, ""), 80) || "tool";
  return `Using ${safeName}`;
}

function safeProgressDetails(value: string, limit: number) {
  const characters = Array.from(redactAgentProgressText(value).trim());
  return characters.length <= limit ? characters.join("") : characters.slice(0, limit - 1).join("") + "…";
}

export function agentWorkCompleteTitle(durationMs?: number | null) {
  return typeof durationMs === "number" && Number.isSafeInteger(durationMs) && durationMs >= 0
    ? `Work complete · ${formatDuration(durationMs)}`
    : "Work complete";
}

export function progressActivityIdAfterChunks(chunks: SlackAgentProgressChunk[], activityId: string | null = null) {
  for (const chunk of chunks) {
    if (chunk.type === "steering_boundary" || chunk.type === "markdown_text" && chunk.text.trim()) activityId = null;
    else if (chunk.type === "task_update" && chunk.id !== "plan-progress") activityId = chunk.id;
  }
  return activityId;
}

export class AgentProgressController {
  private streamTs: string | null = null;
  private pendingChunks: SlackAgentProgressChunk[] = [];
  private pendingChunkIndexes = new Map<string, number>();
  private activityCard: TaskChunk | null = null;
  private hasCommentary = false;
  private openActivities = new Map<string, string>();
  private recentActivities = new Map<string, RecentActivity>();
  private consumedSteeringIds = new Set<string>();
  private supersededActivityIds = new Set<string>();
  private toolSequence = 0;
  private readonly operationNamespace = randomUUID();
  private readonly startingActivityId = `${this.operationNamespace}-starting`;
  private readonly fallbackActivityId = `${this.operationNamespace}-fallback`;
  private sequence = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingWrite: Promise<void> = Promise.resolve();
  private writing = false;
  private pendingRenewal: Promise<void> = Promise.resolve();
  private terminal = false;

  constructor(private readonly options: AgentProgressControllerOptions) {}

  async start() {
    if (this.streamTs) return this.streamTs;
    if (this.options.resume) {
      this.streamTs = this.options.resume.streamTs;
      this.activityCard = this.options.resume.activityId
        ? this.taskUpdate(this.options.resume.activityId, "Thinking", "in_progress") : null;
      this.openActivities.set(this.startingActivityId, "Thinking");
      this.hasCommentary = true;
      this.scheduleHeartbeat();
      this.scheduleRefresh();
      return this.streamTs;
    }
    const startingTask = this.taskUpdate(this.nextActivityCardId(), "Starting agent", "in_progress");
    this.activityCard = startingTask;
    this.streamTs = await this.options.start([startingTask]);
    this.openActivities.set(this.startingActivityId, startingTask.title);
    this.scheduleHeartbeat();
    this.scheduleRefresh();
    return this.streamTs;
  }

  readonly recordProgress: ProgressCb = (event) => {
    if (this.terminal) return;
    if (event.type === "steering") {
      if (this.consumedSteeringIds.has(event.clientMessageId)) return;
      this.consumedSteeringIds.add(event.clientMessageId);
      if (this.activityCard?.status === "in_progress") this.queueChunk({ ...this.activityCard, status: "complete" });
      for (const id of this.openActivities.keys()) {
        if (id !== this.startingActivityId && id !== this.fallbackActivityId) this.supersededActivityIds.add(id);
      }
      this.openActivities.clear();
      this.recentActivities.clear();
      this.activityCard = null;
      this.hasCommentary = false;
      this.queueChunk({ type: "steering_boundary", id: event.clientMessageId });
      this.openActivities.set(this.startingActivityId, "Thinking");
      this.updateActivityCard("Thinking", "in_progress");
      return;
    }
    if (event.type === "commentary") {
      this.queueCommentary(event.text);
      return;
    }
    if (event.type === "activity") {
      this.recordActivity(event);
      return;
    }
    if (event.type === "plan") {
      this.queueChunk({ type: "plan_update", title: concise(redactAgentProgressText(event.planTitle || "Plan"), MAX_TASK_TITLE_CHARS) });
      this.queueChunk({
        type: "task_update",
        id: "plan-progress",
        title: concise(redactAgentProgressText(event.title), MAX_TASK_TITLE_CHARS),
        status: event.status === "pending" ? "in_progress" : event.status,
        ...(event.details ? { details: redactAgentProgressText(event.details).trim() } : {}),
      });
      return;
    }
    if (event.type === "compaction") {
      this.queueText("_Context compacted; continuing._", true);
      return;
    }
    if (event.type === "tool_use") {
      this.openActivities.delete(this.startingActivityId);
      this.openActivities.delete(this.fallbackActivityId);
      const title = safeToolTitle(event.toolName);
      this.openActivities.set(this.fallbackActivityId, title);
      this.rememberActivity(event.itemId ?? `${this.operationNamespace}-tool-${++this.toolSequence}`, title);
      this.updateActivityCard(title, "in_progress");
      return;
    }
    if (event.type === "started" && this.openActivities.has(this.startingActivityId)) {
      this.openActivities.set(this.startingActivityId, "Thinking");
      this.updateActivityCard("Thinking", "in_progress");
    }
  };

  private queueCommentary(value: string) {
    const commentary = value.trim();
    if (!commentary) return;
    const separator = this.hasCommentary ? "\n\n" : "";
    this.queueText(`${separator}${commentary}`);
    this.hasCommentary = true;
  }

  private queueText(text: string, isCompaction = false) {
    if (this.activityCard?.status === "in_progress") {
      this.queueChunk({ ...this.activityCard, status: "complete" });
    }
    // A card belongs to the text interval where it was first displayed.
    this.activityCard = null;
    this.recentActivities.clear();
    this.queueChunk({ type: "markdown_text", text, commentaryId: randomUUID(), ...(isCompaction ? { isCompaction: true } : {}) });
  }

  async finish(outcome: "complete" | "error" | "cancelled", durationMs?: number | null) {
    if (this.terminal) return;
    this.terminal = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    await this.pendingWrite;
    await this.pendingRenewal;
    const streamTs = this.streamTs;
    if (!streamTs) return;
    const terminalStatus = outcome === "error" ? "error" : "complete";
    this.openActivities.clear();
    this.updateActivityCard(
      outcome === "complete" ? agentWorkCompleteTitle(durationMs) : outcome === "cancelled" ? "Stopped" : "Work stopped with an error",
      terminalStatus,
    );
    const chunks = this.takePendingChunks();
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
    if (this.activityCard?.status === "in_progress") {
      this.updateActivityCard(this.activityCard.title, "complete");
    }
    this.openActivities.clear();
    await this.pendingWrite;
    await this.flush();
    this.terminal = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    await this.pendingWrite;
    await this.pendingRenewal;
  }

  async flush(refresh = false) {
    if (!this.streamTs || this.terminal) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.writing) return this.pendingWrite;
    const chunks = this.takePendingChunks();
    if (chunks.length === 0 && !refresh) return this.pendingWrite;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    const streamTs = this.streamTs;
    this.writing = true;
    this.pendingWrite = this.pendingWrite.then(async () => {
      try {
        await this.options.append(streamTs, chunks);
      } catch (error) {
        this.options.onError?.(error, "append");
      } finally {
        this.writing = false;
        if (this.pendingChunks.length) this.scheduleFlush();
        this.scheduleRefresh();
      }
    });
    return this.pendingWrite;
  }

  private recordActivity(event: ActivityEvent) {
    if (this.supersededActivityIds.has(event.itemId)) return;
    this.openActivities.delete(this.startingActivityId);
    this.openActivities.delete(this.fallbackActivityId);
    const title = concise(redactAgentProgressText(event.title), MAX_TASK_TITLE_CHARS);
    const summary = event.details ? `${title}\n${event.details}` : title;
    this.rememberActivity(event.itemId, summary, event.status);
    if (event.status === "in_progress") this.openActivities.set(event.itemId, title);
    else this.openActivities.delete(event.itemId);
    const currentTitle = [...this.openActivities.values()].at(-1);
    const outcomeMark = currentTitle || title === "Thinking" ? ""
      : event.status === "complete" ? " ✓" : event.status === "error" ? " ⚠" : "";
    this.updateActivityCard(currentTitle ?? `${concise(title, MAX_TASK_TITLE_CHARS - outcomeMark.length)}${outcomeMark}`,
      currentTitle ? "in_progress" : event.status);
  }

  private taskUpdate(
    id: string,
    title: string,
    status: "in_progress" | "complete" | "error",
  ): TaskChunk {
    return { type: "task_update", id, title, status };
  }

  private nextActivityCardId() {
    return `operation-${this.operationNamespace}-${++this.sequence}`;
  }

  private updateActivityCard(title: string, status: TaskChunk["status"]) {
    this.activityCard = this.taskUpdate(this.activityCard?.id ?? this.nextActivityCardId(), title, status);
    if (this.recentActivities.size) {
      const groups: { summary: string; count: number }[] = [];
      for (const activity of [...this.recentActivities.values()].reverse()) {
        const previous = groups.at(-1);
        if (previous?.summary === activity.summary) previous.count++;
        else groups.push({ summary: activity.summary, count: 1 });
      }
      this.activityCard.details = `Recent activity\n${groups.map(({ summary, count }) => {
        const [title, ...details] = summary.split("\n");
        return [`• ${title}${count > 1 ? ` ×${count}` : ""}`, ...details].join("\n");
      }).join("\n")}`;
    }
    this.queueChunk(this.activityCard);
  }

  private rememberActivity(itemId: string, summary: string, status?: ActivityEvent["status"]) {
    if (summary === "Thinking") return;
    const activity = { summary: safeProgressDetails(summary, MAX_ACTIVITY_SUMMARY_CHARS), status };
    const previous = this.recentActivities.get(itemId);
    if (previous?.summary === activity.summary && previous.status === status) return;
    this.recentActivities.delete(itemId);
    this.recentActivities.set(itemId, activity);
    if (this.recentActivities.size > MAX_RECENT_ACTIVITIES) {
      this.recentActivities.delete(this.recentActivities.keys().next().value!);
    }
  }

  private queueChunk(chunk: SlackAgentProgressChunk) {
    // Coalescing must never move post-steering plan updates above the boundary.
    if (chunk.type === "steering_boundary") this.pendingChunkIndexes.clear();
    const key = chunk.type === "task_update" ? `task:${chunk.id}` : chunk.type === "plan_update" ? "plan" : null;
    const existingIndex = key ? this.pendingChunkIndexes.get(key) : undefined;
    if (existingIndex !== undefined) this.pendingChunks[existingIndex] = chunk;
    else {
      if (key) this.pendingChunkIndexes.set(key, this.pendingChunks.length);
      this.pendingChunks.push(chunk);
    }
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.flushTimer || !this.streamTs || this.terminal) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.options.flushDelayMs ?? 1_500);
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

  private scheduleRefresh() {
    if (this.terminal || !this.streamTs || this.refreshTimer) return;
    // Time changes even when the provider is quiet. Reuse the ordered writer;
    // an empty batch refreshes the existing native page without adding content.
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.flush(true);
    }, this.options.refreshIntervalMs ?? 30_000);
    this.refreshTimer.unref?.();
  }

  private takePendingChunks() {
    const chunks = this.pendingChunks;
    this.pendingChunks = [];
    this.pendingChunkIndexes.clear();
    return chunks.flatMap((chunk) => {
      if (chunk.type === "steering_boundary") return chunk;
      if (chunk.type === "markdown_text") {
        return splitCommentaryForSlack(redactAgentProgressText(chunk.text)).map((text) => ({
          ...chunk,
          text,
        }));
      }
      if (chunk.type === "plan_update") {
        return { ...chunk, title: redactAgentProgressText(chunk.title) };
      }
      return {
        ...chunk,
        title: redactAgentProgressText(chunk.title),
        ...(chunk.details ? { details: redactAgentProgressText(chunk.details) } : {}),
      };
    });
  }
}
