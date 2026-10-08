/** The accepting loop enables this; workers and command-line readers pay no timing cost.
 * One interval has one slowest call, never SQL, values or an accumulating query history. */
type Kind = 'statement' | 'transaction';
export type StorageInterval = {
  calls: number;
  transactions: number;
  occupied_ms: number;
  observation_failures: number;
  slowest: null | { kind: Kind; duration_ms: number; fingerprint: string | null; stack: string[] };
};
const empty = (): StorageInterval => ({ calls: 0, transactions: 0, occupied_ms: 0, observation_failures: 0, slowest: null });
let enabled = false;
let depth = 0;
let interval = empty();

export function startStorageIntervals(): void { interval = empty(); enabled = true; }
export function takeStorageInterval(): StorageInterval {
  const completed = interval;
  interval = empty();
  completed.occupied_ms = Math.round(completed.occupied_ms);
  return completed;
}

/** Include transaction commit/rollback: timing statements alone misses their disk flush.
 * Nested calls contribute once to occupied time; a transaction includes its callback work. */
export function observeSynchronousStorage<T>(kind: Kind, fingerprint: (() => string) | null, work: () => T): T {
  if (!enabled) return work();
  const outer = depth++ === 0;
  const start = performance.now();
  try { return work(); }
  finally {
    depth--;
    const elapsed = performance.now() - start;
    try {
      interval.calls++;
      if (kind === 'transaction') interval.transactions++;
      if (outer) interval.occupied_ms += elapsed;
      if (elapsed >= 25 && elapsed > (interval.slowest?.duration_ms ?? 0)) {
        // Capture only a slow call's synchronous caller, after the call. No heap walk or profiler.
        const stack = (new Error().stack ?? '').split('\n').slice(1, 9).map(line => line.trim().slice(0, 240));
        interval.slowest = { kind, duration_ms: Math.round(elapsed), fingerprint: fingerprint?.() ?? null, stack };
      }
    } catch { interval.observation_failures++; }
  }
}
