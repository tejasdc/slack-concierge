import { createHash, randomUUID } from "node:crypto";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import type { SandboxEvidenceWriter } from "../support/evidence";
import type { PebbleCaptureRequest, PebbleCaptureReceipt } from "./pebble-trigger-routing.case";

export type JournalCaptureObservation = {
  event_id: string; sink: string; capture_rows: number; journal_file: string;
  journal_sha256: string; journal_inode: number; journal_mtime_ms: number;
  slack_messages: number; input_claims: number; turns: number; run_owned_unsettled: number;
};
export interface ThinkeringCaptureAdapter {
  submitPebbleCapture(input: PebbleCaptureRequest): Promise<PebbleCaptureReceipt>;
  waitForJournalCapture(receipt: PebbleCaptureReceipt): Promise<JournalCaptureObservation>;
}

export async function runThinkeringCaptureCase(options: {
  lane: LaneFixtureIdentities; runId: string; adapter: ThinkeringCaptureAdapter;
  evidence: Pick<SandboxEvidenceWriter, "writeJson">;
}) {
  const request: PebbleCaptureRequest = {
    transcription: `SANDBOX_THINKERING_${randomUUID()} preserve this thought without a Slack or provider effect`,
    recorded_at_ms: Date.now(), client: `sandbox-${options.runId}`, trigger: "single-click-hold",
  };
  const digest = createHash("sha256");
  for (const part of ["pebble-index:v1", "pebble-index", String(request.recorded_at_ms), request.client, request.transcription]) digest.update(part).update("\0");
  const eventId = digest.digest("hex");
  const first = await options.adapter.submitPebbleCapture(request);
  if (first.http_status !== 202 || first.duplicate !== false || first.event_id !== eventId
    || first.destination_kind !== "journal" || first.source_trigger !== request.trigger || first.error) throw new Error("Single-click journal acceptance failed.");
  const before = await options.adapter.waitForJournalCapture(first);
  const duplicate = await options.adapter.submitPebbleCapture(request);
  if (duplicate.http_status !== 200 || duplicate.duplicate !== true || duplicate.event_id !== eventId
    || duplicate.destination_kind !== "journal" || duplicate.error) throw new Error("Journal retry did not retain canonical identity.");
  const after = await options.adapter.waitForJournalCapture(duplicate);
  for (const value of [before, after]) {
    if (value.event_id !== eventId || value.sink !== "thinkering-inbox" || value.capture_rows !== 1
      || value.journal_file !== `pebble-${eventId}.md` || !/^[a-f0-9]{64}$/.test(value.journal_sha256)
      || value.slack_messages !== 0 || value.input_claims !== 0 || value.turns !== 0 || value.run_owned_unsettled !== 0) throw new Error("Thinkering capture produced an unexpected destination or effect.");
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Duplicate capture rewrote its immutable journal or effects.");
  const result = { case_id: "thinkering-capture", lane_id: options.lane.lane_id,
    run_id: options.runId, event_id: eventId, receipts: { first, duplicate }, observation: after,
    status: "passed" };
  options.evidence.writeJson("thinkering-capture.json", result);
  return result;
}
