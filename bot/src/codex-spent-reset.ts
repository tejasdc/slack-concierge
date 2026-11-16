import { runLedgerSteps } from "./ledger-admission";

/** The latest reset among this account's spent windows in its last stored usage reading.
 * Kept out of codex.ts: the usage modules load lazily (as before), and the provider Stop
 * release check evaluates codex.ts as a closed module that may not load code itself. */
export async function storedCodexSpentReset(label: string): Promise<number | null> {return runLedgerSteps((function* (): Generator<unknown, any, any> {
  try {
    const [{ providerAccountUsage }, { includedAllowanceWindows }] = (yield Promise.all([
      import("./provider-account-usage"), import("./account-allowance-observation")])) as [typeof import("./provider-account-usage"), typeof import("./account-allowance-observation")];
    const account = providerAccountUsage("codex")?.accounts.find(value => value.label === label);
    if (!account) return null;
    const resets = includedAllowanceWindows("codex", account).filter(window => window.usedPercent >= 100)
      .map(window => Date.parse(window.resetsAt ?? "")).filter(value => Number.isFinite(value) && value > Date.now());
    return resets.length ? Math.max(...resets) : null;
  } catch {
    return null;
  }
})());}
