import { createHmac } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { renderTodoItemContents } from "./todo-markdown";

export function captureMarker(idempotencyKey?: string, idempotencySecret?: string) {
  if (!idempotencyKey) return "";
  if (!idempotencySecret) throw new Error("Inline capture idempotency requires an authentication secret.");
  const signature = createHmac("sha256", idempotencySecret)
    .update(`slack-concierge:capture:v1:${idempotencyKey}`)
    .digest("hex");
  return `<!-- concierge-capture-v1:${signature} -->`;
}

export function appendTodoFile(input: {
  path: string;
  channelName: string;
  text: string;
  idempotencyKey?: string;
  idempotencySecret?: string;
}) {
  mkdirSync(dirname(input.path), { recursive: true });
  if (!existsSync(input.path)) writeFileSync(input.path, `# #${input.channelName} todos\n`);
  const marker = captureMarker(input.idempotencyKey, input.idempotencySecret);
  if (marker && readFileSync(input.path, "utf-8").includes(marker)) return input.path;
  const item = renderTodoItemContents({ title: input.text, captureMarker: marker }).join("\n");
  appendFileSync(input.path, `\n${item}\n`);
  return input.path;
}
