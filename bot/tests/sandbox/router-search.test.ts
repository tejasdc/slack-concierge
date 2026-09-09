import { expect, test } from "bun:test";
import { assertRouterSearchRouting, routerSearchResponseTarget } from "./cases/router-search.case";
import { prepareProviderInput } from "../../src/provider-input";

const prior = { turn_id: 1, channel_id: "CTARGET", root_ts: "1.000001", message_ts: "1.000001", user_text: "hair loss" } as any;
const resumed = { turn_id: 2, channel_id: "CTARGET", root_ts: "1.000001", message_ts: "2.000002", user_text: "resume-marker", status: "done", delivery_status: "delivered" } as any;
const request = { destination: "CTARGET", root: "1.000001", marker: "resume-marker", previousTurnIds: [1] };

test("sandbox oracle requires one exact historical reply and rejects the original misroute", () => {
  expect(() => assertRouterSearchRouting({ ...request, decision: "resume", turns: [prior, resumed] })).not.toThrow();
  expect(() => assertRouterSearchRouting({ ...request, decision: "resume", turns: [prior, { ...resumed, root_ts: resumed.message_ts }] })).toThrow();
  expect(() => assertRouterSearchRouting({ ...request, decision: "resume", turns: [prior, resumed, { ...resumed, turn_id: 3 }] })).toThrow();
});

test("sandbox clarification oracle rejects all destination work", () => {
  expect(() => assertRouterSearchRouting({ ...request, decision: "clarify", turns: [prior] })).not.toThrow();
  expect(() => assertRouterSearchRouting({ ...request, decision: "clarify", turns: [prior, resumed] })).toThrow();
});

test("sandbox screenshots target the delivered response instead of its long input", () => {
  const target = routerSearchResponseTarget({ channel_id: "CTARGET", message_ts: "1.000001", thread_ts: "1.000001",
    permalink: "https://example.slack.com/archives/CTARGET/p1000001", client_message_id: "fixture", delivery: "confirmed" }, "3.000003", "outcome-marker");
  expect(target).toEqual({ channel_id: "CTARGET", message_ts: "3.000003", thread_ts: "1.000001",
    permalink: "https://example.slack.com/archives/CTARGET/p3000003?thread_ts=1.000001&cid=CTARGET", required_text: ["outcome-marker"] });
});

test("actual provider-input preparation supplies the owned search and fail-closed routing contract", async () => {
  const input = await prepareProviderInput({
    prompt: "Continue our hair loss conversation", text: "Continue our hair loss conversation", files: [], botToken: "unused",
    channel: "DROUTER", messageTs: "2.000002", threadTs: "1.000001", user: "UUSER", client: {}, hydrateSlackLinks: false,
    attachmentRoot: "/tmp/concierge-router-search-no-files",
  });
  expect(input.prompt).toContain('"message_ts":"2.000002","thread_ts":"1.000001"');
  expect(input.prompt).toContain("threads search <target-channel> --before-ts <this input's message_ts>");
  expect(input.prompt).toContain("--exclude-root-ts <this input's thread_ts>");
  expect(input.prompt).toContain("Empty, incomplete, failed, ambiguous, or non-resumable retrieval");
  expect(input.prompt).toContain("never fall back to post/new thread");
  expect(input.prompt).toContain("Clearly new work retains route-new behavior and does not need search");
});
