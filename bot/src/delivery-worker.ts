export async function runDeliveryWorker(input: {
  attempt: () => Promise<void>;
  recordAttempt: () => void;
  recordFailure: (error: unknown) => void;
  wait?: (milliseconds: number) => Promise<void>;
  initialDelayMs?: number;
  maximumDelayMs?: number;
  shouldStop?: () => boolean;
  isRetryable?: (error: unknown) => boolean;
}): Promise<"delivered" | "stopped" | "permanent_failure"> {
  const wait = input.wait || ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const maximumDelayMs = input.maximumDelayMs ?? 30_000;
  let delayMs = input.initialDelayMs ?? 1_000;
  while (!input.shouldStop?.()) {
    input.recordAttempt();
    try {
      await input.attempt();
      return "delivered";
    } catch (error) {
      input.recordFailure(error);
      if (input.isRetryable && !input.isRetryable(error)) return "permanent_failure";
      if (input.shouldStop?.()) return "stopped";
      await wait(delayMs);
      delayMs = Math.min(delayMs * 2, maximumDelayMs);
    }
  }
  return "stopped";
}
