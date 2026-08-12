export interface DurableNoticeRow {
  noticeStatus: "pending" | "sending" | "delivered" | "parked";
  attempts: number;
  nextAttemptMs: number | null;
}

export function createKeyedTaskScheduler(
  onError: (key: string, error: unknown) => void = () => {},
) {
  const activeTasks = new Map<string, Promise<void>>();
  return (key: string, run: () => Promise<void>) => {
    const existing = activeTasks.get(key);
    if (existing) return existing;
    const task = run()
      .catch((error) => onError(key, error))
      .finally(() => {
        if (activeTasks.get(key) === task) activeTasks.delete(key);
      });
    activeTasks.set(key, task);
    return task;
  };
}

export function isTransientDatabaseError(error: unknown): boolean {
  const code = String((error as any)?.code || "").toUpperCase();
  const message = error instanceof Error ? error.message : String(error);
  return code.includes("SQLITE_BUSY")
    || code.includes("SQLITE_LOCKED")
    || /database (?:is )?(?:busy|locked)/i.test(message);
}

export async function retryTransientDatabaseOperation<T>(input: {
  operation: () => T;
  isRetryable?: (error: unknown) => boolean;
  shouldStop?: () => boolean;
  wait?: (milliseconds: number) => Promise<void>;
  initialDelayMs?: number;
  maximumDelayMs?: number;
}): Promise<{ stopped: true } | { stopped: false; value: T }> {
  const isRetryable = input.isRetryable || isTransientDatabaseError;
  const wait = input.wait || ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let retryDelayMs = input.initialDelayMs ?? 50;
  const maximumDelayMs = input.maximumDelayMs ?? 1_000;
  while (!input.shouldStop?.()) {
    try {
      return { stopped: false, value: input.operation() };
    } catch (error) {
      if (!isRetryable(error)) throw error;
      await wait(retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, maximumDelayMs);
    }
  }
  return { stopped: true };
}

export async function runDurableNoticeWorker<Row extends DurableNoticeRow>(input: {
  load: () => Row | null;
  claim: (nowMs: number) => Row | null;
  deliver: (row: Row) => Promise<void>;
  markDelivered: () => void;
  markRetry: (error: string, nextAttemptMs: number) => void;
  markParked: (error: string) => void;
  isRetryable: (error: unknown) => boolean;
  isPersistenceRetryable?: (error: unknown) => boolean;
  shouldStop?: () => boolean;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  initialDelayMs?: number;
  maximumDelayMs?: number;
  maximumAttempts?: number;
}): Promise<"delivered" | "stopped" | "permanent_failure"> {
  const now = input.now || Date.now;
  const wait = input.wait || ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const initialDelayMs = input.initialDelayMs ?? 1_000;
  const maximumDelayMs = input.maximumDelayMs ?? 30_000;

  const retryPersistence = <T>(operation: () => T) => retryTransientDatabaseOperation({
    operation,
    isRetryable: input.isPersistenceRetryable,
    shouldStop: input.shouldStop,
    wait,
  });

  while (!input.shouldStop?.()) {
    const loaded = await retryPersistence(input.load);
    if (loaded.stopped) return "stopped";
    const current = loaded.value;
    if (!current || current.noticeStatus === "parked") return "permanent_failure";
    if (current.noticeStatus === "delivered") return "delivered";
    if (current.noticeStatus === "sending") {
      await wait(50);
      continue;
    }

    const dueAt = current.nextAttemptMs || 0;
    if (dueAt > now()) {
      await wait(dueAt - now());
      continue;
    }

    const claim = await retryPersistence(() => input.claim(now()));
    if (claim.stopped) return "stopped";
    const claimed = claim.value;
    if (!claimed) continue;
    let deliveryError: unknown = null;
    try {
      await input.deliver(claimed);
    } catch (error) {
      deliveryError = error;
    }
    if (deliveryError === null) {
      const delivered = await retryPersistence(input.markDelivered);
      if (delivered.stopped) return "stopped";
      return "delivered";
    }
    if (!input.isRetryable(deliveryError)) {
      const parked = await retryPersistence(() => input.markParked(String(deliveryError)));
      if (parked.stopped) return "stopped";
      return "permanent_failure";
    }
    if (claimed.attempts >= (input.maximumAttempts ?? Number.POSITIVE_INFINITY)) {
      const parked = await retryPersistence(() => input.markParked(String(deliveryError)));
      if (parked.stopped) return "stopped";
      return "permanent_failure";
    }
    const retryDelayMs = Math.min(
      initialDelayMs * (2 ** Math.max(0, claimed.attempts - 1)),
      maximumDelayMs,
    );
    const retried = await retryPersistence(() => input.markRetry(String(deliveryError), now() + retryDelayMs));
    if (retried.stopped) return "stopped";
  }
  return "stopped";
}
