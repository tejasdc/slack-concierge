let precedingTest = Promise.resolve();

export async function acquireDatabaseTestLock(): Promise<() => void> {
  let release!: () => void;
  const thisTest = new Promise<void>((resolve) => { release = resolve; });
  const preceding = precedingTest;
  precedingTest = thisTest;
  await preceding;
  return release;
}
