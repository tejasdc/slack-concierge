#!/usr/bin/env bun
// Operator entrance for the scoped cache clear. The 2026-11-19 incident required an
// Opus-only clear for hey@tejas.nyc without wiping other accounts' or models' caches;
// the fix had to be written as SQL by hand because this path did not exist. F10 of the
// 2026-11-19 redesign plan adds this entrance so a targeted intervention is routine.
//
// Usage:
//   router-actions.sh sessions usage-clear <provider> [--account <label>] [--model <alias>] [--all]
//
// `<provider>` is `claude` or `codex`. `--account` is the operator-visible account label
// (email). `--model` is a Claude alias or a canonical model id; Opus-1M collapses onto Opus
// via the usual allowance alias. `--all` is required to clear a whole provider's cache
// (equivalent to the legacy `clearProviderUsage` call); without it, an unscoped call errors.
import { clearProviderUsageScoped, type UsageProvider } from "../src/provider-usage";

type Options = { provider: UsageProvider; account?: string; model?: string; all?: boolean };

function parse(args: string[]): Options {
  if (!args.length) throw new Error("usage: router-actions.sh sessions usage-clear <claude|codex> [--account <label>] [--model <alias>] [--all]");
  const raw = args[0]!;
  const provider: UsageProvider = raw === "claude" || raw === "claude-code" ? "claude-code"
    : raw === "codex" ? "codex" : raw === "antigravity" ? "antigravity"
    : (() => { throw new Error(`Unknown provider "${raw}". Expected one of: claude, codex, antigravity.`); })();
  const opts: Options = { provider };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--account") opts.account = args[++i];
    else if (arg === "--model") opts.model = args[++i];
    else if (arg === "--all") opts.all = true;
    else throw new Error(`Unknown flag ${arg}`);
  }
  if (!opts.account && !opts.model && !opts.all)
    throw new Error("Refusing an unscoped clear. Pass --account <label> / --model <alias> for a scoped clear, or --all to clear the whole provider.");
  if (opts.model && !opts.account)
    throw new Error("--model requires --account (a model-specific cache is keyed by both).");
  return opts;
}

try {
  const { provider, account, model, all } = parse(process.argv.slice(2));
  const result = clearProviderUsageScoped(provider, account, model);
  console.log(JSON.stringify({ ok: true, provider, scope: { account: account ?? null, model: model ?? null, all: !!all },
    cleared: result.cleared, generation: result.generation, resumed_work: result.resumed_work }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: "invalid_arguments",
    detail: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 2;
}
