#!/usr/bin/env bun

const usage = "Usage: bun bot/scripts/provider-usage.ts status | clear <codex|claude-code>\n"
  + "Requires CONCIERGE_STATE_DIR for the owning Concierge runtime. Clear only after an operator-requested reset/top-up; it does not resume work.";

async function main() {
  const [command, provider, ...extra] = process.argv.slice(2);
  if (extra.length || (command !== "status" && command !== "clear")
    || (command === "status" && provider !== undefined)
    || (command === "clear" && provider !== "codex" && provider !== "claude-code")) {
    throw new Error(usage);
  }
  const cache = await import("../src/provider-usage");
  const result = command === "status" ? cache.providerUsageStatus()
    : cache.clearProviderUsage(provider as "codex" | "claude-code");
  console.log(JSON.stringify(result));
}

if (import.meta.main) main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
