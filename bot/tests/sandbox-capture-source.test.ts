import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { singleClickJournalSink } from "../scripts/sandbox-capture-source";

test("sandbox capture follows the configured journal sink and refuses a Slack route", () => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-capture-source-"));
  const path = join(root, "routes.toml");
  try {
    for (const sink of ["journalmaxx-inbox", "thinkering-inbox"]) {
      writeFileSync(path, `[[routes]]\nid = "pebble-index"\n[[routes.trigger_destinations]]\ntrigger = "single-click-hold"\n[routes.trigger_destinations.destination]\ntype = "journal"\nsink = "${sink}"\n`);
      expect(singleClickJournalSink(path)).toBe(sink);
    }
    writeFileSync(path, `[[routes]]\nid = "pebble-index"\n[[routes.trigger_destinations]]\ntrigger = "single-click-hold"\n[routes.trigger_destinations.destination]\ntype = "slack"\nchannel_id = "DTEST"\n`);
    expect(() => singleClickJournalSink(path)).toThrow("one journal sink");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
