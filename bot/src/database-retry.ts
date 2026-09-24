import { withRetry as withRetryCore } from "./retry-core";
import { RETRY_POLICIES } from "./retry-policies";

export function isTransientDatabaseError(error: unknown): boolean {
  const code = String((error as any)?.code || "").toUpperCase();
  const message = error instanceof Error ? error.message : String(error);
  return code.includes("SQLITE_BUSY")
    || code.includes("SQLITE_LOCKED")
    || /database (?:is )?(?:busy|locked)/i.test(message);
}

export function createDatabaseRetry(withRetry: typeof withRetryCore = withRetryCore) {
  return async function retryTransientDatabaseOperation<T>(input: {
    operation: () => T;
    isRetryable?: (error: unknown) => boolean;
    shouldStop?: () => boolean;
    wait?: (milliseconds: number) => Promise<void>;
  }): Promise<{ stopped: true } | { stopped: false; value: T }> {
    const isRetryable = input.isRetryable || isTransientDatabaseError;
    if (input.shouldStop?.()) return { stopped: true };
    return withRetry({ operation: "database-write", key: "sqlite-writer", policy: RETRY_POLICIES.ledgerWrite,
      wait: input.wait,
      run: async () => input.shouldStop?.() ? { stopped: true as const } : { stopped: false as const, value: input.operation() },
      classifyError: (error) => isRetryable(error) ? "transient" : "permanent",
    });
  };
}

export const retryTransientDatabaseOperation = createDatabaseRetry();
