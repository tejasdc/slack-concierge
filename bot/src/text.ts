const DEFAULT_SLACK_TEXT_LIMIT = 3800;
const DEFAULT_TLDR_LIMIT = 180;
const STATUS_TLDR_LIMIT = 220;

export function formatDuration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export function splitSlackText(text: string, limit = DEFAULT_SLACK_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let idx = rest.lastIndexOf("\n\n", limit);
    if (idx < Math.floor(limit * 0.5)) idx = rest.lastIndexOf("\n", limit);
    if (idx < Math.floor(limit * 0.5)) idx = rest.lastIndexOf(" ", limit);
    if (idx < Math.floor(limit * 0.5)) idx = limit;
    chunks.push(rest.slice(0, idx).trimEnd());
    rest = rest.slice(idx).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function normalizeTldrContent(text: string) {
  return text.replace(/^TL;?DR:\s*/i, "").trim();
}

function truncateForTldr(text: string, limit = DEFAULT_TLDR_LIMIT) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  const boundary = compact.lastIndexOf(" ", limit - 1);
  const idx = boundary > Math.floor(limit * 0.6) ? boundary : limit - 1;
  return `${compact.slice(0, idx).trimEnd()}...`;
}

function fallbackTldrFromText(text: string) {
  const line = text
    .split("\n")
    .map((item) => item.trim())
    .find((item) =>
      item &&
      !item.startsWith("```")
    );
  if (!line) return "No output.";
  return truncateForTldr(line.replace(/^#+\s*/, "").replace(/^[-*]\s+/, ""));
}

export function extractTldr(text: string): string | null {
  const firstLine = text.split("\n").find((line) => line.trim());
  const match = firstLine?.trim().match(/^TL;?DR:\s*(.*)$/i);
  if (!match) return null;
  return normalizeTldrContent(match[0]) || null;
}

export function extractLastTldr(text: string): string | null {
  const matches = [...text.matchAll(/^[ \t]*TL;?DR:[ \t]*(.*)$/gim)];
  const last = matches.at(-1)?.[1];
  return last ? last.trim() || null : null;
}

export function ensureTldr(text: string) {
  const body = text.trim() || "(no output)";
  const firstLine = body.split("\n").find((line) => line.trim())?.trim() || "";
  if (/^TL;?DR:/i.test(firstLine)) {
    const content = normalizeTldrContent(firstLine) || "No output.";
    return body.replace(firstLine, `TL;DR: ${content}`);
  }
  return `TL;DR: ${fallbackTldrFromText(body)}\n\n${body}`;
}

export function formatTurnStatusMessage(input: {
  state: "working" | "done" | "error" | "interrupted";
  elapsedMs?: number;
  lastUpdateAgeMs?: number;
  toolCount?: number;
  provider?: string;
  tldr?: string;
  detail?: string;
}) {
  const toolCount = input.toolCount ?? 0;
  const elapsed = formatDuration(input.elapsedMs ?? 0);
  const lastUpdate = formatDuration(input.lastUpdateAgeMs ?? 0);
  const details = input.detail || defaultStatusDetail(input.state, {
    elapsed,
    lastUpdate,
    toolCount,
    provider: input.provider,
  });
  if (!input.tldr) return details;

  const tldr = punctuateTldr(truncateForTldr(normalizeTldrContent(input.tldr), STATUS_TLDR_LIMIT));
  return [`TL;DR: ${tldr}`, "", details].join("\n");
}

function punctuateTldr(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "No output.";
  if (/[.!?]$/.test(trimmed) || trimmed.endsWith("...")) return trimmed;
  return `${trimmed}.`;
}

function defaultStatusDetail(input: "working" | "done" | "error" | "interrupted", data: {
  elapsed: string;
  lastUpdate: string;
  toolCount: number;
  provider?: string;
}) {
  if (input === "working") {
    return `Status: working - ${data.elapsed} elapsed, last update ${data.lastUpdate} ago, ${data.toolCount} tool ${data.toolCount === 1 ? "call" : "calls"}`;
  }
  if (input === "done") {
    const provider = data.provider ? `, provider ${data.provider}` : "";
    return `Status: done - ${data.elapsed} elapsed, ${data.toolCount} tool ${data.toolCount === 1 ? "call" : "calls"}${provider}`;
  }
  if (input === "interrupted") return "Status: interrupted";
  return "Status: error";
}
