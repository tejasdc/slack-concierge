import { ensureCodexUpdaterDisabled } from "../src/codex-updater-settings";

const args = process.argv.slice(2);
if (!args[0] || args.length !== 1) {
  console.error("Usage: ensure-codex-updater-disabled <settings.json>");
  process.exit(2);
}
try {
  const result = ensureCodexUpdaterDisabled(args[0]);
  console.log(`Codex automatic App Server updates are disabled (${result}).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
