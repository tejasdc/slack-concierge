export function createCoalescingEventRunner<Reason>(input: {
  run(reason: Reason): Promise<void>;
  shouldStop?(): boolean;
}) {
  let active: Promise<void> | null = null;
  let requested = false;
  let latestReason: Reason | undefined;

  const request = (reason: Reason) => {
    requested = true;
    latestReason = reason;
    if (active) return active;
    const work = (async () => {
      while (requested && !input.shouldStop?.()) {
        requested = false;
        await input.run(latestReason as Reason);
      }
    })().finally(() => {
      if (active === work) active = null;
    });
    active = work;
    return work;
  };

  return {
    request,
    active: () => active,
  };
}
