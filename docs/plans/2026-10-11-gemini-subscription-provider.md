# Antigravity on the Google AI Pro subscription

## Requirement and observed facts

Tejas asked to use his Google subscription for agents, show its remaining capacity beside the existing provider accounts, let eligible saved and automatic work use it, and compare it on real earlier tasks before assigning it a role.

The subscription owner is `tejastej.dc@gmail.com`: a Google Play renewal notice dated 2026-10-11 names Google AI Pro (5 TB), renewing 2026-11-11. The server has Antigravity CLI 1.3.3 installed. The personal Google integration in Thinkering is a mail/calendar connection; it is not Antigravity authentication.

Correction, 2026-10-12: the older Gemini CLI authentication and quota pages are obsolete for consumer subscriptions. Google's current [deprecation notice](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals) says individual, Google AI Pro and Ultra accounts lost Gemini CLI sign-in on 2026-06-18. A live request after successful Google sign-in failed with `UNSUPPORTED_CLIENT`. The old 1,500 requests/day figure must not be represented as available capacity. Google directs subscribers to Antigravity CLI. Its [installation and authentication guide](https://antigravity.google/docs/cli/install/) supports Google OAuth over SSH, and its [headless mode](https://antigravity.google/docs/cli/headless/) supports cached sign-in, JSON results, resumption and a streaming input protocol. Its [quota command](https://antigravity.google/docs/cli/commands/usage/) displays live remaining allowance and refresh timing. The [changelog](https://antigravity.google/docs/changelog?tab=cli) confirms that `agy -p "/usage" --output-format json` returns a structured quota snapshot without spending model allowance. Its [pricing](https://antigravity.google/pricing) describes Google AI Pro as higher limits and an AI credit pool, without a fixed daily count.

The current Codex custom provider speaks the Responses API, while Google's published OpenAI compatibility uses Chat Completions. Subscription OAuth cannot be used for a direct Codex custom provider, so this delivery does not configure Codex to impersonate Antigravity CLI.

## Ownership and invariant

Concierge's canonical owner retains the session, accepted input, model selection, scheduled/banked status, usage snapshot and exact execution receipt. Antigravity CLI owns its Google credential, model conversation, filesystem tools and its own session history on the server. Thinkering displays the owner's provider account and capacity projection; it does not authenticate with Google independently. The Mac reaches this provider through the existing peer and request path; the subscription credential stays on the server.

An accepted turn may be sent to Antigravity once. Before the CLI sees it, the owner records the exact input and a durable execution identity. After a coordinator restart, it resumes or inspects the same CLI execution; if delivery cannot be proved, the owner marks the outcome unconfirmed and never repeats that input. A follow-up keeps the same Antigravity conversation UUID. Stop cancels the active prompt. An Antigravity refusal belongs to Google, never to Claude or Codex.

Capacity has one authoritative source: Antigravity's own reported quota snapshot. A documented plan maximum is a ceiling, not a reading of current headroom. If the CLI cannot give a fresh, parseable remaining count and reset, the dashboard says capacity is unverified, and automatic choice and bank release cannot treat that provider as having room. An explicit Google request can still try and report its actual outcome. No count reconstructed from Concierge's own jobs may masquerade as Google's account-wide balance because other Antigravity surfaces share the allowance.

## Acceptance and comparison

The implementation is one complete delivery: server Antigravity process and recovery, one owner selection and usage path, Thinkering account and model surfaces, saved-work handling, install/update ownership, and project documentation. An offline fixture exercises success, sign-in refusal, quota exhaustion, stop, process loss after admission, restart, and resume. The installed check sends one marked native request through Concierge, verifies its accepted input, reply and Google session continuity, then confirms Thinkering's account reading and a saved-work dispatch. No production state is used by fixture processes.

The comparison uses the original Oct 10 typing/deletion jank request and a second bounded bug task, each at its pre-fix commit in isolated worktrees. Gemini and the original agent model receive the same task, repository state, tool access, time limit and test budget, with no production deployment authority. Score diagnosis against retained traces, exact patch behavior and regression gate, reliability (tool errors, stuck runs, incomplete work), elapsed time and model requests. Compare both to the actual historical outcome, including the remaining 140 ms copied-data insertion and missing native Mac Safari acceptance; do not score that partial release as a full success. Only measured performance may change the model-selection rules.

## Decision still requiring a probe

Before wiring the dashboard or automatic choice, sign in to Antigravity on the server and inspect the documented structured `/usage` output for a stable account-wide remaining count and reset. Verify a headless request under the cached Pro sign-in and inspect only nonsecret result fields. Use only the official CLI entrance for quota; never a private OAuth-backed endpoint. Keep automatic selection guarded whenever the reported snapshot is missing or stale.
