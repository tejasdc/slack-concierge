/** Anything that leaves the owner process waits here until the ledger rows it may depend on are on
 * disk. Only the accepting owner installs a barrier (see ledger-durability.ts); every other process
 * that loads a transport or peer client commits with SQLite's own synchronous writes, so for them
 * this resolves at once. Kept free of ledger imports so those processes never open the ledger. */
let barrier: (() => Promise<void>) | null = null;

export function installLedgerBarrier(next: () => Promise<void>): () => void {
  barrier = next;
  return () => { if (barrier === next) barrier = null; };
}

export function ledgerDurable(): Promise<void> {
  return barrier ? barrier() : Promise.resolve();
}
