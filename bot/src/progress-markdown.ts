// Each continuation is a separate Markdown document. Reopen fenced code and
// repeat a table's header so native Slack formatting survives message boundaries.
export function splitProgressMarkdown(text: string, limit: number): string[] {
  if (Array.from(text).length <= limit) return [text];
  const parts: string[] = [];
  const characters = Array.from(text);
  let offset = 0;
  let fence: { marker: string; opening: string } | null = null;
  let tableHeader = "";
  let previousLine = "";
  let prefix = "";
  while (offset < characters.length) {
    let count = Math.min(characters.length - offset, limit - Array.from(prefix).length);
    if (count <= 0) throw new Error("Markdown continuation context exceeds Slack's payload limit.");
    for (;;) {
      if (count < characters.length - offset) {
        const newline = characters.slice(offset, offset + count).lastIndexOf("\n");
        if (newline >= count / 2) count = newline + 1;
      }
      const source = characters.slice(offset, offset + count).join("");
      let nextFence = fence;
      let nextHeader = tableHeader;
      let nextPrevious = previousLine;
      const lines = source.split("\n");
      if (source.endsWith("\n")) lines.pop();
      for (const line of lines) {
        const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (marker) {
          if (!nextFence) nextFence = { marker: marker[1]!, opening: line };
          else if (marker[1]![0] === nextFence.marker[0] && marker[1]!.length >= nextFence.marker.length && !marker[2]!.trim()) nextFence = null;
          nextHeader = "";
        } else if (!nextFence) {
          if (!/^(?: {4}|\t)/.test(nextPrevious)
            && !/^(?: {4}|\t)/.test(line)
            && nextPrevious.includes("|")
            && /^\s*\|?\s*:?-+:?\s*\|[\s|:\-]*$/.test(line)) nextHeader = `${nextPrevious}\n${line}\n`;
          else if (line && !line.includes("|")) nextHeader = "";
          else if (!line) nextHeader = "";
        }
        nextPrevious = line;
      }
      const suffix = nextFence ? `${source.endsWith("\n") ? "" : "\n"}${nextFence.marker}` : "";
      const total = Array.from(prefix + source + suffix).length;
      if (total > limit) {
        count -= total - limit;
        if (count <= 0) throw new Error("Markdown block cannot fit in a Slack message.");
        continue;
      }
      parts.push(prefix + source + suffix);
      offset += count;
      fence = nextFence;
      tableHeader = nextHeader;
      previousLine = nextPrevious;
      const nextLine = characters.slice(offset, offset + limit).join("").split("\n", 1)[0]!;
      prefix = fence ? `${fence.opening}\n` : tableHeader && nextLine.includes("|") ? tableHeader : "";
      break;
    }
  }
  return parts;
}
