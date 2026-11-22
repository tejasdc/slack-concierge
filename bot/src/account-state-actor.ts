/**
 * The single writer and event stream for provider account selection.
 *
 * Before this module shipped, the answer to "which account is active for provider P on this
 * machine?" came from three parallel stores updated on different cadences by different code
 * paths: the runner-identity map written by the usage probe (`setRunnerAccountInUse`), the
 * credential file on disk (read by `currentAccount` as a fallback), and operator intent
 * stored only implicitly as "whatever the credential move did." Those three could disagree,
 * and on 2026-11-21 they did: an operator switched Codex to a clean account, the credential
 * file was rewritten immediately, but the runner's identity call kept returning the old
 * (exhausted) account for several minutes. The usage probe kept pushing that stale identity
 * into the runner-identity map; `activeHasRoom` kept being computed from the old account's
 * exhausted reading; held Codex turns stayed parked until an operator cleared the cache by
 * hand.
 *
 * This actor fixes that by making operator intent authoritative over any stale probe
 * observation for a bounded window, and by giving every consumer that cares one event stream
 * to subscribe to. It is small on purpose: it does NOT replace the existing runner-identity
 * map, credential-file reads, or SQLite caches. It mediates writes into them, and emits the
 * ordered event stream that `releaseUsageHeldWork`, `moveCodexOffSpentAccount`, the probe
 * scheduler, and future subscribers consume.
 *
 * Contract:
 *  - `operatorSwitched(provider, account)` — called by `putCodexAccountInUse` / the Claude
 *    switch path once the credential move is confirmed. The actor records the selection
 *    with a fresh `switchId` and a monotonic `revision`, writes the identity into the
 *    runner-identity map immediately (so `currentAccount` returns the new login on the next
 *    read), persists the row, and publishes an `operator_switched` event. Held work release,
 *    probe reschedule, and auto-switch recomputation happen in subscribers, not in the
 *    switch path.
 *  - `probeObserved(provider, account)` — called in place of the raw `setRunnerAccountInUse`
 *    from inside the usage refresh loop. If an operator switched to a different account
 *    within the last OPERATOR_PRECEDENCE_MS, the probe's disagreement is suppressed as
 *    identity lag. Otherwise the probe's observation is written through and published.
 *  - `snapshot(provider)` — the synchronous read side; returns the last committed
 *    selection with its source, revision, and `switchId`. Readers that need to distinguish
 *    "this is what the operator asked for" from "this is what the probe last saw" branch on
 *    `source`.
 *  - `subscribe(fn)` — register a callback that fires on every revision bump, with the
 *    event payload. Subscribers are called synchronously inside the write lock; they must
 *    not call back into the actor.
 *
 * Operating profile: one person, one or two machines, ≤ 6 accounts per provider. The lock
 * is a plain promise chain; the persistence is SQLite with WAL. No library is justified.
 *
 * See `docs/plans/2026-11-22-account-state-actor.md` for the full state card and the ten
 * falsifying checks this module pins into place.
 */

import { randomUUID } from "node:crypto";
import { db } from "./state";
import { log } from "./log";
import { errorFields } from "./log";
import { setRunnerAccountInUse, type ProviderKey } from "./provider-accounts";

export type ActorProvider = ProviderKey; // 'codex' | 'claude-code'

export type SelectionSource = "operator" | "probe";

export type SelectedAccount = Readonly<{ id: string; label: string }>;

export type AccountSelection = Readonly<{
  provider: ActorProvider;
  account: SelectedAccount | null;
  source: SelectionSource;
  switchId: string | null;
  revision: number;
  atMs: number;
}>;

export type ActorEvent =
  | Readonly<{ kind: "operator_switched"; provider: ActorProvider; account: SelectedAccount; switchId: string; revision: number }>
  | Readonly<{ kind: "probe_observed"; provider: ActorProvider; account: SelectedAccount | null; revision: number; changed: boolean }>
  | Readonly<{ kind: "probe_suppressed"; provider: ActorProvider; probeLabel: string | null; operatorLabel: string; operatorSwitchId: string; ageMs: number }>;

/**
 * How long an operator's chosen account wins over a disagreeing probe observation.
 *
 * Reasoning: on 2026-11-21 the runner's identity call lagged the credential move by about
 * 3–4 minutes. A 10-minute floor keeps the operator authoritative well past that observed
 * lag while still handing control back to the probe once the identity is genuinely settled.
 * After the window, probe and operator agree on the same account anyway (the probe has
 * caught up), so the handover is silent.
 */
export const OPERATOR_PRECEDENCE_MS = 10 * 60_000;

type Subscriber = (event: ActorEvent) => void;

class AccountStateActor {
  private selections = new Map<ActorProvider, AccountSelection>();
  private subscribers = new Set<Subscriber>();
  private writeChain: Promise<unknown> = Promise.resolve();
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    db.exec(`CREATE TABLE IF NOT EXISTS account_selection_actor (
      provider TEXT NOT NULL PRIMARY KEY,
      account_id TEXT,
      account_label TEXT,
      source TEXT NOT NULL,
      switch_id TEXT,
      revision INTEGER NOT NULL,
      at_ms INTEGER NOT NULL
    ) WITHOUT ROWID`);
    const rows = db
      .query(`SELECT provider, account_id, account_label, source, switch_id, revision, at_ms FROM account_selection_actor`)
      .all() as Array<{ provider: string; account_id: string | null; account_label: string | null; source: string; switch_id: string | null; revision: number; at_ms: number }>;
    for (const row of rows) {
      if (row.provider !== "codex" && row.provider !== "claude-code") continue;
      if (row.source !== "operator" && row.source !== "probe") continue;
      const account = row.account_label && row.account_id ? { id: row.account_id, label: row.account_label } : null;
      this.selections.set(row.provider, {
        provider: row.provider,
        account,
        source: row.source,
        switchId: row.switch_id,
        revision: row.revision,
        atMs: row.at_ms,
      });
    }
    this.initialized = true;
  }

  /** Enqueue a serialized write; later calls see the result of earlier ones. */
  private enqueue<T>(work: () => T): Promise<T> {
    const next = this.writeChain.then(
      () => work(),
      () => work(),
    );
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  private persist(selection: AccountSelection): void {
    db
      .query(`INSERT OR REPLACE INTO account_selection_actor
        (provider, account_id, account_label, source, switch_id, revision, at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        selection.provider,
        selection.account?.id ?? null,
        selection.account?.label ?? null,
        selection.source,
        selection.switchId,
        selection.revision,
        selection.atMs,
      );
  }

  private publish(event: ActorEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (error) {
        log("warn", "account_state_actor_subscriber_failed", { kind: event.kind, ...errorFields(error) });
      }
    }
  }

  /** Synchronous read of the latest committed selection. */
  snapshot(provider: ActorProvider): AccountSelection | null {
    this.init();
    return this.selections.get(provider) ?? null;
  }

  /** Register a change subscriber. Returns an unsubscribe. Subscribers run synchronously
   *  inside the write lock; they must not re-enter the actor. */
  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /**
   * Called by the operator-switch path after the credential move is confirmed. Writes the
   * authoritative selection, pushes it to the runner-identity map (so `currentAccount`
   * reflects it immediately), and publishes the event. Subscribers handle held-work release,
   * probe reschedule, and auto-switch recomputation.
   */
  operatorSwitched(provider: ActorProvider, account: SelectedAccount): Promise<AccountSelection> {
    this.init();
    return this.enqueue(() => {
      const prev = this.selections.get(provider);
      const revision = (prev?.revision ?? 0) + 1;
      const switchId = randomUUID();
      const selection: AccountSelection = {
        provider,
        account,
        source: "operator",
        switchId,
        revision,
        atMs: Date.now(),
      };
      this.persist(selection);
      this.selections.set(provider, selection);
      // Push into the existing runner-identity map so `currentAccount(provider)` returns the
      // new login on the very next synchronous read. Without this, consumers that read
      // `currentAccount` would still see the stale runner-identity for minutes.
      setRunnerAccountInUse(provider, account);
      log("info", "account_state_operator_switched", {
        provider,
        account_label: account.label,
        account_id: account.id,
        switch_id: switchId,
        revision,
      });
      this.publish({ kind: "operator_switched", provider, account, switchId, revision });
      return selection;
    });
  }

  /**
   * Called by the usage refresh loop in place of a raw `setRunnerAccountInUse`. When the
   * probe reports a different account than a recent operator switch, the observation is
   * recorded in the suppression log and discarded — the operator has already said which
   * account is current, and a lagging runner-identity read is not evidence otherwise.
   */
  probeObserved(provider: ActorProvider, account: SelectedAccount | null): Promise<AccountSelection | null> {
    this.init();
    return this.enqueue(() => {
      const prev = this.selections.get(provider);
      const now = Date.now();
      const operatorRecent = prev?.source === "operator" && prev.switchId !== null && now - prev.atMs < OPERATOR_PRECEDENCE_MS;
      const probeLabel = account?.label ?? null;
      const operatorLabel = prev?.account?.label ?? null;
      if (operatorRecent && probeLabel !== operatorLabel) {
        log("info", "account_state_probe_suppressed_by_operator", {
          provider,
          probe_label: probeLabel,
          operator_label: operatorLabel,
          operator_switch_id: prev!.switchId,
          age_ms: now - prev!.atMs,
        });
        this.publish({
          kind: "probe_suppressed",
          provider,
          probeLabel,
          operatorLabel: operatorLabel!,
          operatorSwitchId: prev!.switchId!,
          ageMs: now - prev!.atMs,
        });
        return prev ?? null;
      }
      const revision = (prev?.revision ?? 0) + 1;
      const selection: AccountSelection = {
        provider,
        account,
        source: "probe",
        switchId: null,
        revision,
        atMs: now,
      };
      this.persist(selection);
      this.selections.set(provider, selection);
      // The probe's observation is also pushed to the runner-identity map. This is what the
      // old `setRunnerAccountInUse` call did directly; the actor is now the gatekeeper.
      setRunnerAccountInUse(provider, account);
      const changed = (prev?.account?.label ?? null) !== (account?.label ?? null);
      this.publish({ kind: "probe_observed", provider, account, revision, changed });
      return selection;
    });
  }

  /** Test-only: reset state. Not exported through the module's public API. */
  __resetForTests(): void {
    this.selections.clear();
    this.subscribers.clear();
    this.writeChain = Promise.resolve();
    try {
      db.exec(`DELETE FROM account_selection_actor`);
    } catch {
      // Table may not exist yet in a bare-schema test.
    }
  }
}

export const accountStateActor = new AccountStateActor();
