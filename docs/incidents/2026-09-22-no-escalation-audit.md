# No escalation on a stuck bug — model-use audit, September 21–22, 2026

## What happened

From 20:00Z on September 21 to 03:44Z on September 22, the iPhone Action Button
session on the Mac (`mac/session:WzIsMTIsMV0`, Thinkering, Claude Opus 5) received
roughly a dozen forwarded reports from the Inbox about Action Button recording
failing when the app was closed. It shipped eight Action Button changes in that
window (20:25, 21:49, 02:08, 02:18, 02:59, 03:13, 03:29, 03:31Z), one of which was
itself reported as a regression, and ended by proposing a symptom-tuned retry. It
did five web lookups (three Apple documentation pages at 20:23Z, one search and one
GitHub issue at 02:01Z), started no sub-agent and consulted no other model. Tejas
spent the night escalating his frustration. The instructions then in force said to
delegate bounded work down and never to start GPT-6 Astra without his choice; they
said nothing about escalating a stuck problem up.

At 03:44Z, after his 03:45Z voice instruction reached it through the Inbox, the
session did its first substantial platform research (Apple forums, a WWDC24
session, a write-up on App Intent process placement) and at 03:47Z started two
independent investigators: GPT-6 Astra at extra-high effort through `codex exec`
and Claude Fable 5.1 through the Agent tool.

## Delegation across all relevant sessions

`scripts/model-use-audit.py --since 2026-09-21T20:00 --until 2026-09-22T03:44`
over the Thinkering, messaging-agent and slack-concierge Claude transcripts on
both machines (13 sessions with activity in the window; Codex App Server threads
are not covered by the script):

| Measure | Count |
| --- | --- |
| Sessions with activity | 13 (10 Thinkering, 1 messaging-agent, 2 Concierge) |
| Sub-agents started | 1 (a Sonnet helper in one Mac Thinkering session) |
| Work handed to `gpt-5.6-sol`, `-terra` or `-luna` | 0 |
| Escalations to Fable 5.1 or GPT-6 Astra | 0 |
| Sessions with any web research | 2 (a box Thinkering session with 32 lookups, and the Action Button session with 5) |

Every session ran on Opus (messaging-agent on Opus 4.7). The delegate-down rule
was effectively never followed. One contributing cause: the rule told Claude
sessions to use GPT models without saying how, and the `codex` CLI a Claude
session would call is not on a provider child's PATH on remote-box.

## Resolution

The global instructions' Model selection section now carries a concrete
delegate-down table (what, which model, which command) and an escalate-up rule
with four triggers: unknown cause after one failed fix, a regression from the
agent's own fix, the same issue reported again, or Tejas's frustration. Once
triggered the agent stops shipping guesses, researches the platform, brings in a
fresh Fable 5.1 investigator, and says so in an `Escalated:` line. Automatic
Astra escalation is proposed there and awaits Tejas's confirmation. Concierge's
per-turn prompt carries a summary so resumed sessions hear it on every run, and
the Inbox states the directive in forwarded requests so a Claude run already in
progress hears it too. See [delegation and escalation](../architecture/PROVIDER-SESSIONS.md#delegation-and-escalation).
