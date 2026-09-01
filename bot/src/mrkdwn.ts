// Markdown → Slack mrkdwn converter.
//
// Slack does NOT render standard markdown. It renders "mrkdwn":
//   bold   *text*            (single asterisks — ** renders literally)
//   italic _text_
//   strike ~text~
//   code   `text` / ```block```
//   link   <https://url|label>   ([label](url) renders as raw brackets)
//   headers NOT SUPPORTED    (## Heading renders literally)
//   tables  NOT SUPPORTED
//   rules   NOT SUPPORTED    (--- renders literally)
//
// Every top-level `text` argument on an outbound `chat.postMessage` runs through
// this converter (wired in `rate-limit.ts` at the single `slackCall` chokepoint).
// Final agent replies carry native Markdown blocks around explicit wrapped table
// blocks; this converted text remains their notification and accessibility fallback.
//
// Code fences and inline code spans are preserved verbatim.
// Ported from noos/src/slack/services/mrkdwn.ts (2026-08-07).

export function toMrkdwn(text: string): string {
  if (!text) return text;
  const segments = text.split(/(```[\s\S]*?(?:```|$))/);
  return segments
    .map((segment, i) => (i % 2 === 1 ? segment : convertOutsideFences(segment)))
    .join("");
}

function convertOutsideFences(segment: string): string {
  return segment
    .split("\n")
    .map(convertLine)
    .filter((line): line is string => line !== null)
    .join("\n");
}

function convertLine(line: string): string | null {
  // Horizontal rules render as literal --- / *** / ___. Drop them.
  if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) return null;

  // "## Title" → "*Title*". Convert inline syntax inside first so
  // "## **Title**" becomes "*Title*", not "***Title***".
  const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
  if (headerMatch) {
    const inner = convertInline(headerMatch[2]!).trim();
    const alreadyBold = /^\*[^*]+\*$/.test(inner);
    return alreadyBold ? inner : `*${inner}*`;
  }

  // Markdown bullets "* item" / "+ item" → "• item" ("- item" is fine).
  const bulletMatch = line.match(/^(\s*)[*+]\s+(.*)$/);
  if (bulletMatch) {
    return `${bulletMatch[1]}• ${convertInline(bulletMatch[2]!)}`;
  }

  return convertInline(line);
}

function convertInline(line: string): string {
  return line
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : convertInlineText(part)))
    .join("");
}

function convertInlineText(text: string): string {
  return (
    text
      .replace(/\*\*([^*]+)\*\*/g, "*$1*")
      .replace(/__([^_]+)__/g, "*$1*")
      .replace(/!?\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
  );
}
