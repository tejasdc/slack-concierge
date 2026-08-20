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

export function todoContinuationContent(line: string) {
  const match = line.match(/^ {2}(\S.*)$/);
  if (!match) return null;
  if (/^(?:[-+*]|\d+[.)])\s/.test(match[1])) return null;
  if (/^(?:>|`{3,}|~{3,}|<!--)/.test(match[1])) return null;
  return match[1];
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
  for (const paragraph of paragraphs.slice(1)) lines.push("", `  ${paragraph}`);
  return lines;
}
