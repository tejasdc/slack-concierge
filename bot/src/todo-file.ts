import { createHmac } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { renderTodoItemContents, type TodoSlackOrigin } from "./todo-markdown";

export function captureMarker(idempotencyKey?: string, idempotencySecret?: string) {
  if (!idempotencyKey) return "";
  if (!idempotencySecret) throw new Error("Inline capture idempotency requires an authentication secret.");
  const signature = createHmac("sha256", idempotencySecret)
    .update(`slack-concierge:capture:v1:${idempotencyKey}`)
    .digest("hex");
  return `<!-- concierge-capture-v1:${signature} -->`;
}

export function appendTodoFile(database: Database, input: {
  path: string;
  channelName: string;
  text: string;
  idempotencyKey?: string;
  idempotencySecret?: string;
  slackOrigin?: TodoSlackOrigin;
}) {
  const appendOnce = database.transaction(() => {
    mkdirSync(dirname(input.path), { recursive: true });
    if (!existsSync(input.path)) {
      try {
        writeFileSync(input.path, `# #${input.channelName} todos\n`, { flag: "wx" });
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
      }
    }
    const marker = captureMarker(input.idempotencyKey, input.idempotencySecret);
    const markerToken = marker.match(/concierge-capture-v1:[a-f0-9]{64}/i)?.[0];
    if (markerToken && readFileSync(input.path, "utf-8").includes(markerToken)) return input.path;
    const item = renderTodoItemContents({
      title: input.text,
      captureMarker: marker,
      slackOrigin: input.slackOrigin,
    }).join("\n");
    appendFileSync(input.path, `\n${item}\n`);
    return input.path;
  });
  return appendOnce.immediate();
}
