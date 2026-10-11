# Gemini on the Google AI Pro subscription

## Requirement and observed facts

Tejas asked to use his Google subscription for agents, show its remaining capacity beside the existing provider accounts, let eligible saved and automatic work use it, and compare it on real earlier tasks before assigning it a role.

The subscription owner is `tejastej.dc@gmail.com`: a Google Play renewal notice dated 2026-10-11 names Google AI Pro (5 TB), renewing 2026-11-11. The server has Gemini CLI 0.63.0 installed, but the CLI has not yet completed its own Google sign-in. The personal Google integration in Thinkering is a mail/calendar connection; it is not Gemini CLI authentication.

Google's [authentication guide](https://geminicli.com/docs/get-started/authentication/) says an individual Pro subscriber signs in with the subscription's Google account and that headless runs can use a cached CLI sign-in. Its [quota guide](https://geminicli.com/docs/resources/quota-and-pricing/) gives Pro 1,500 model requests per user per day and points to `/stats model` for a current snapshot. These requests are shared with Gemini Code Assist agent mode. The CLI [FAQ](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/faq.md) prohibits third-party tools from harvesting or piggybacking on its OAuth credential to call Google's backend. The integration must execute the official CLI and leave its credential private to it.

The CLI offers an official [ACP mode](https://geminicli.com/docs/cli/acp-mode/) with new/load session, prompt and cancel over standard input/output. It also offers [headless JSON output](https://geminicli.com/docs/cli/headless/) and [session resumption by UUID](https://geminicli.com/docs/cli/session-management/). The current Codex custom provider speaks the Responses API, while Google's published OpenAI compatibility uses Chat Completions. Subscription OAuth cannot be used for a direct Codex custom provider, so this delivery does not configure Codex to impersonate Gemini CLI.

## Ownership and invariant

Concierge's canonical owner retains the session, accepted input, model selection, scheduled/banked status, usage snapshot and exact execution receipt. Gemini CLI owns its Google credential, model conversation, filesystem tools and its own session history on the server. Thinkering displays the owner's provider account and capacity projection; it does not authenticate with Google independently. The Mac reaches this provider through the existing peer and request path; the subscription credential stays on the server.

An accepted turn may be sent to Gemini once. Before the CLI sees it, the owner records the exact input and a durable execution identity. After a coordinator restart, it resumes or inspects the same CLI execution; if delivery cannot be proved, the owner marks the outcome unconfirmed and never repeats that input. A follow-up keeps the same Gemini session UUID. Stop cancels the active Gemini prompt. A Gemini refusal belongs to Gemini, never to Claude or Codex.

Capacity has one authoritative source: the CLI's own reported quota snapshot. A documented plan maximum is a ceiling, not a reading of current headroom. If the CLI cannot give a fresh, parseable remaining count and reset, the dashboard says capacity is unverified, and automatic choice and bank release cannot treat that provider as having room. An explicit Gemini request can still try and report its actual outcome. No daily count reconstructed from Concierge's own jobs may masquerade as Google's account-wide balance because the IDE shares the allowance.

## Acceptance and comparison

The implementation is one complete delivery: server Gemini process and recovery, one owner selection and usage path, Thinkering account and model surfaces, saved-work handling, install/update ownership, and project documentation. An offline fixture exercises success, sign-in refusal, quota exhaustion, stop, process loss after admission, restart, and resume. The installed check sends one marked native request through Concierge, verifies its accepted input, reply and Gemini session continuity, then confirms Thinkering's account reading and a saved-work dispatch. No production state is used by fixture processes.

The comparison uses the original Oct 10 typing/deletion jank request and a second bounded bug task, each at its pre-fix commit in isolated worktrees. Gemini and the original agent model receive the same task, repository state, tool access, time limit and test budget, with no production deployment authority. Score diagnosis against retained traces, exact patch behavior and regression gate, reliability (tool errors, stuck runs, incomplete work), elapsed time and model requests. Compare both to the actual historical outcome, including the remaining 140 ms copied-data insertion and missing native Mac Safari acceptance; do not score that partial release as a full success. Only measured performance may change the model-selection rules.

## Decision still requiring a probe

Before wiring the dashboard or automatic choice, sign in to the official CLI on the server and observe whether ACP or `/stats model` exposes a stable, machine-readable account-wide remaining count and reset. The request maximum alone is insufficient. Verify a headless or ACP request under the cached Pro sign-in and inspect only nonsecret result fields. If quota is only a terminal display, use the CLI's public display rather than a private OAuth-backed endpoint; otherwise record the lack of a durable machine-readable quota as a product limit and keep automatic selection guarded.
