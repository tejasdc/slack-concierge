import { MAX_TASK_TITLE_CHARS, type SlackAgentProgressChunk } from "./agent-progress";
import { splitProgressMarkdown } from "./progress-markdown";

export type ProgressChunk = SlackAgentProgressChunk;
export const MAX_PROGRESS_MARKDOWN = 12_000;
export const MAX_PROGRESS_BLOCKS = 50;

export function progressBlocks(chunks: ProgressChunk[]): Record<string, unknown>[] {
  return chunks.flatMap((chunk): Record<string, unknown>[] => {
    if (chunk.type === "plan_update") return [];
    if (chunk.type === "markdown_text") return [{ type: "markdown", text: chunk.text }];
    return [{
      type: "task_card", task_id: chunk.id, title: chunk.title, status: chunk.status,
      ...(chunk.details ? { details: { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: chunk.details }] }] } } : {}),
    }];
  });
}

function fits(chunks: ProgressChunk[]) {
  return progressBlocks(chunks).length <= MAX_PROGRESS_BLOCKS
    && chunks.reduce((n, chunk) => n + (chunk.type === "markdown_text" ? Array.from(chunk.text).length : 0), 0) <= MAX_PROGRESS_MARKDOWN;
}

function replaceChunk(chunks: ProgressChunk[], chunk: ProgressChunk): ProgressChunk[] {
  const next = [...chunks];
  const index = chunk.type === "task_update"
    ? next.findIndex((item) => item.type === "task_update" && item.id === chunk.id)
    : chunk.type === "plan_update" ? next.findIndex((item) => item.type === "plan_update") : -1;
  if (index >= 0) next[index] = chunk;
  else if (chunk.type === "markdown_text" && next.at(-1)?.type === "markdown_text") {
    const previous = next.pop() as Extract<ProgressChunk, { type: "markdown_text" }>;
    next.push({ type: "markdown_text", text: previous.text + chunk.text });
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
  return chunks.filter((chunk) => chunk.type === "plan_update"
    || chunk.type === "task_update" && (chunk.id === "plan-progress" || chunk.status === "in_progress"));
}

export function paginateProgress(current: ProgressChunk[], additions: ProgressChunk[], terminal = false): ProgressChunk[][] {
  const pages: ProgressChunk[][] = [];
  let page = current;
  const normalized: ProgressChunk[] = [];
  for (const chunk of additions) {
    const prior = normalized.at(-1);
    if (chunk.type === "markdown_text" && prior?.type === "markdown_text") prior.text += chunk.text;
    else normalized.push({ ...chunk });
  }
  for (const chunk of normalized.flatMap((c): ProgressChunk[] => c.type === "markdown_text"
    ? splitProgressMarkdown(c.text, MAX_PROGRESS_MARKDOWN).map((text) => ({ type: "markdown_text", text })) : [c])) {
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
  const content = chunks.filter((c) => c.type !== "plan_update");
  const textIndex = content.findIndex((c) => c.type === "markdown_text" && Array.from(c.text).length > 128);
  if (textIndex >= 0) {
    const text = (content[textIndex] as Extract<ProgressChunk, { type: "markdown_text" }>).text;
    const parts = splitProgressMarkdown(text, Math.ceil(Array.from(text).length / 2));
    return parts.map((part, index) => {
      const before = index === 0 ? content.slice(0, textIndex) : carriedTasks(content.slice(0, textIndex));
      const page: ProgressChunk[] = [...before, { type: "markdown_text", text: part }, ...(index === parts.length - 1 ? content.slice(textIndex + 1) : [])];
      return index === parts.length - 1 ? page : closeProgressPage(page, true);
    });
  }
  if (content.length > 1) {
    const midpoint = Math.ceil(content.length / 2);
    const first = content.slice(0, midpoint);
    return [closeProgressPage(first, true), [...carriedTasks(first), ...content.slice(midpoint)]];
  }
  throw new Error("Slack rejected an indivisible progress block.");
}
