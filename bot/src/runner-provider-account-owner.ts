/** Owner-only guard around a runner's Codex App Server account replacement. */
import { holdCodexAdmission } from "./state";
import { runningCodexTurns } from "./provider-activation";
import { runnerMachineCall } from "./runner-machine-calls";

export async function activateRunnerCodexAccount(runner: string, account: string, operationId: string): Promise<unknown> {
  if (!runner.trim() || !account.trim() || !operationId.trim()) throw new Error("A runner, Codex account and stable activation operation id are required.");
  holdCodexAdmission(true);
  try {
    const running = runningCodexTurns();
    if (running !== 0) return { status: "deferred", detail: running < 0
      ? "Codex activity could not be checked, so the runner was left alone."
      : `The runner was left alone because ${running} Codex turn${running === 1 ? " is" : "s are"} still running.` };
    return await runnerMachineCall(runner, "accounts.codex.activate", { account, operationId });
  } finally { holdCodexAdmission(false); }
}
