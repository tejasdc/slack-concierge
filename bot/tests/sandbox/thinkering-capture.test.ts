import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { runThinkeringCaptureCase, type ThinkeringCaptureAdapter, type JournalCaptureObservation } from "./cases/thinkering-capture.case";
import type { PebbleCaptureRequest } from "./cases/pebble-trigger-routing.case";
import type { LaneFixtureIdentities } from "../../scripts/sandbox-provision";

const lane = { lane_id: "lane-1" } as LaneFixtureIdentities;
function fixture(change: Partial<JournalCaptureObservation> = {}, rewrite = false) {
  const requests: PebbleCaptureRequest[] = [];
  let observed = 0;
  const adapter: ThinkeringCaptureAdapter = {
    async submitPebbleCapture(input) {
      const hash = createHash("sha256");
      for (const part of ["pebble-index:v1", "pebble-index", String(input.recorded_at_ms), input.client, input.transcription]) hash.update(part).update("\0");
      requests.push(input);
      return { ...input, event_id: hash.digest("hex"), http_status: requests.length === 1 ? 202 : 200,
        duplicate: requests.length !== 1, destination_kind: "journal", source_trigger: input.trigger!,
        source_webhook_version: "1", status: "delivered", terminal_receipt: null, error: null };
    },
    async waitForJournalCapture(receipt) {
      observed++;
      return { event_id: receipt.event_id!, sink: "thinkering-inbox", capture_rows: 1,
        journal_file: `pebble-${receipt.event_id}.md`, journal_sha256: "a".repeat(64),
        journal_inode: 123, journal_mtime_ms: rewrite ? observed : 1,
        slack_messages: 0, input_claims: 0, turns: 0, run_owned_unsettled: 0, ...change };
    },
  };
  return { requests, run: () => runThinkeringCaptureCase({ lane, runId: "owned-run", adapter,
    evidence: { writeJson: () => "controlled-evidence.json" } }) };
}
test("Thinkering sandbox case sends only one single-click capture and its exact retry", async () => {
  const value = fixture();
  expect((await value.run()).status).toBe("passed");
  expect(value.requests).toHaveLength(2);
  expect(value.requests[0]).toEqual(value.requests[1]);
  expect(value.requests.every(request => request.trigger === "single-click-hold")).toBe(true);
});
test("Thinkering sandbox case refuses the old sink, Slack effects and rewritten journal", async () => {
  await expect(fixture({ sink: "journalmaxx-inbox" }).run()).rejects.toThrow("unexpected destination");
  await expect(fixture({ slack_messages: 1 }).run()).rejects.toThrow("unexpected destination");
  await expect(fixture({}, true).run()).rejects.toThrow("rewrote its immutable journal");
});
