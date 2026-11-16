import { runLedgerSegment } from "./ledger-admission";
/** One producer retains each callback until its consumer completes, in original call order.
 * Socket readers keep pumping control replies while consumer admission is suspended.
 */
export class ProviderCallbackCustody {
  private pending: Promise<void> | null = null;
  private failure: unknown;
  private failed = false;

  enqueue(operation: () => void | Promise<void>): void {
    const run = () => {
      try {
        const result = operation();
        if (result && typeof result.then === "function") return result.catch(error => {
          if (!this.failed) { this.failed = true; this.failure = error; }
        });
      } catch (error) { if (!this.failed) { this.failed = true; this.failure = error; } }
    };
    if (this.pending) this.pending = this.pending.then(run);
    else {
      const result = run();
      if (result) this.pending = result;
    }
  }

  hasFailure(): boolean { return this.failed; }

  async drain(): Promise<void> {
    // A consumer can synchronously publish another event while finishing its own event.
    let observed: Promise<void> | null;
    do { observed = this.pending; if (observed) await observed; } while (observed !== this.pending);
    if (this.failed) throw this.failure;
  }

  wrap<T extends object>(input: T, callbacks: readonly string[]): T {
    const wrapped = { ...input };
    for (const name of callbacks) {
      const key = name as keyof T;
      const callback = input[key];
      if (typeof callback === "function") {
        (wrapped as any)[key] = (...args: unknown[]) => {
          this.enqueue(() => consumeProviderObservation(callback as any, ...args));
          const consumed = this.drain();
          void consumed.catch(() => {});
          return consumed;
        };
      }
    }
    return wrapped;
  }
}

export async function withProviderCallbackCustody<T extends object, R>(
  input: T, run: (input: T, custody: ProviderCallbackCustody) => Promise<R>,
  callbacks: readonly string[] = providerObservationCallbacks,
): Promise<R> {
  const custody = new ProviderCallbackCustody();
  const wrapped = custody.wrap(input, callbacks);
  try { return await run(wrapped, custody); }
  finally { await custody.drain(); }
}

/** These are observations or registration notices, never a callback that authorizes a send. */
export const providerObservationCallbacks = [
  "onProgress", "onProviderMessage", "onClaudeCall", "onSteeringReady",
  "onCancellationReady", "onProviderTerminal", "onBackgroundWait",
  "onBackgroundReportMissing", "onBackgroundReleaseReady", "onProviderRetry",
  "onRetryRestartReady", "onInputAcknowledged", "onPreferredModel",
  "onProviderThreadStarted", "onProviderTurnStarted", "onResumeUnanswered",
  "onRateLimits", "onRecoveredSteering", "onAdoptedLive",
] as const;
export const transportObservationCallbacks = [
  "onStdout", "onStderr", "onStdinReady", "onInterruptReady",
  "onProtocolActivityReady", "onReplayedInput", "onReplayEnd",
] as const;
export const executionObservationCallbacks = ["onLaunched", "onAttached", "onExited", "onReleased"] as const;

/** Admission ends as soon as the callback reaches its first await. The consumer owns
 * fresh admission for its later mutation segments; no permission flows through this promise. */
export async function consumeProviderObservation<A extends unknown[]>(
  callback: ((...args: A) => void | Promise<void>) | undefined, ...args: A
): Promise<void> {
  if (!callback) return;
  const { continuation } = await runLedgerSegment(() => ({ continuation: callback(...args) }));
  await continuation;
}
