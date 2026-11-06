import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createRetryBreaker } from "../src/retry-breaker-core";

test("a handoff clears an exhausted observer breaker without a stopped notice", () => {
  const db = new Database(":memory:");
  const notices: string[] = [];
  const breaker = createRetryBreaker(db, notice => { notices.push(notice.key); return true; });
  const fail = (nowMs: number) => breaker.recordRetryFailure({ key: "observer", site: "codex-observer",
    what: "Codex observation", failure: { kind: "transient", reason: "relay unavailable" },
    noticeAfterMs: 60_000, nowMs });
  for (const at of [1_000, 1_100, 1_300, 1_700]) expect(fail(at).action).toBe("retry");
  expect(fail(2_500).action).toBe("stop");
  breaker.clearRetryBreaker("observer");
  expect(notices).toEqual([]);
  db.close();
});

test("a sustained observer outage announces once after a restart and clears on recovery", () => {
  const db = new Database(":memory:");
  const notices: string[] = [];
  const cleared: string[] = [];
  const makeBreaker = () => createRetryBreaker(db,
    notice => { notices.push(notice.key); return true; }, key => { cleared.push(key); });
  const fail = (breaker: ReturnType<typeof makeBreaker>, nowMs: number) =>
    breaker.recordRetryFailure({ key: "observer", site: "codex-observer", what: "Codex observation",
      failure: { kind: "transient", reason: "relay unavailable" }, noticeAfterMs: 60_000, nowMs });
  let breaker = makeBreaker();
  for (const at of [1_000, 1_100, 1_300, 1_700, 2_500]) fail(breaker, at);
  breaker = makeBreaker(); // The persisted failure age survives an owner replacement.
  fail(breaker, 60_999);
  expect(notices).toEqual([]);
  fail(breaker, 61_000);
  fail(breaker, 62_000);
  expect(notices).toEqual(["observer:1000"]);
  breaker.clearRetryBreaker("observer");
  expect(cleared).toEqual(["observer"]);
  db.close();
});
