import { spawnSync, type SpawnSyncReturns } from "node:child_process";

type CommandRunner = (command: string, args: string[]) => Pick<SpawnSyncReturns<Buffer>, "error" | "signal" | "status">;

export function withPausedObsidianSync<T>(input: {
  enabled: boolean;
  apply: boolean;
  operation: () => T;
  runCommand?: CommandRunner;
}): T {
  if (!input.enabled || !input.apply) return input.operation();
  const runCommand = input.runCommand ?? ((command, args) => spawnSync(command, args, { stdio: "inherit" }));
  const active = runCommand("systemctl", ["is-active", "--quiet", "obsidian-sync"]);
  assertCommandResult(active, "determine obsidian-sync state", [0, 3]);
  if (active.status !== 0) return input.operation();

  assertCommandResult(runCommand("systemctl", ["stop", "obsidian-sync"]), "pause obsidian-sync", [0]);
  let operationError: unknown = null;
  try {
    return input.operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      assertCommandResult(runCommand("systemctl", ["start", "obsidian-sync"]), "restore obsidian-sync", [0]);
    } catch (restartError) {
      const recovery = "Run `systemctl start obsidian-sync`, verify it is active, then inspect the migration report before retrying.";
      if (operationError) throw new AggregateError([operationError, restartError], recovery);
      throw new Error(`${String(restartError)} ${recovery}`);
    }
  }
}

function assertCommandResult(
  result: Pick<SpawnSyncReturns<Buffer>, "error" | "signal" | "status">,
  action: string,
  acceptedStatuses: number[],
) {
  if (result.error) throw new Error(`Could not ${action}: ${result.error.message}`);
  if (result.signal) throw new Error(`Could not ${action}: terminated by ${result.signal}`);
  if (result.status === null || !acceptedStatuses.includes(result.status)) {
    throw new Error(`Could not ${action}: systemctl exited ${String(result.status)}`);
  }
}
