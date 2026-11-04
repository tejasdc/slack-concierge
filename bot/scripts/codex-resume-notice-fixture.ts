// Fault injection: a shared Codex App Server that keeps its connection open but never answers a
// turn's thread/resume. The turn must keep waiting, raise one repair notice past the notice bound,
// and resolve that notice when the answer finally arrives. Runs against a scratch state directory
// and an in-memory ledger; it never touches the live ledger or the real App Server.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const scratch = mkdtempSync(join(tmpdir(), "concierge-resume-notice-"));
process.env.CONCIERGE_STATE_DIR = scratch;
const { runCodexTurn } = await import("../src/codex");
const { noticeCodexResumeWait } = await import("../src/codex-resume-health");
const { pendingRepairNotices } = await import("../src/repair-notices");

const ledger = new Database(":memory:");
let answerResume!: () => void;
const notifications = new Set<(event: any) => void>();
const requests: string[] = [];
const client = {
  async connect() { return 1; },
  async request(method: string, params: any) {
    requests.push(method);
    if (method === "config/read") return { config: {} };
    if (method === "thread/resume") {
      // The injected fault: no answer until the fixture releases it.
      await new Promise<void>(resolve => { answerResume = resolve; });
      return { thread: { id: params.threadId }, model: "gpt-fixture" };
    }
    if (method === "turn/start") {
      queueMicrotask(() => { for (const listener of notifications) listener({ method: "turn/completed", params: {
        threadId: params.threadId, turn: { id: "fixture-turn", status: "completed", items: [] } } }); });
      return { turn: { id: "fixture-turn" } };
    }
    if (method === "thread/read") return { thread: { turns: [] } };
    throw new Error(`unexpected method ${method}`);
  },
  async notify() {},
  onNotification(listener: (event: any) => void) { notifications.add(listener); return () => notifications.delete(listener); },
  onDisconnect() { return () => true; },
  waitForDisconnect() { return new Promise<void>(() => {}); },
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
try {
  let settled = false;
  const running = runCodexTurn({ prompt: "fixture", cwd: scratch, additionalDirs: [], sessionUUID: "fixture-thread",
    appServerClient: client as any, requestTimeoutMs: 50, resumeNoticeAfterMs: 300,
    clientUserMessageId: "slack-concierge:turn:9001:attempt:1",
    onResumeUnanswered: wait => noticeCodexResumeWait(ledger, { sessionId: 42, turnId: 9001 }, wait),
  }).finally(() => { settled = true; });

  await sleep(150);
  assert.deepEqual(pendingRepairNotices(ledger), [], "no notice before the bound");
  await sleep(400);
  const raised = pendingRepairNotices(ledger);
  assert.equal(raised.length, 1, "one repair notice past the bound");
  assert.equal(raised[0]!.kind, "stuck_work");
  assert.match(raised[0]!.text, /session 42's turn 9001 has waited .* still waiting/);
  assert.equal(settled, false, "the turn keeps waiting after the notice");
  assert.equal(requests.filter(method => method === "thread/resume").length, 1, "the resume is never re-sent");
  await sleep(400);
  assert.equal(pendingRepairNotices(ledger).length, 1, "the notice is raised once per wait");

  answerResume();
  const result = await running;
  assert.equal(result.sessionUUID ?? "fixture-thread", "fixture-thread");
  assert.ok(requests.includes("turn/start"), "the turn starts once the resume answers");
  const row = ledger.query("SELECT resolved_at_ms FROM repair_notices").get() as { resolved_at_ms: number | null };
  assert.notEqual(row.resolved_at_ms, null, "the answer resolves the notice");
  assert.deepEqual(pendingRepairNotices(ledger), [], "nothing left for the repair agent");
  console.log("codex resume notice fixture: notice raised past the bound, turn kept waiting, answer resolved it");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(0);
