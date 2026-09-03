import { MAX_TASK_TITLE_CHARS, type SlackAgentProgressChunk } from "./agent-progress";
import { splitProgressMarkdown } from "./progress-markdown";
import { formatDuration } from "./text";

export type ProgressChunk = SlackAgentProgressChunk;
export const MAX_PROGRESS_MARKDOWN = 12_000;
export const MAX_PROGRESS_HISTORY_CHARS = 12_000;
export const MAX_PROGRESS_HISTORY_UPDATES = 50;

function compactProgress(chunks: ProgressChunk[]) {
  const commentaryChunks = chunks.filter(c => c.type === "markdown_text" && !c.isCompaction);
  const commentary = commentaryChunks.at(-1);
  const latestCommentaryIndex = chunks.findLastIndex(c => c.type === "markdown_text" && !c.isCompaction);
  const latestActivityIndex = chunks.findLastIndex(c => c.type === "task_update" && c.id !== "plan-progress");
  return {
    commentary,
    activity: latestActivityIndex > latestCommentaryIndex ? chunks[latestActivityIndex] : undefined,
    history: commentaryChunks.slice(0, -1),
    historyOmitted: chunks.some(c => c.type === "history_boundary"),
    plan: chunks.findLast(c => c.type === "task_update" && c.id === "plan-progress"),
  };
}

function richTextSection(text: string) {
  return { type: "rich_text_section", elements: [{ type: "text", text }] };
}

function richText(text: string) {
  return { type: "rich_text", elements: [richTextSection(text)] };
}

function activityDetails(text: string) {
  const prefix = "Recent activity\n• ";
  if (!text.startsWith(prefix)) return richText(text);
  const elements: Record<string, unknown>[] = [richTextSection("Recent activity")];
  for (const summary of text.slice(prefix.length).split("\n• ")) {
    const [title, ...details] = summary.split("\n").map(line => line.trim()).filter(Boolean);
    if (!title) continue;
    elements.push({ type: "rich_text_list", style: "bullet", indent: 0, elements: [richTextSection(title)] });
    if (details.length) elements.push({ type: "rich_text_list", style: "bullet", indent: 1, elements: details.map(richTextSection) });
  }
  return { type: "rich_text", elements };
}

export function progressBlocks(chunks: ProgressChunk[], runningSince?: number, now = Date.now()): Record<string, unknown>[] {
  const { commentary, activity: latestActivity, history, historyOmitted, plan } = compactProgress(chunks);
  // Long commentary can continue without carrying a completed activity snapshot.
  // A live turn still needs its indicator and clock on that current page.
  const activity = latestActivity ?? (runningSince === undefined ? undefined : {
    type: "task_update" as const, id: "turn-progress", title: "Thinking", status: "in_progress" as const,
  });
  const blocks: Record<string, unknown>[] = [];
  if (commentary?.type === "markdown_text") blocks.push({ type: "markdown", text: commentary.text });
  if (history.length) blocks.push({
    type: "container",
    title: { type: "plain_text", text: historyOmitted ? "Earlier progress (recent)" : "Earlier progress" },
    is_collapsible: true,
    default_collapsed: true,
    child_blocks: [{
      type: "rich_text",
      elements: [richTextSection(history.toReversed().map(chunk => chunk.text).join("\n\n"))],
    }],
  });
  for (const chunk of [activity, plan]) {
    if (chunk?.type !== "task_update") continue;
    const isRunningTurn = chunk === activity && runningSince !== undefined;
    const suffix = isRunningTurn
      ? ` · ${formatDuration(now - runningSince * 1000)} elapsed` : "";
    const title = Array.from(chunk.title);
    const titleBudget = MAX_TASK_TITLE_CHARS - suffix.length;
    blocks.push({
      type: "task_card", task_id: chunk.id,
      title: (title.length > titleBudget ? title.slice(0, titleBudget - 1).join("") + "…" : chunk.title) + suffix,
      status: isRunningTurn ? "in_progress" : chunk.status,
      ...(chunk.details ? { details: chunk === activity ? activityDetails(chunk.details) : richText(chunk.details) } : {}),
    });
  }
  return blocks;
}

function truncatedMarkdown(text: string, limit = MAX_PROGRESS_MARKDOWN) {
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  const marker = "\n\n_Progress update truncated._";
  const contentLimit = limit - Array.from(marker).length;
  return `${splitProgressMarkdown(text, contentLimit)[0] ?? characters.slice(0, contentLimit).join("")}${marker}`;
}

function compactProgressPage(chunks: ProgressChunk[]): ProgressChunk[] {
  const commentary = chunks.filter((chunk): chunk is Extract<ProgressChunk, { type: "markdown_text" }> =>
    chunk.type === "markdown_text" && !chunk.isCompaction);
  const latestCommentary = commentary.at(-1);
  const keptHistory = new Set<ProgressChunk>();
  let historyCharacters = 0;
  for (const chunk of commentary.slice(0, -1).reverse()) {
    const separatorCharacters = keptHistory.size ? 2 : 0;
    const chunkCharacters = Array.from(chunk.text).length;
    if (keptHistory.size >= MAX_PROGRESS_HISTORY_UPDATES
      || historyCharacters + separatorCharacters + chunkCharacters > MAX_PROGRESS_HISTORY_CHARS) break;
    keptHistory.add(chunk);
    historyCharacters += separatorCharacters + chunkCharacters;
  }

  const latestCommentaryIndex = latestCommentary ? chunks.lastIndexOf(latestCommentary) : -1;
  const latestActivityIndex = chunks.findLastIndex(chunk => chunk.type === "task_update" && chunk.id !== "plan-progress");
  const latestActivity = latestActivityIndex > latestCommentaryIndex ? chunks[latestActivityIndex] : undefined;
  const latestPlan = chunks.findLast(chunk => chunk.type === "task_update" && chunk.id === "plan-progress");
  const latestPlanUpdate = chunks.findLast(chunk => chunk.type === "plan_update");
  const latestCompaction = chunks.findLast(chunk => chunk.type === "markdown_text" && chunk.isCompaction);
  const retained = new Set<ProgressChunk>([
    ...chunks.filter(chunk => chunk.type === "steering_boundary"),
    ...keptHistory,
    ...[latestCommentary, latestActivity, latestPlan, latestPlanUpdate, latestCompaction].filter(Boolean) as ProgressChunk[],
  ]);
  const latestText = latestCommentary ? truncatedMarkdown(latestCommentary.text) : null;
  const omitted = chunks.some(chunk => chunk.type === "history_boundary")
    || keptHistory.size < Math.max(0, commentary.length - 1)
    || latestCommentary !== undefined && latestText !== latestCommentary.text;
  const compacted = chunks.flatMap(chunk => {
    if (chunk.type === "history_boundary" || !retained.has(chunk)) return [];
    if (chunk === latestCommentary && latestText !== null) return [{ ...chunk, text: latestText }];
    return [chunk];
  });
  return omitted ? [{ type: "history_boundary" }, ...compacted] : compacted;
}

function replaceChunk(chunks: ProgressChunk[], chunk: ProgressChunk): ProgressChunk[] {
  const next = [...chunks];
  const index = chunk.type === "task_update"
    ? next.findIndex((item) => item.type === "task_update" && item.id === chunk.id)
    : chunk.type === "plan_update" ? next.findIndex((item) => item.type === "plan_update") : -1;
  if (index >= 0) next[index] = { ...next[index], ...chunk } as ProgressChunk;
  else if (chunk.type === "markdown_text" && next.at(-1)?.type === "markdown_text"
    && (next.at(-1) as Extract<ProgressChunk, { type: "markdown_text" }>).commentaryId === chunk.commentaryId) {
    const previous = next.pop() as Extract<ProgressChunk, { type: "markdown_text" }>;
    next.push({ ...chunk, text: previous.text + chunk.text });
  } else next.push(chunk);
  return next;
}

export function closeProgressPage(chunks: ProgressChunk[], continued = false, failed = false): ProgressChunk[] {
  const continuedTitle = (title: string) => {
    const suffix = " · continued below";
    const characters = Array.from(title);
    const budget = MAX_TASK_TITLE_CHARS - suffix.length;
    return (characters.length > budget ? characters.slice(0, budget - 1).join("") + "…" : title) + suffix;
  };
  const visibleChunks = continued
    ? chunks.filter(chunk => chunk.type !== "plan_update" && !(chunk.type === "task_update" && chunk.id === "plan-progress"))
    : chunks;
  return visibleChunks.map((chunk) => chunk.type === "task_update" && chunk.status === "in_progress"
    ? { ...chunk, status: failed ? "error" : "complete", ...(continued ? { title: continuedTitle(chunk.title) } : {}) }
    : chunk);
}

function carriedTasks(chunks: ProgressChunk[]): ProgressChunk[] {
  return chunks.filter((chunk) => chunk.type === "plan_update" || chunk.type === "steering_boundary"
    || chunk.type === "task_update" && (chunk.id === "plan-progress" || chunk.status === "in_progress"));
}

export function paginateProgress(current: ProgressChunk[], additions: ProgressChunk[], terminal = false): ProgressChunk[][] {
  const pages: ProgressChunk[][] = [];
  let page = compactProgressPage(current);
  const normalized: ProgressChunk[] = [];
  for (const chunk of additions) {
    const prior = normalized.at(-1);
    if (chunk.type === "markdown_text" && prior?.type === "markdown_text" && prior.commentaryId === chunk.commentaryId) prior.text += chunk.text;
    else normalized.push({ ...chunk });
  }
  for (const chunk of normalized) {
    if (chunk.type === "steering_boundary") {
      if (page.some(c => c.type === "steering_boundary" && c.id === chunk.id)) continue;
      if (progressBlocks(page).length) pages.push(closeProgressPage(page, true));
      page = compactProgressPage([
        ...carriedTasks(page).filter(c => c.type !== "steering_boundary" && (c.type !== "task_update" || c.id === "plan-progress")),
        chunk,
      ]);
      continue;
    }
    page = compactProgressPage(replaceChunk(page, chunk));
  }
  pages.push(terminal ? closeProgressPage(page, false, additions.some((c) => c.type === "task_update" && c.status === "error")) : page);
  return pages;
}

// Slack validates the *translated* Markdown block count. A definitive size
// rejection is safe to shrink and retry at the same identity; transport failures
// must never take this path.
export function shrinkRejectedProgressPage(chunks: ProgressChunk[]): ProgressChunk[] {
  const latestCommentary = chunks.findLast((chunk): chunk is Extract<ProgressChunk, { type: "markdown_text" }> =>
    chunk.type === "markdown_text" && !chunk.isCompaction);
  if (latestCommentary && Array.from(latestCommentary.text).length > 128) {
    const smallerText = truncatedMarkdown(latestCommentary.text, Math.ceil(Array.from(latestCommentary.text).length / 2));
    return compactProgressPage(chunks.map(chunk => chunk === latestCommentary ? { ...chunk, text: smallerText } : chunk));
  }
  const history = chunks.filter(chunk => chunk.type === "markdown_text" && !chunk.isCompaction && chunk !== latestCommentary);
  if (history.length) {
    const discarded = new Set(history.slice(0, Math.ceil(history.length / 2)));
    return compactProgressPage([{ type: "history_boundary" }, ...chunks.filter(chunk => !discarded.has(chunk))]);
  }
  const detailedTask = chunks.find(chunk => chunk.type === "task_update" && chunk.details);
  if (detailedTask?.type === "task_update") {
    return compactProgressPage(chunks.map(chunk => chunk === detailedTask ? { ...chunk, details: undefined } : chunk));
  }
  throw new Error("Slack rejected an indivisible progress block.");
}
