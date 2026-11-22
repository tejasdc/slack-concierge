/**
 * Falsifying checks for the account state actor (see docs/plans/2026-11-22-account-state-actor.md).
 *
 * These tests pin the invariants that would have prevented the 2026-11-21 Codex-switch
 * failure and the class of write-side-race failures the actor is responsible for.
 *
 *  I1 — operator switch is authoritative over a stale probe observation for OPERATOR_PRECEDENCE_MS.
 *  I2 — the switch writes through to the runner-identity map synchronously, so `currentAccount`
 *       reads the new identity before any probe runs.
 *  I3 — a probe observation that agrees with the operator is a no-op (no spurious revision).
 *  I4 — probe observations are free to update the selection when no recent operator switch exists.
 *  I5 — selections are durable: a fresh actor instance reads the last committed revision from SQLite.
 *  I6 — concurrent operator switches serialize deterministically through the write chain.
 *  I7 — subscribers see every revision in order; a slow subscriber does not block the write.
 *  I8 — after OPERATOR_PRECEDENCE_MS elapses, a probe observation wins again (control returns to probe).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { accountStateActor, OPERATOR_PRECEDENCE_MS, type ActorEvent } from "../src/account-state-actor";
import { currentAccount, setRunnerAccountInUse } from "../src/provider-accounts";
import { db } from "../src/state";

beforeEach(() => {
  (accountStateActor as any).__resetForTests();
  // Reset the runner-identity map the actor writes into.
  setRunnerAccountInUse("codex", null);
  setRunnerAccountInUse("claude-code", null);
  accountStateActor.init();
});

afterEach(() => {
  (accountStateActor as any).__resetForTests();
  setRunnerAccountInUse("codex", null);
  setRunnerAccountInUse("claude-code", null);
});

describe("account state actor", () => {
  test("I1: an operator switch suppresses a stale probe observation within the precedence window", async () => {
    await accountStateActor.operatorSwitched("codex", { id: "acct-new", label: "tejas@chann.app" });
    // Stale probe comes back reporting the OLD account.
    await accountStateActor.probeObserved("codex", { id: "acct-old", label: "tejastej.dc@gmail.com" });
    const snap = accountStateActor.snapshot("codex");
    expect(snap?.account?.label).toBe("tejas@chann.app");
    expect(snap?.source).toBe("operator");
    // currentAccount reads from the runner-identity map the actor wrote.
    expect(currentAccount("codex")?.label).toBe("tejas@chann.app");
  });

  test("I2: operator switch writes through to the runner-identity map synchronously", async () => {
    expect(currentAccount("codex")).toBeNull();
    await accountStateActor.operatorSwitched("codex", { id: "acct-x", label: "x@example.com" });
    expect(currentAccount("codex")?.label).toBe("x@example.com");
    expect(currentAccount("codex")?.id).toBe("acct-x");
  });

  test("I3: probe observation agreeing with operator is a no-op — revision stays, source stays 'operator'", async () => {
    await accountStateActor.operatorSwitched("codex", { id: "acct-x", label: "x@example.com" });
    const before = accountStateActor.snapshot("codex")!;
    // Probe happens to see the same account.
    await accountStateActor.probeObserved("codex", { id: "acct-x", label: "x@example.com" });
    const after = accountStateActor.snapshot("codex")!;
    // The actor does NOT demote operator → probe on agreement: the first agreeing probe would
    // otherwise collapse the 10-minute precedence window. The reinforcing observation leaves
    // the selection, source, switchId, atMs, and revision unchanged.
    expect(after.account?.label).toBe("x@example.com");
    expect(after.revision).toBe(before.revision);
    expect(after.source).toBe("operator");
    expect(after.switchId).toBe(before.switchId);
  });

  test("I4: probe observation is accepted freely when no recent operator switch exists", async () => {
    await accountStateActor.probeObserved("codex", { id: "acct-a", label: "a@example.com" });
    const snap = accountStateActor.snapshot("codex");
    expect(snap?.account?.label).toBe("a@example.com");
    expect(snap?.source).toBe("probe");
    expect(currentAccount("codex")?.label).toBe("a@example.com");
  });

  test("I5: selections persist across actor re-init", async () => {
    await accountStateActor.operatorSwitched("codex", { id: "acct-x", label: "x@example.com" });
    const beforeRev = accountStateActor.snapshot("codex")!.revision;
    // Simulate process restart: clear in-memory state and re-init, which reads from SQLite.
    (accountStateActor as any).selections.clear();
    (accountStateActor as any).initialized = false;
    accountStateActor.init();
    const after = accountStateActor.snapshot("codex");
    expect(after?.account?.label).toBe("x@example.com");
    expect(after?.source).toBe("operator");
    expect(after?.revision).toBe(beforeRev);
  });

  test("I6: concurrent operator switches serialize to a single final selection", async () => {
    const [a, b] = await Promise.all([
      accountStateActor.operatorSwitched("codex", { id: "a", label: "a@example.com" }),
      accountStateActor.operatorSwitched("codex", { id: "b", label: "b@example.com" }),
    ]);
    expect(b.revision).toBe(a.revision + 1);
    // Whichever committed second is the final selection.
    const final = accountStateActor.snapshot("codex");
    expect(final?.account?.label).toBe("b@example.com");
    expect(final?.revision).toBe(b.revision);
  });

  test("I7: subscribers receive every event in order with monotonic revisions", async () => {
    const events: ActorEvent[] = [];
    const unsubscribe = accountStateActor.subscribe((e) => {
      events.push(e);
    });
    try {
      await accountStateActor.operatorSwitched("codex", { id: "a", label: "a@example.com" });
      await accountStateActor.probeObserved("codex", { id: "a", label: "a@example.com" }); // agrees — no-op write
      await accountStateActor.operatorSwitched("codex", { id: "b", label: "b@example.com" });
      await accountStateActor.probeObserved("codex", { id: "c", label: "c@example.com" }); // suppressed
    } finally {
      unsubscribe();
    }
    expect(events).toHaveLength(4);
    expect(events[0]!.kind).toBe("operator_switched");
    expect(events[1]!.kind).toBe("probe_observed");
    expect((events[1] as Extract<ActorEvent, { kind: "probe_observed" }>).changed).toBe(false);
    expect(events[2]!.kind).toBe("operator_switched");
    expect(events[3]!.kind).toBe("probe_suppressed");
    // Every event carries a revision, and revisions are monotonic. The agreeing probe and the
    // suppressed probe both carry the current operator revision without bumping it — so
    // revisions form a non-decreasing sequence, with a bump only on operator switches.
    const revisions = events.map((e) => (e as any).revision as number);
    for (let i = 1; i < revisions.length; i++) {
      expect(revisions[i]!).toBeGreaterThanOrEqual(revisions[i - 1]!);
    }
    // Exactly two bumps (the two operator_switched events).
    const bumps = events.filter((e) => e.kind === "operator_switched").length;
    expect(bumps).toBe(2);
  });

  test("I8: after the precedence window, probe observations take over again", async () => {
    await accountStateActor.operatorSwitched("codex", { id: "a", label: "a@example.com" });
    // Backdate the switch's atMs past the precedence window.
    const past = Date.now() - OPERATOR_PRECEDENCE_MS - 1000;
    db
      .query(`UPDATE account_selection_actor SET at_ms = ? WHERE provider = 'codex'`)
      .run(past);
    (accountStateActor as any).selections.get("codex").atMs = past;
    // Overwrite the in-memory record's atMs. Use the test helper to re-init from DB.
    (accountStateActor as any).initialized = false;
    accountStateActor.init();
    // Now a probe disagreement wins.
    await accountStateActor.probeObserved("codex", { id: "b", label: "b@example.com" });
    const snap = accountStateActor.snapshot("codex");
    expect(snap?.account?.label).toBe("b@example.com");
    expect(snap?.source).toBe("probe");
  });

  test("C1: a restart within the precedence window seeds the runner-identity map from the stored operator row", async () => {
    // Pre-restart: operator switches Codex to a clean account; actor stores the authoritative row.
    await accountStateActor.operatorSwitched("codex", { id: "acct-new", label: "tejas@chann.app" });
    expect(currentAccount("codex")?.label).toBe("tejas@chann.app");

    // Simulate the SessionExecutionHost constructor's startup behavior: it nulls the
    // runner-identity map for every runner-bound provider. On a real restart, the in-memory
    // actor state is empty; we clear both to mimic the restart condition.
    setRunnerAccountInUse("codex", null);
    (accountStateActor as any).selections.clear();
    (accountStateActor as any).initialized = false;
    expect(currentAccount("codex")).toBeNull();

    // init() reloads from SQLite AND seeds the runner-identity map from any operator row that
    // is still within OPERATOR_PRECEDENCE_MS. Without that seed, the actor would suppress every
    // incoming probe observation (operator still "recent") and the runner-identity map would
    // stay empty until the probe gave up, re-incurring the 2026-11-21 failure.
    accountStateActor.init();
    expect(currentAccount("codex")?.label).toBe("tejas@chann.app");

    // And the actor still suppresses a stale probe observation.
    await accountStateActor.probeObserved("codex", { id: "acct-old", label: "tejastej.dc@gmail.com" });
    expect(currentAccount("codex")?.label).toBe("tejas@chann.app");
  });

  test("replay of 2026-11-21 Codex switch: switch wins over stale runner identity for the full probe lag", async () => {
    // Pre-switch: the old account was in use and the runner-identity map reflects that.
    setRunnerAccountInUse("codex", { id: "acct-old", label: "tejastej.dc@gmail.com" });
    expect(currentAccount("codex")?.label).toBe("tejastej.dc@gmail.com");
    // Operator switch runs. The actor takes over.
    await accountStateActor.operatorSwitched("codex", { id: "acct-new", label: "tejas@chann.app" });
    expect(currentAccount("codex")?.label).toBe("tejas@chann.app");
    // Simulate four minutes of probe cycles reporting the stale old identity.
    for (let i = 0; i < 4; i++) {
      await accountStateActor.probeObserved("codex", { id: "acct-old", label: "tejastej.dc@gmail.com" });
      expect(currentAccount("codex")?.label).toBe("tejas@chann.app");
    }
    // Probe finally catches up.
    await accountStateActor.probeObserved("codex", { id: "acct-new", label: "tejas@chann.app" });
    const final = accountStateActor.snapshot("codex");
    expect(final?.account?.label).toBe("tejas@chann.app");
    expect(final?.source).toBe("probe");
  });
});
