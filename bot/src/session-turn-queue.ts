export interface SessionTurnQueueCoordinatorOptions<TClaim extends { turn_id: number }> {
  claim(): TClaim | null;
  run(claim: TClaim): Promise<unknown>;
  shouldStop(): boolean;
  onError(claim: TClaim, error: unknown): void;
}

export type SessionTurnAdmission<TTurn> =
  | { draining: true }
  | { draining: false; turn: TTurn };

export function admitSessionTurnUnlessDraining<TTurn>(options: {
  shouldStop(): boolean;
  classifyDraining(): boolean;
  acquire(): TTurn;
}): SessionTurnAdmission<TTurn> {
  if (options.shouldStop()) {
    if (!options.classifyDraining()) {
      throw new Error("Deployment drain rejection could not be persisted.");
    }
    return { draining: true };
  }
  return { draining: false, turn: options.acquire() };
}

export class SessionTurnQueueCoordinator<TClaim extends { turn_id: number }> {
  private readonly activeTurnIds = new Set<number>();
  private pumping = false;
  private wakeRequested = false;
  private stopped = false;

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
    }
  }

  stop() {
    this.stopped = true;
    this.wakeRequested = false;
  }
}
