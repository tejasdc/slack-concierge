# What was built from the retrospective (2026-09-29, same night)

Tejas approved the proposal that evening: "Move the message into server, and force it all … decision record actually is like a really, really good idea … adding a check for agents now is … a good idea … we can safely retire some of those older rules … some sort of end-to-end testing, verifying should work … foundation is like … protocols … unless I say it is a foundation … just let's build this out." [decision: foundation-means-protocols-he-names]

| Part | What runs where | Evidence it works |
| --- | --- | --- |
| Messaging on the server | New messaging agent is a server session (`session:WzIsMzkxMiwxXQ`, project messaging-agent). It calls thnkr.ing's socket directly. The Mac keeps only the texting relay; the Mac agent (mac:15) is retired and points senders at the server one. | It took over the Mac agent's open items, rewrote its manual for the writing role (messaging-agent `9f80954`), sent a test email to Tejas through send-now (Gmail message `1a0ef8062f688749`), and left a test text as a draft for his tap. |
| Enforced roles | Concierge refuses `--requested-effect work` sent by a session in a writing project (`WRITING_PROJECTS`). | Refused live on the Mac instance, from the messaging agent itself. |
| Sessions placed by need | A new session on another machine needs `--machine-need`; every placement text says new work runs on the server. | Refused live on the Mac instance. |
| Questions carry his words | needs_you, needs_decision replies and ready decision questions in Inbox threads need his exact words (checked against his messages) and why they don't settle it; both are shown with the question. | needs_you without them refused live on the Mac instance. |
| Checked before done | A completed work reply needs `--checked` or `--not-checked`, shown with the answer. The no-agent-tests rule in Concierge and thnkr.ing is narrowed to "no unit tests to fill it". | Refused live on the Mac instance; every worker reply since carries "Checked on the real system". |
| Decisions record | `~/workspace/decision-record` on both machines: 42 entries with his words, source, scope and status, and a `decision` command. The machine-wide pre-commit check refuses an uncited "Tejas decided" line in AGENTS.md, CLAUDE.md, SKILL.md or skill references, and an agent-choice entry cited as his. | A scratch commit with an uncited attribution was refused on the server, the same line cited was accepted, and the Inbox's rule rewrite was replayed and refused. |
| Foundation = protocols | Global instructions: his word is a command; only the protocols between sessions, requests, threads, outcomes, notifications, permissions and machines need a proposal first. | Instruction change; no runtime part. |
| Older rules retired | The Inbox rewrote its own rules from 9,711 to 1,716 words (slack-inbox `02bb2a0`, `cd24c3f`), adding three decision entries. Global and thnkr.ing instructions updated. | The Inbox's commit and its citation check. |
| Mac updates itself | `com.tejasdc.concierge-autoupdate` every fifteen minutes and on wake: installs a newer main only when no turn is running, holding new work only for the restart; also refreshes the decisions record. | First automatic run at 23:46Z pulled main but unloaded itself before restarting Concierge; fixed in `f85fb5e`. At 00:04Z it installed `6be02c2` on its own: pulled, restarted Concierge, stayed loaded and refreshed the decisions record. |
| Routing check | `capability-route-check` (capability-map skill) sends one real request per ability to the session that handles it; a question, credential request, failure or stall is a failure. Effects stay with Tejas or stop before the outside step. | All seven routes pass (runs of 2026-09-29 23:46–00:10Z), after fixing two of its own route wordings and a grader that mistook a web address for a question. |

## Still open

- The server's Concierge installs these changes at the next moment all its sessions are idle; until then its refusals are live only on the Mac.
- The Mac has never had Codex's and Claude's machine-wide hooks installed. That step asks for his Mac password once: run `scripts/install-mac.sh` from a terminal.
- The global instructions file is not in Git, so the decision citation check does not cover it.
- Why the Inbox's first rule-rewrite commit passed the citation check at 19:43 is unexplained; the same commit replayed later was refused.
- thnkr.ing gaps the messaging agent reported, for that project: agents can't discard a draft; the Messages page's "Google connected" flag is always on; an email draft without a Gmail copy can never get one; no socket list of waiting texts and no read of his Gmail.
- Left in his accounts by tonight's checks, all addressed only to him: two test emails, an "Agent routing check" email draft, and two test texts waiting for his tap.
