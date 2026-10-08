export interface SessionTurnQueueCoordinatorOptions<TClaim extends { turn_id: number }> {
  claim(): TClaim | null;
  run(claim: TClaim): Promise<unknown>;
  shouldStop(): boolean;
  onError(claim: TClaim, error: unknown): void;
  /** A claim attempt threw; the queue tries again on its own. */
  onClaimError?(error: unknown, consecutiveFailures: number): void;
  /**
   * The soonest instant a queued turn becomes claimable purely because of the clock, or
   * null when nothing is waiting on it. Waking on execution changes alone leaves an input
   * that is deliberately waiting — for a usage allowance to reset, for a backoff to
   * expire — with nobody to come back for it, so the queue arms a timer for that instant
   * after every pump.
   */
  nextAttemptMs?(): number | null;
}

export class SessionTurnQueueCoordinator<TClaim extends { turn_id: number }> {
  private readonly activeTurnIds = new Set<number>();
  private pumping = false;
  private wakeRequested = false;
  private stopped = false;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private claimFailures = 0;

  constructor(private readonly options: SessionTurnQueueCoordinatorOptions<TClaim>) {}

  get activeTurns(): readonly number[] { return [...this.activeTurnIds]; }

  wake() {
    if (this.stopped || this.options.shouldStop()) return;
    if (this.pumping) {
      this.wakeRequested = true;
      return;
    }

    this.pumping = true;
    try {
      do {
        this.wakeRequested = false;
        while (!this.stopped && !this.options.shouldStop()) {
          const claim = this.claimOrNull();
          if (!claim) break;
          if (this.activeTurnIds.has(claim.turn_id)) {
            this.options.onError(claim, new Error(`Queued turn ${claim.turn_id} was claimed twice locally.`));
            continue;
          }

          this.activeTurnIds.add(claim.turn_id);
          let execution: Promise<unknown>;
          try {
            execution = this.options.run(claim);
          } catch (error) {
            execution = Promise.reject(error);
          }
          void execution
            .catch((error) => this.options.onError(claim, error))
            .finally(() => {
              this.activeTurnIds.delete(claim.turn_id);
              this.wake();
            });
        }
      } while (this.wakeRequested && !this.stopped && !this.options.shouldStop());
    } finally {
      this.pumping = false;
      this.armDeadline();
    }
  }

  /**
   * A claim that throws leaves the ledger as it was (its transaction rolled back), so it is
   * retried rather than raised. wake() runs from a finished turn's promise callback, where a
   * throw is an unhandled rejection and ends the whole service: a "database is locked" claim
   * did that twice on 2026-10-07. Every later wake tries again, and the deadline comes back
   * within a few seconds even when nothing else does.
   */
  private claimOrNull(): TClaim | null {
    try {
      const claim = this.options.claim();
      this.claimFailures = 0;
      return claim;
    } catch (error) {
      this.claimFailures += 1;
      this.options.onClaimError?.(error, this.claimFailures);
      return null;
    }
  }

  /** Comes back exactly when the next waiting turn is due, and never earlier than a second. */
  private armDeadline() {
    if (this.deadline) {
      clearTimeout(this.deadline);
      this.deadline = null;
    }
    if (this.stopped || this.options.shouldStop()) return;
    let due: number | null = null;
    if (this.claimFailures > 0) {
      // Back off 2, 4, 8 … up to 60 seconds while claims keep failing.
      due = Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(this.claimFailures, 6));
    }
    if (!this.options.nextAttemptMs && due === null) return;
    try {
      const next = this.options.nextAttemptMs?.() ?? null;
      if (next !== null) due = due === null ? next : Math.min(due, next);
    } catch {
      // A failed lookup must not stop the queue; the next wake tries again.
      if (due === null) return;
    }
    if (due === null) return;
    // A day is the longest wait worth holding a timer for; a longer one re-arms on arrival.
    const delay = Math.min(24 * 60 * 60_000, Math.max(1_000, due - Date.now()));
    const timer = setTimeout(() => {
      this.deadline = null;
      this.wake();
    }, delay);
    timer.unref?.();
    this.deadline = timer;
  }

  stop() {
    this.stopped = true;
    this.wakeRequested = false;
    if (this.deadline) {
      clearTimeout(this.deadline);
      this.deadline = null;
    }
  }
}
