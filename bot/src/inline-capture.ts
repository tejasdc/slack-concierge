export type FrictionCategory = "new-interface" | "existing-infrastructure" | "solved";

export const frictionCategoryLabels: Record<FrictionCategory, string> = {
  "new-interface": "new-interface requirement",
  "existing-infrastructure": "existing-infrastructure problem",
  solved: "solved item",
};

export type InlineCapture =
  | { kind: "todo"; text: string }
  | { kind: "note"; text: string }
  | { kind: "friction"; category: FrictionCategory; text: string };

export function parseInlineCapture(text: string): InlineCapture | null {
  const todo = text.match(/^[!/](?:todo)\s+([\s\S]*\S)\s*$/i);
  if (todo) return { kind: "todo", text: todo[1] };

  const note = text.match(/^[!/](?:note)\s+([\s\S]*\S)\s*$/i);
  if (note) return { kind: "note", text: note[1] };

  const friction = text.match(/^!friction\s+(new-interface|existing-infrastructure|solved)\s+([\s\S]*\S)\s*$/i);
  if (!friction) return null;
  return {
    kind: "friction",
    category: friction[1].toLowerCase() as FrictionCategory,
    text: friction[2],
  };
}

export function inlineCaptureInboxText(capture: Extract<InlineCapture, { kind: "note" | "friction" }>): string {
  if (capture.kind === "note") return capture.text;
  return `[friction:${capture.category}] ${capture.text}`;
}

export function inlineCaptureConfirmationText(capture: InlineCapture | null): string {
  if (!capture) return "capture saved";
  if (capture.kind === "todo") return "todo captured";
  if (capture.kind === "note") return "note captured";
  return `${frictionCategoryLabels[capture.category]} captured`;
}
