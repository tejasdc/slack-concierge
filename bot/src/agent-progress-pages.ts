import { MAX_TASK_TITLE_CHARS, type SlackAgentProgressChunk } from "./agent-progress";
import { splitProgressMarkdown } from "./progress-markdown";
import { formatDuration } from "./text";

export type ProgressChunk = SlackAgentProgressChunk;
export const MAX_PROGRESS_MARKDOWN = 12_000;
export const MAX_PROGRESS_BLOCKS = 50;

function compactProgress(chunks: ProgressChunk[]) {
  const content = chunks.filter(c => c.type === "markdown_text" || c.type === "task_update" && c.id !== "plan-progress");
  const commentary = content.findLast(c => c.type === "markdown_text" && !c.isCompaction);
  const activity = content.findLast(c => c.type === "task_update");
  return {
    content, commentary, activity,
    history: content.filter((c): c is Extract<ProgressChunk, { type: "markdown_text" }> =>
      c.type === "markdown_text" && !c.isCompaction && c !== commentary),
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
  const { commentary, activity: latestActivity, history, plan } = compactProgress(chunks);
  // Long commentary can continue without carrying a completed activity snapshot.
  // A live turn still needs its indicator and clock on that current page.
  const activity = latestActivity ?? (runningSince === undefined ? undefined : {
    type: "task_update" as const, id: "turn-progress", title: "Thinking", status: "in_progress" as const,
  });
  const blocks: Record<string, unknown>[] = [];
  if (commentary?.type === "markdown_text") blocks.push({ type: "markdown", text: commentary.text });
  if (history.length) blocks.push({
    type: "container",
    title: { type: "plain_text", text: "Earlier progress" },
    is_collapsible: true,
    default_collapsed: true,
    child_blocks: [{
      type: "rich_text",
      elements: history.toReversed().map(chunk => ({
        type: "rich_text_section",
        elements: [{ type: "text", text: chunk.text }],
      })),
    }],
  });
  for (const chunk of [activity, plan]) {
    if (chunk?.type !== "task_update") continue;
    const suffix = chunk === activity && runningSince !== undefined
      ? ` · ${formatDuration(now - runningSince * 1000)} elapsed` : "";
    const title = Array.from(chunk.title);
    const titleBudget = MAX_TASK_TITLE_CHARS - suffix.length;
    blocks.push({
      type: "task_card", task_id: chunk.id,
      title: (title.length > titleBudget ? title.slice(0, titleBudget - 1).join("") + "…" : chunk.title) + suffix,
      status: chunk.status,
      ...(chunk.details ? { details: chunk === activity ? activityDetails(chunk.details) : richText(chunk.details) } : {}),
    });
  }
  return blocks;
}

function fits(chunks: ProgressChunk[]) {
  const { content, activity, plan } = compactProgress(chunks);
  // Collapsing history changes visibility, not the amount of retained content.
  const retainedText = content.reduce((n, chunk) => n + Array.from(chunk.type === "markdown_text"
    ? chunk.text : chunk === activity ? "" : chunk.title + (chunk.details ?? "")).length, 0);
  return content.length + (plan ? 1 : 0) <= MAX_PROGRESS_BLOCKS && retainedText <= MAX_PROGRESS_MARKDOWN;
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
  return chunks.map((chunk) => chunk.type === "task_update" && chunk.status === "in_progress"
    ? { ...chunk, status: failed ? "error" : "complete", ...(continued ? { title: continuedTitle(chunk.title) } : {}) }
    : chunk);
}

function carriedTasks(chunks: ProgressChunk[]): ProgressChunk[] {
  return chunks.filter((chunk) => chunk.type === "plan_update" || chunk.type === "steering_boundary"
    || chunk.type === "task_update" && (chunk.id === "plan-progress" || chunk.status === "in_progress"));
}

export function paginateProgress(current: ProgressChunk[], additions: ProgressChunk[], terminal = false): ProgressChunk[][] {
  const pages: ProgressChunk[][] = [];
  let page = current;
  const normalized: ProgressChunk[] = [];
  for (const chunk of additions) {
    const prior = normalized.at(-1);
    if (chunk.type === "markdown_text" && prior?.type === "markdown_text" && prior.commentaryId === chunk.commentaryId) prior.text += chunk.text;
    else normalized.push({ ...chunk });
  }
  for (const chunk of normalized.flatMap((c): ProgressChunk[] => c.type === "markdown_text"
    ? splitProgressMarkdown(c.text, MAX_PROGRESS_MARKDOWN).map((text) => ({ ...c, text })) : [c])) {
    if (chunk.type === "steering_boundary") {
      if (page.some(c => c.type === "steering_boundary" && c.id === chunk.id)) continue;
      if (progressBlocks(page).length) pages.push(closeProgressPage(page, true));
      page = [...carriedTasks(page).filter(c => c.type !== "steering_boundary" && (c.type !== "task_update" || c.id === "plan-progress")), chunk];
      continue;
    }
    const candidate = replaceChunk(page, chunk);
    if (fits(candidate)) { page = candidate; continue; }
    if (chunk.type === "markdown_text" && Array.from(chunk.text).length > MAX_PROGRESS_MARKDOWN) {
      throw new Error("Progress commentary must be split before pagination.");
    }
    pages.push(closeProgressPage(page, true));
    page = replaceChunk(carriedTasks(page), chunk);
    if (!fits(page)) throw new Error("Progress activity exceeds a single Slack payload.");
  }
  pages.push(terminal ? closeProgressPage(page, false, additions.some((c) => c.type === "task_update" && c.status === "error")) : page);
  return pages;
}

// Slack validates the *translated* Markdown block count. A definitive size
// rejection is safe to repartition; transport failures must never take this path.
export function splitRejectedProgressPage(chunks: ProgressChunk[]): ProgressChunk[][] {
  const boundaries = chunks.filter((c) => c.type === "steering_boundary");
  const content = chunks.filter((c) => c.type !== "plan_update" && c.type !== "steering_boundary");
  const textIndex = content.findLastIndex((c) => c.type === "markdown_text" && !c.isCompaction && Array.from(c.text).length > 128);
  if (textIndex >= 0) {
    const commentary = content[textIndex] as Extract<ProgressChunk, { type: "markdown_text" }>;
    const text = commentary.text;
    const parts = splitProgressMarkdown(text, Math.ceil(Array.from(text).length / 2));
    return parts.map((part, index) => {
      const before = index === 0 ? content.slice(0, textIndex) : carriedTasks(content.slice(0, textIndex));
      const page: ProgressChunk[] = [...boundaries, ...before, { ...commentary, text: part }, ...(index === parts.length - 1 ? content.slice(textIndex + 1) : [])];
      return index === parts.length - 1 ? page : closeProgressPage(page, true);
    });
  }
  if (content.length > 1) {
    const midpoint = Math.ceil(content.length / 2);
    const first = content.slice(0, midpoint);
    return [[...boundaries, ...closeProgressPage(first, true)], [...boundaries, ...carriedTasks(first), ...content.slice(midpoint)]];
  }
  throw new Error("Slack rejected an indivisible progress block.");
}
