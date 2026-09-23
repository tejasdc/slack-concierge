export interface SessionTurnQueueCoordinatorOptions<TClaim extends { turn_id: number }> {
  claim(): TClaim | null;
  run(claim: TClaim): Promise<unknown>;
  shouldStop(): boolean;
  onError(claim: TClaim, error: unknown): void;
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

  constructor(private readonly options: SessionTurnQueueCoordinatorOptions<TClaim>) {}

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
          const claim = this.options.claim();
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

  /** Comes back exactly when the next waiting turn is due, and never earlier than a second. */
  private armDeadline() {
    if (this.deadline) {
      clearTimeout(this.deadline);
      this.deadline = null;
    }
    if (this.stopped || this.options.shouldStop() || !this.options.nextAttemptMs) return;
    let due: number | null = null;
    try {
      due = this.options.nextAttemptMs();
    } catch {
      // A failed lookup must not stop the queue; the next wake tries again.
      return;
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
