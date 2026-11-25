# Claude API-credit route: spend the monthly Console credit on Concierge work

Status: implemented (worker request e10abd14, designed by session concierge:8751). Current behavior
lives in [provider usage](../architecture/PROVIDER-USAGE.md#claude-api-credit-route); this plan is
the dated design record.

## Requirement (Tejas, 2026-11-05 capture, banked)

"We need to be better about using all of these API credits. It looks like the API credits are
different from the usage allowance, so we can't use them in our terminal-based agents. But at least
Anthropic lets you use them for things like Claude Managed Agents, the Claude Agent SDK and the
Claude API. Can we look into how to make use of that … so we're not wasting these credits? Also do
some of the banked work, especially at the end of the credit cycle. So we need to understand when
the credit cycle happens, so we can be smart about that. Build out either the Agent SDK or Managed
Agents, whichever is easier, better and faster and makes sense for us, so that we can offload some
of our work: they can work in our repos … and get back with the results."

## Facts established live (2026-11-25, Console of the `tejas` organization, server Chrome)

- Promotional "API credit (Ultra)": $200, granted on the 22nd of each month (Oct 22, Nov 22),
  expires about 32 days later (Nov 22 grant expires Dec 24, 7:00 PM ET). October's expired unused.
  "Applies to: Agent SDK, API, Batch API, Playground, Managed Agents". Purchased balance $0,
  auto-reload off: when the credit is gone, requests are refused; nothing charges a card.
- No API returns the credit balance. The Admin API cost report needs an Admin key; creating one in
  the Console is behind an hCaptcha, so none is filed. The Console stays the authority.
- An API key `concierge-api-credits-overflow` (Default workspace, never expires) is stored
  root-only at `/root/.local/state/credential-portal/credentials/anthropic-api/api-key.json`,
  field `api_key`. Never print, log, or pass it as a command argument.
- `/usr/bin/claude -p … --output-format json` with `ANTHROPIC_API_KEY` set, a fresh
  `CLAUDE_CONFIG_DIR` and `CONCIERGE_CLAUDE_ACCOUNT_PIN=1` succeeded (cost reported in
  `total_cost_usd`), both plain and with `CLAUDE_CODE_ENTRYPOINT=sdk-ts`.
- The Agent SDK (`@anthropic-ai/claude-agent-sdk`) is a wrapper that spawns the same `claude`
  binary in stream-json mode and sets `CLAUDE_CODE_ENTRYPOINT=sdk-ts`. Concierge's managed Claude
  launch already spawns `claude` in stream-json mode, so an Agent SDK run is exactly a managed
  Concierge Claude turn with the API key and that entrypoint.
- Added during implementation (2026-11-25): `total_cost_usd` is cumulative for the conversation
  across resumes. A resumed Haiku call reported 0.00144 after a first call of 0.00087, and its
  token counts were the sum of both calls. The ledger therefore records increases.

## Decision: Agent SDK route on the server, not Managed Agents

| | Agent SDK route (chosen) | Managed Agents |
| --- | --- | --- |
| Where it runs | This server, in the session's own worktree | Anthropic's cloud sandbox, fresh per session |
| Repo access | Already there: git, worktrees, push credentials | Needs a GitHub token handed to Anthropic's sandbox; private-repo auth undocumented |
| Talking back | Normal Concierge session: requests, replies, Inbox threads, router-actions | No Concierge tools; results only as events/files; a new return path to build |
| Cost | Tokens only | Tokens + $0.08 per running session-hour |
| New runtime to build | One route on the existing Claude provider | A new provider: create agent/env/session, stream, collect files, map to requests |

Managed Agents wins only on isolation and not using the server's CPU, neither of which is a
constraint here (one person, an always-on server). The SDK route reuses every guarantee Concierge
sessions already have. Revisit Managed Agents if a task ever needs to run where the server cannot.

## Design

Invariant: **a route is a property of the session, fixed before its first provider conversation
exists.** A Claude session is either on subscription accounts or on the API-credit route; every turn
and every resume of an API-route session runs on the API key, and a subscription conversation never
becomes an API one.

1. Aliases `cc-api` (Opus 5.5) and `cc-api-sonnet` (Sonnet 5.5) carry `route: 'api-credits'`.
   Model pickers and project defaults leave them out: they choose a route, not a model.
   `sessions implement` accepts both.
2. Session creation stores `claudeRoute: 'api-credits'`. (The handed design refused runner
   placement; see the differences below.)
3. `bot/src/claude-api-route.ts` owns the account label, the config folder, the launch
   environment, the cycle, the spend ledger, the decision rule and the refusal words.
4. Turn dispatch skips account choice, allowance readings, the budget brief and every
   move-to-another-account branch for API-route sessions. A spent credit or a rejected key ends the
   turn in plain words and never moves it.
5. The shell launcher resumes an `api-credits` conversation on the key; fresh shells drop it.
6. The ledger table `claude_api_credit_spend` records each result's increase; the cycle is the
   22nd plus 32 days; the Accounts page shows the line on the Claude row in use.
7. Overflow and banked work choose the route by themselves under the rules in provider usage.

## Implementation differences from the handed design

- **No account pin in the launch environment.** Managed turns start the Claude binary directly,
  not through the shell launcher, so `CONCIERGE_CLAUDE_ACCOUNT_PIN` is not needed there. Set, it
  would be inherited by the agent's shell and let every nested `claude` skip account selection and
  silently spend the key. The environment carries `CONCIERGE_CLAUDE_ROUTE=api-credits` instead,
  which the shell launcher uses to drop the key for fresh launches.
- **Runner placement works instead of being refused.** Production places every Claude turn on the
  `ax41` runner (`CONCIERGE_TURN_RUNNERS=all`), so a blanket refusal would have made the route
  unusable. The turn sends only the route marker; the runner reads its own key file, the same way
  it resolves an account's home itself. The key never enters a job payload or the owner's ledger.
  No placement is refused: the slack-concierge project itself is registered to runner `ax41`
  (this server), and a runner without the key file ends the turn saying so.
- **Grants overlap**, so the cycle is the soonest-expiring live grant, and the ledger detects whether
  a resume restored Claude's earlier total from its cumulative token count (independent review,
  2026-11-25). A second overflow path for a first turn refused mid-flight was built and removed: by
  then the turn has already recorded its subscription account, so the path could never fire.
- The Accounts line is added to the existing `apiCredits` facts on the Claude row in use, so the
  plan-tier credit facts that row already showed stay.
