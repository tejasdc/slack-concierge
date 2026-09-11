import { createHash, randomUUID } from "node:crypto";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import type { SandboxEvidenceWriter } from "../support/evidence";

export type ThinkeringRequest = { event_id: string; text: string };
export type ThinkeringReceipt = { http_status: number; accepted?: boolean; event_id?: string;
  duplicate?: boolean; status?: string; destination_kind?: string; terminal_receipt?: string | null; error?: string };
export interface ThinkeringSlackAdapter {
  submitThinkeringCapture(input: ThinkeringRequest, authorized?: boolean): Promise<ThinkeringReceipt>;
  observeThinkeringCapture(eventId: string, text: string, marker: string): Promise<Record<string, unknown>>;
  waitForRunSettled(): Promise<void>;
}

export async function runThinkeringSlackCase(options: {
  lane: LaneFixtureIdentities; runId: string; adapter: ThinkeringSlackAdapter;
  evidence: Pick<SandboxEvidenceWriter, "writeJson">;
}) {
  const marker = `SANDBOX_THINKERING_${randomUUID().replaceAll("-", "")}`;
  const observations: Record<string, unknown>[] = [];
  const requests: ThinkeringRequest[] = [];
  for (const long of [false, true]) {
    const first = `${marker}_${long ? "LONG" : "SHORT"}_START`;
    const last = `${marker}_${long ? "LONG" : "SHORT"}_END`;
    const text = `This is a synthetic acceptance capture. Do not route or start other work. Reply with TL;DR: followed by the START and END markers found in this capture, exactly.\n${first}\n## Literal heading\n---\n**literal emphasis** 😀\n${long ? "Synthetic thought text.\n".repeat(400) : "One thought.\n"}${last}`;
    const request = { event_id: `thinkering-${createHash("sha256").update(text).digest("hex")}`, text };
    const eventId = createHash("sha256").update(`thinkering:v1\0thinkering\0${request.event_id}\0`).digest("hex");
    if ((await options.adapter.submitThinkeringCapture(request, false)).http_status !== 401) throw new Error("Unauthenticated capture accepted");
    const accepted = await options.adapter.submitThinkeringCapture(request);
    if (accepted.http_status !== 202 || accepted.accepted !== true || accepted.event_id !== eventId || accepted.duplicate !== false || accepted.destination_kind !== "slack") throw new Error("Thinkering acceptance did not bind its exact event");
    const duplicate = await options.adapter.submitThinkeringCapture(request);
    if (duplicate.http_status !== 200 || !duplicate.duplicate || duplicate.event_id !== eventId) throw new Error("Retry created another capture");
    if ((await options.adapter.submitThinkeringCapture({ ...request, text: "changed" })).http_status !== 409) throw new Error("Changed content reused a capture identity");
    const observed = await options.adapter.observeThinkeringCapture(eventId, text, first);
    if (!String(observed.response).includes(last)) throw new Error("Provider did not receive the complete snapshot");
    requests.push(request);
    observations.push(observed);
  }
  for (let index = 0; index < requests.length; index++) {
    const receipt = await options.adapter.submitThinkeringCapture(requests[index]!);
    if (receipt.http_status !== 200 || receipt.status !== "delivered" || receipt.terminal_receipt !== observations[index]!.slack_message_ts) throw new Error("Later work changed an earlier terminal receipt");
  }
  await options.adapter.waitForRunSettled();
  const result = { case_id: "thinkering-slack", lane_id: options.lane.lane_id, run_id: options.runId,
    marker, observations, run_owned_unsettled: 0, status: "passed" };
  options.evidence.writeJson("thinkering-slack.json", result);
  return result;
}
