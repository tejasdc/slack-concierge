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
    || /^(?:>|`{3,}|~{3,}|<!--)/.test(value);
}

export function todoContinuationContent(line: string) {
  const match = line.match(/^ {2}(\S.*)$/);
  if (!match) return null;
  const content = match[1];
  if (content.startsWith("\\")) {
    const unescaped = content.slice(1);
    if (unescaped.startsWith("\\") || beginsWithUnownedMarkdown(unescaped)) return unescaped;
  }
  if (beginsWithUnownedMarkdown(content)) return null;
  return content;
}

function renderTodoContinuation(paragraph: string) {
  const escaped = paragraph.startsWith("\\") || beginsWithUnownedMarkdown(paragraph)
    ? `\\${paragraph}`
    : paragraph;
  return `  ${escaped}`;
}

export function renderTodoItemContents(input: {
  title: string;
  completed?: boolean;
  rowId?: string;
  captureMarker?: string;
}) {
  const paragraphs = todoBodyParagraphs(input.title);
  if (!paragraphs.length) throw new Error("A todo needs non-empty text.");
  const metadata = [input.captureMarker, input.rowId ? `<!-- ${input.rowId} -->` : ""]
    .filter(Boolean)
    .join(" ");
  const lines = [
    `- [${input.completed ? "x" : " "}] ${paragraphs[0]}${metadata ? ` ${metadata}` : ""}`,
  ];
  for (const paragraph of paragraphs.slice(1)) lines.push("", renderTodoContinuation(paragraph));
  return lines;
}
