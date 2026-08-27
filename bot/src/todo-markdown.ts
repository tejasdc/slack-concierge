export function normalizeTodoBody(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n[\t ]*\n+/)
    .map((paragraph) => paragraph.replace(/[\t ]*\n[\t ]*/g, " ").replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

export function todoBodyParagraphs(value: string) {
  const normalized = normalizeTodoBody(value);
  return normalized ? normalized.split("\n\n") : [];
}

function beginsWithUnownedMarkdown(value: string) {
  return /^(?:[-+*]|\d+[.)])\s/.test(value)
    || /^(?:>|`{3,}|~{3,}|<!--|%%)/.test(value);
}

export function todoContinuationContent(line: string) {
  const match = line.match(/^(?: {2}| {4})(\S.*)$/);
  if (!match) return null;
  const content = match[1];
  if (content.startsWith("\\")) {
    const unescaped = content.slice(1);
    if (unescaped.startsWith("\\") || beginsWithUnownedMarkdown(unescaped)) return unescaped;
  }
  if (beginsWithUnownedMarkdown(content)) return null;
  return content;
}

export interface TodoSlackOrigin {
  channel: string;
  ts: string;
}

const TODO_SLACK_ORIGIN_TOKEN = /^concierge-slack-origin-v1:([A-Z0-9]+):(\d+\.\d{6})$/;

export function todoSlackOriginToken(origin: TodoSlackOrigin) {
  if (!/^[A-Z0-9]+$/.test(origin.channel) || !/^\d+\.\d{6}$/.test(origin.ts)) {
    throw new Error("A TODO Slack origin needs an exact channel ID and message timestamp.");
  }
  return `concierge-slack-origin-v1:${origin.channel}:${origin.ts}`;
}

export function parseTodoSlackOriginToken(token: string): TodoSlackOrigin | null {
  const match = token.match(TODO_SLACK_ORIGIN_TOKEN);
  return match ? { channel: match[1], ts: match[2] } : null;
}

function renderTodoContinuation(paragraph: string) {
  const escaped = paragraph.startsWith("\\") || beginsWithUnownedMarkdown(paragraph)
    ? `\\${paragraph}`
    : paragraph;
  return `    ${escaped}`;
}

export function parseTodoMetadata(line: string) {
  const match = line.match(/^ {4}%%\s*concierge-todo-metadata-v1(?:\s+(.+?))?\s*%%\s*$/);
  if (!match) return null;
  const tokens = match[1]?.split(/\s+/).filter(Boolean) || [];
  const captureToken = tokens.find((token) => /^concierge-capture-v1:[a-f0-9]{64}$/i.test(token));
  const slackOriginTokens = tokens.filter((token) => token.startsWith("concierge-slack-origin-v1:"));
  if (slackOriginTokens.length > 1) throw new Error("TODO metadata contains multiple Slack origins.");
  const slackOrigin = slackOriginTokens[0]
    ? parseTodoSlackOriginToken(slackOriginTokens[0])
    : undefined;
  if (slackOriginTokens[0] && !slackOrigin) throw new Error("TODO metadata contains an invalid Slack origin.");
  const rowId = tokens.find((token) => /^Rec[A-Za-z0-9]+$/.test(token));
  return {
    captureMarker: captureToken ? `<!-- ${captureToken} -->` : undefined,
    slackOrigin,
    rowId,
  };
}

function renderTodoMetadata(
  captureMarker?: string,
  slackOrigin?: TodoSlackOrigin,
  rowId?: string,
) {
  const captureToken = captureMarker?.match(/concierge-capture-v1:[a-f0-9]{64}/i)?.[0];
  const tokens = [captureToken, slackOrigin ? todoSlackOriginToken(slackOrigin) : undefined, rowId]
    .filter(Boolean);
  return tokens.length ? `    %% concierge-todo-metadata-v1 ${tokens.join(" ")} %%` : null;
}

export function renderTodoItemContents(input: {
  title: string;
  completed?: boolean;
  rowId?: string;
  captureMarker?: string;
  slackOrigin?: TodoSlackOrigin;
}) {
  const paragraphs = todoBodyParagraphs(input.title);
  if (!paragraphs.length) throw new Error("A todo needs non-empty text.");
  const lines = [`- [${input.completed ? "x" : " "}] ${paragraphs[0]}`];
  const metadata = renderTodoMetadata(input.captureMarker, input.slackOrigin, input.rowId);
  if (metadata) lines.push(metadata);
  for (const paragraph of paragraphs.slice(1)) lines.push("", renderTodoContinuation(paragraph));
  return lines;
}
