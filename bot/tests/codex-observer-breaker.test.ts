import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createRetryBreaker } from "../src/retry-breaker-core";

// docs/incidents/2026-11-11-codex-observer-false-outage-on-release.md
describe("Codex observer breaker", () => {
  const failure = { kind: "transient" as const, reason: "The Codex App Server did not answer." };

  function observe(breaker: ReturnType<typeof createRetryBreaker>, startMs: number, untilMs: number) {
    let nowMs = startMs;
    let decision = breaker.recordRetryFailure({ key: "codex-session-observer:app-server", site: "codex-observer",
      what: "Codex conversation observation", failure, nowMs });
    while (decision.action === "retry" && decision.atMs <= untilMs) {
      nowMs = decision.atMs;
      decision = breaker.recordRetryFailure({ key: "codex-session-observer:app-server", site: "codex-observer",
        what: "Codex conversation observation", failure, nowMs });
    }
    return decision;
  }

  test("a release's few seconds without the runner relay files no notice", () => {
    const notices: string[] = [];
    const breaker = createRetryBreaker(new Database(":memory:"), input => { notices.push(input.key); return true; });
    // Nov 11 2026: 503s from 04:35:35, Codex ready at 04:35:41. Give it ten seconds.
    const decision = observe(breaker, 1_000_000, 1_000_000 + 10_000);
    expect(decision.action).toBe("retry");
    expect(notices).toEqual([]);
  });

  test("Codex still unreachable after two minutes files one notice", () => {
    const notices: string[] = [];
    const breaker = createRetryBreaker(new Database(":memory:"), input => { notices.push(input.key); return true; });
    const decision = observe(breaker, 1_000_000, 1_000_000 + 10 * 60_000);
    expect(decision.action).toBe("stop");
    expect(notices.length).toBe(1);
  });
});
