Retry, backoff, and terminal-failure discipline across Concierge, Thinkering, and remote-box

Before you do anything else, load the architecture-lessons skill. Its "one home per piece of knowledge" framing and its three enforcements (derive > publish > refuse) apply to this whole task. Retry policy is the piece of knowledge that must have one home.

The incident this fixes. On 2026-09-23, Concierge's peer-reply forwarding code in bot/src/session-peers.ts (near line 873 in the deployed bundle, the report() function that POSTs replies to peer instances) got stuck in a runaway retry loop. The box's newer code required the peer's POST /sessions/v1/peers/requests/:id/replies response to contain {eventId, recorded: "recorded"|"duplicate"}. The Mac was running older code that returned only {outcome}. Every reply was actually received and recorded on the Mac (proof in Mac logs session_peer_reply_recorded), Mac returned HTTP 202, but the box couldn't validate the ack, logged session_peer_reply_unconfirmed, kept status='pending' on the reply row, and let the wake loop re-fire the same POST. It did this at ~8 requests per second for 6 hours before Tejas noticed. Endpoint numbers: 26.5 GB peak RAM, 35.9 GB peak, 3.5 hours of CPU, 500 unconfirmed events per minute, event loop chronically lagged 600-700ms, making Concierge unresponsive to every real user request. Four request IDs were involved: 077e0dc2, 24d599e0, 4437c2cc, c414e3e8. Timeline in journalctl -u concierge-bot.service --since='2026-09-23 06:13'.

The proximate bug is that the loop has no bound: no max-attempt count, no exponential backoff, no jitter, no max-age deadline, no terminal state after budget exhausted, no observability event when the budget is exhausted. A wire-contract mismatch between peers should have surfaced as a visible failure within minutes, not as silent RAM growth.

This is a system-wide policy fix, not a one-line patch. The peer-reply loop is one instance; there are more. Do not stop at that one.

Step 1 — Inventory. Use LSP + grep to find every retry / re-schedule / wake pattern in these repos: ~/workspace/slack-concierge, ~/workspace/thinkering, ~/workspace/remote-box. Look for:
- Direct setTimeout(...) inside a catch block
- status='pending' / status='retry' / queued patterns re-read by a wake loop
- while(true) / recursive retry helpers
- HTTP client wrappers that retry internally
- Any function whose comment says "retry" or "will be sent again" or "wake" or "reschedule"
- Client-side reconnect loops (the Thinkering app's "problem can't reach the server, reconnecting…" is one — the same class of bug on the client side)

For each site, report: file:line, what it retries, what the current bound is (usually "none"), what would happen under a permanent failure (usually "grows forever"). Do NOT begin implementation until this inventory is in tmp/reviews/retry-inventory.md so we can see the surface area.

Step 2 — Design one home. The retry primitive is the source of truth. Every retry site consumes it. Ship as one exported withRetry (or similarly named — pick one and use it everywhere) in bot/src/retry.ts in slack-concierge, mirrored or re-exported into the other repos as needed. The primitive takes:
- The operation function
- A RetryPolicy object (max attempts, base delay ms, cap ms, jitter fraction, max-age ms — a hard wall-clock deadline regardless of attempt count)
- A classifyError callback that returns transient | permanent | unknown so the primitive knows to retry, give up, or escalate
- An observability sink so budget-exhaustion emits a retry_budget_exhausted structured log with the operation name, attempt count, elapsed time, last error

Policies live in a single retry-policies.ts config module — named policies for each class of call (peer reply, peer notify, provider request, external HTTP, deploy health probe, etc.). No policy numbers inline at call sites. When policy changes, one file changes.

Follow the skill's three enforcements in order:
1. Derive first. If you can make the wake loop take a RetryPolicy-bound Retryable<T> such that a call site cannot register a retry without a policy, do that. A missing policy becomes a build error.
2. Publish second. Where callers must construct their own client (cross-package), export the primitive and its policies so consumers import instead of copying numbers.
3. Refuse third. Add a lint or an architecture test that greps for raw setTimeout inside catch, status='pending' reset patterns, or queueMicrotask.*retry outside bot/src/retry.ts. Name known exceptions in the rule with their reason.

Step 3 — Migrate the identified peer-reply loop first. In bot/src/session-peers.ts, the report() function currently catches, marks pending, and lets the wake loop re-fire. Wrap the POST in the primitive with a policy that:
- Retries transient errors (5xx, network timeout, connection reset) with exponential backoff starting at 1s, capping at 60s, jitter ±25%
- Treats a wire-contract mismatch (response received but shape doesn't match {eventId, recorded}) as permanent after the first N attempts — do NOT retry a schema mismatch forever, escalate. Two peers with drifted contracts is a version-skew condition, not a network flake.
- Enforces a hard 15-minute max-age. After that: mark the reply row status='failed_deadline' (new terminal state), emit session_peer_reply_deadline_exhausted, stop retrying, raise attention on the parent request so the human sees it.

Step 4 — Migrate every other site the inventory found. One whole delivery, not phased.

Step 5 — Prove the primitive by breaking it on purpose. Per the skill's guard-validation rule, write the broken version deliberately: a call site that registers a retry with no policy, or an "infinite" policy with no bound. Verify the lint/type system/architecture-test rejects it. If it doesn't reject, the enforcement isn't real — fix the enforcement, not the broken version. Report both the deliberate break and its rejection in tmp/reviews/retry-guard-proof.md.

Delivery boundaries — read carefully.
- No agent-run tests. Tejas explicitly forbids all agent-run tests (CLAUDE.md current delivery policy). Do not run, add, or bypass test/verification commands. This is not code correctness verification via tests; it is architecture enforcement via lint/type/build. That distinction matters. He owns end-to-end testing.
- One whole delivery. Inventory → primitive → all migrations → guard proof → single commit (or a very small commit chain if size forces it, all pushed together). No "phase 1, phase 2, will migrate the rest later." That is exactly the drift pattern the skill exists to stop.
- Update-note line required on every commit. One sentence in product language addressed to Tejas about what he'll experience. For this work, something like: Update-note: when Concierge can't talk to its peer (your laptop) it now gives up cleanly after a bounded time and tells you why, instead of silently spinning until the box runs out of memory.
- Ship end-to-end. Push to origin/main on each affected repo. The existing deploy pipeline picks it up. Do not manually restart services.
- Preserve existing effect safety. Read the current terminal-states section in slack-concierge/CLAUDE.md around "Final work replies" and the request/return protocol. Any new terminal state you introduce (failed_deadline or similar) must round-trip through the existing settled-request machinery and emit the return event to the requester.
- Do not touch unrelated code. No refactors, no "while I'm here" cleanups.

Success criteria.
1. tmp/reviews/retry-inventory.md lists every retry site with current bound + risk.
2. One primitive owns the pattern; every migrated site consumes it; policy numbers are named, not inline.
3. A deliberately-broken call site is rejected at build/lint time and tmp/reviews/retry-guard-proof.md shows the rejection.
4. The peer-reply site specifically: a simulated wire-contract mismatch fails fast (within one policy budget), not indefinitely.
5. Every retry budget exhaustion emits a structured observability event a human can see, so the next incident of this class surfaces within minutes not hours.
6. Commits pushed, update notes written, deployed.

Report back at the end with: the inventory summary, the primitive's location, the guard-enforcement mechanism you chose (derive/publish/refuse), each site you migrated, the deliberate-break proof, and the deploy status.

---

Two things to consider adjusting before sending:
- The 15-minute max-age on peer replies is my guess based on tonight's 6-hour runaway; you may want it shorter (5 min?) if you'd rather see failures faster than tolerate a temporary Mac restart. Your call.
- Whether the client-side "reconnecting…" loop in the Thinkering app is in scope for this pass or a separate one — I put it in the inventory step but you could split it out since it touches UI.

