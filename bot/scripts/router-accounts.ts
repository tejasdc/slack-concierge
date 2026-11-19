#!/usr/bin/env bun
// Operator entrance for account/provider inspections and interventions. Supersedes
// the band-aid `router-usage-clear.ts` with a wider surface.
//
// Verbs:
//   router-actions.sh accounts status [--provider P] [--account A] [--json]
//   router-actions.sh accounts verdict <provider> <account> <model>
//   router-actions.sh accounts usage-clear <provider> [--account <label>] [--model <alias>] [--all]
//   router-actions.sh accounts refusals <provider> <account>
//
// These are the operator interventions the 2026-11-19 incident needed by hand. The
// authority (`canTakeWork`) is the single source of truth every verb reads from.

import { clearAll, clearScoped, cachedRefusalsForAccount, type RefusalProvider } from "../src/account-refusal-cache";
import { canTakeWork, canTakeAnyWork, listAccounts, type ProviderId } from "../src/account-authority";
import { listAccounts as listHomeRecords } from "../src/account-home-resolver";

type Verb = "status" | "verdict" | "usage-clear" | "refusals";

function fail(message: string, code = 2): never {
  console.error(JSON.stringify({ ok: false, error: "invalid_arguments", detail: message }));
  process.exit(code);
}

function parseProvider(raw: string): ProviderId {
  if (raw === "claude" || raw === "claude-code") return "claude-code";
  if (raw === "codex") return "codex";
  if (raw === "antigravity" || raw === "google") return "antigravity";
  return fail(`Unknown provider "${raw}". Expected one of: claude, codex, antigravity.`);
}

function status(args: string[]): void {
  let provider: ProviderId | null = null;
  let accountLabel: string | null = null;
  let asJson = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--provider") provider = parseProvider(args[++i] ?? fail("--provider requires a value"));
    else if (arg === "--account") accountLabel = args[++i] ?? fail("--account requires a value");
    else if (arg === "--json") asJson = true;
    else fail(`Unknown flag ${arg}`);
  }
  void asJson;  // the CLI always emits JSON for stability.
  const providers: ProviderId[] = provider ? [provider] : ["claude-code", "codex"];
  const rows: unknown[] = [];
  for (const p of providers) {
    const homes = p === "antigravity" ? [] : listHomeRecords(p as "claude-code" | "codex");
    for (const home of homes) {
      if (accountLabel && home.label !== accountLabel) continue;
      const anyWork = canTakeAnyWork(p, { provider: p, label: home.label });
      const refusals = cachedRefusalsForAccount(p as RefusalProvider, home.label);
      rows.push({
        provider: p, account: home.label,
        canonical_home: home.canonicalHome,
        live_root_mirror: home.liveRootMirror,
        verdict: { ok: anyWork.ok, reason: anyWork.reason, clears_at_ms: anyWork.clearsAtMs, why: anyWork.why },
        refusals: refusals.map(r => ({ model: r.model, reset_at_ms: r.resetAtMs, observed_at_ms: r.observedAtMs })),
      });
    }
  }
  console.log(JSON.stringify({ ok: true, rows }, null, 2));
}

function verdict(args: string[]): void {
  if (args.length < 3) fail("usage: router-actions.sh accounts verdict <provider> <account> <model>");
  const provider = parseProvider(args[0]!);
  const account = args[1]!;
  const model = args[2]!;
  const verdictResult = canTakeWork(provider, { provider, label: account }, model);
  console.log(JSON.stringify({ ok: true, verdict: verdictResult }, null, 2));
}

function usageClear(args: string[]): void {
  if (!args.length) fail("usage: router-actions.sh accounts usage-clear <provider> [--account <label>] [--model <alias>] [--all]");
  const provider = parseProvider(args[0]!);
  let account: string | undefined;
  let model: string | undefined;
  let all = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--account") account = args[++i] ?? fail("--account requires a value");
    else if (arg === "--model") model = args[++i] ?? fail("--model requires a value");
    else if (arg === "--all") all = true;
    else fail(`Unknown flag ${arg}`);
  }
  if (!account && !model && !all) fail("Refusing an unscoped clear. Pass --account / --model for a scoped clear, or --all to clear the whole provider.");
  if (model && !account) fail("--model requires --account (a model-specific cache is keyed by both).");
  const result = all ? clearAll(provider as RefusalProvider) : clearScoped(provider as RefusalProvider, account ?? null, model ?? null);
  console.log(JSON.stringify({ ok: true, provider, scope: { account: account ?? null, model: model ?? null, all },
    cleared: result.cleared, generation: result.generation }));
}

function refusals(args: string[]): void {
  if (args.length < 2) fail("usage: router-actions.sh accounts refusals <provider> <account>");
  const provider = parseProvider(args[0]!);
  const account = args[1]!;
  const records = cachedRefusalsForAccount(provider as RefusalProvider, account);
  console.log(JSON.stringify({ ok: true, provider, account, records }, null, 2));
}

try {
  const [verb, ...rest] = process.argv.slice(2);
  if (!verb) fail("usage: router-actions.sh accounts <status|verdict|usage-clear|refusals> ...");
  const dispatch: Record<Verb, (args: string[]) => void> = { status, verdict, "usage-clear": usageClear, refusals };
  const handler = dispatch[verb as Verb];
  if (!handler) fail(`Unknown verb "${verb}". Expected one of: ${Object.keys(dispatch).join(", ")}.`);
  handler(rest);
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: "failed",
    detail: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
