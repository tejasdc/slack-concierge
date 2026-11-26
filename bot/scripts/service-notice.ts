#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerWriteResults } from "../src/ledger-write-results";
import { publishProviderFreeNotice } from "../src/provider-free-notice";
import { recordServiceNoticeResolution } from "../src/service-notice-resolutions";

const args = process.argv.slice(2);
let key = "", title = "", textFile = "", text = "", needsTejas = false, resolve = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--key") key = args[++i] ?? "";
  else if (args[i] === "--title") title = args[++i] ?? "";
  else if (args[i] === "--text-file") textFile = args[++i] ?? "";
  else if (args[i] === "--needs-tejas") needsTejas = true;
  else if (args[i] === "--resolve") resolve = true;
  else if (args[i] === "--") { text = args.slice(i + 1).join(" "); break; }
  else throw new Error(`Unknown service-notice option: ${args[i]}`);
}
const usage = "Usage: service-notice.ts [--needs-tejas] --key <stable key> --title <short title> [--text-file <path> | -- <text>]\n"
  + "       service-notice.ts --resolve --key <same key> (--text-file <path> | -- <what is fixed now, naming it>)\n"
  + "Without --needs-tejas the notice goes to the repair agent first. With it, it is Tejas's own Inbox thread and rings once:\n"
  + "use it only for what he alone can do (sign in again, approve on his device). Use one key per episode and resolve it when fixed.\n"
  + "The title and text are read by Tejas in his Inbox: write moments in his time (\"September 24 at 11:03 PM ET\"), name no file paths, and say what he can do about it.";
if (!key || !/^[a-zA-Z0-9:._-]{1,160}$/.test(key) || (textFile && text) || (resolve && (needsTejas || title))
  || (!resolve && !title.trim()) || (!textFile && !text.trim())) throw new Error(usage);
if (textFile) text = readFileSync(textFile, "utf8");
if (!text.trim()) throw new Error("Service notice text is empty.");
const stateDir = process.env.CONCIERGE_STATE_DIR;
if (!stateDir) throw new Error("CONCIERGE_STATE_DIR is required.");
const db = ledgerWriteResults(new Database(join(stateDir, "state.db")));
db.exec("PRAGMA busy_timeout=15000");
try {
  if (resolve) {
    // Only a notice that exists can be resolved; a sync that resolves on every healthy run is harmless.
    const exists = db.query("SELECT 1 FROM session_inputs WHERE id=?").get(`service:service-notice:${key}`);
    if (!exists) console.log("no-notice");
    else console.log(recordServiceNoticeResolution(db, { key, text: text.trim() }) ? "resolve-recorded" : "duplicate");
  } else {
    const inserted = publishProviderFreeNotice(db, { key, text: `${title.trim()}\n\n${text.trim()}`,
      kind: needsTejas ? "host_needs_tejas" : "service_failure", payload: { key, title }, needsHim: needsTejas });
    console.log(inserted ? "recorded" : "duplicate");
  }
} finally { db.close(); }
