#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publishProviderFreeNotice } from "../src/provider-free-notice";

const args = process.argv.slice(2);
let key = "", title = "", textFile = "", text = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--key") key = args[++i] ?? "";
  else if (args[i] === "--title") title = args[++i] ?? "";
  else if (args[i] === "--text-file") textFile = args[++i] ?? "";
  else if (args[i] === "--") { text = args.slice(i + 1).join(" "); break; }
  else throw new Error(`Unknown service-notice option: ${args[i]}`);
}
if (!key || !/^[a-zA-Z0-9:._-]{1,160}$/.test(key) || !title.trim() || (textFile && text) || (!textFile && !text.trim())) {
  throw new Error("Usage: service-notice.ts --key <stable key> --title <short title> [--text-file <path> | -- <text>]");
}
if (textFile) text = readFileSync(textFile, "utf8");
if (!text.trim()) throw new Error("Service notice text is empty.");
const stateDir = process.env.CONCIERGE_STATE_DIR;
if (!stateDir) throw new Error("CONCIERGE_STATE_DIR is required.");
const db = new Database(join(stateDir, "state.db"));
db.exec("PRAGMA busy_timeout=15000");
try {
  const inserted = publishProviderFreeNotice(db, { key, text: `${title.trim()}\n\n${text.trim()}`, kind: "service_failure", payload: { key, title } });
  console.log(inserted ? "recorded" : "duplicate");
} finally { db.close(); }
