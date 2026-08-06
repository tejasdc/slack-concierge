const DEFAULT_SLACK_TEXT_LIMIT = 3800;

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
