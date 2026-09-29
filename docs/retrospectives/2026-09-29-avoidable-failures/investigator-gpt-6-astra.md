TL;DR: Keep the durable records and working services, but change how work is assigned, how capabilities report their availability, and what evidence permits a completion claim. The recurring failure is that an agent’s interpretation becomes operational truth too easily—while Tejas repeatedly supplies the missing integration check.

This investigation was read-only. I examined the supplied transcripts, instruction history, selected code and commits, and official documentation. I did not open the other retrospective reports, contact agents, run tests, or change state. Timestamps below are UTC. Large transcripts were searched and read selectively, not read completely.

## 1. Root causes

**A. A specialist’s conversation became both a service and an engineering department. — Confirmed**

The messaging agent’s original brief combined three jobs: composing messages, maintaining personal preferences, and owning messaging features. The Inbox then placed that entire role on the Mac “where Messages lives.” That coupled email composition and engineering work to the machine needed by one delivery mechanism.

This was **not originally an unauthorized invention**. On September 21, Tejas explicitly said that feature requests for messaging should be handled by that same agent. The problem was translating “handles” into a broad, persistent operational role without separating composition, delivery, and implementation. Tejas narrowed that role on September 29. [Original request and placement decision, September 21, 04:48]( /root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/inbox-router-concierge3172-before-0926.txt:21116)

The same coupling appeared in flashcards: the grader performed card maintenance while serving interactive answers. A long-running specialist conversation became a shared waiting point for unrelated kinds of work. [Flashcard investigation, September 29, 17:04](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/flashcards-concierge3885.txt:4714)

**System cause:** roles are primarily instructions attached to general-purpose agents. Being responsible for a subject also grants practical freedom to redesign its machinery. Session continuity takes precedence over the availability requirements of the particular task.

---

**B. The system confuses four different facts: documented, connected, implemented, and authorized. — Confirmed**

For personal Gmail, these facts differed:

| Fact | What the evidence establishes |
|---|---|
| The personal Google command existed | Yes, but it had no completed personal sign-in on either machine. |
| thnkr.ing had a working Google connection | Yes, connected September 28 and successfully creating Gmail drafts September 29. |
| That connection had sufficient Google permission to send a draft | Yes. Google accepts its existing read-and-modify permission. |
| thnkr.ing already exposed an email-send operation before the incident | No. That operation had to be added. |
| Tejas authorized this particular email to be sent | Yes: “you don't have to put that in draft, send it right away.” |

The builder actually recognized the critical distinction at **21:08**: the existing connection “could technically send,” but the app lacked the operation. Nevertheless, the subsequent implementation used the unsigned-in command instead of extending the connection that already owned the Gmail drafts. [Builder’s explanation, September 29, 21:08](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/thinkering-mac6-notifications-and-sending-since-0924.txt:6459)

The capability map contributed ambiguity. Its broad Google row directed mail work toward account commands, while other rows placed calendar and drafts with thnkr.ing. It accurately disclosed the missing command-line sign-in, but did not resolve which owner should gain a missing email operation. Its own adding guide already said to extend the service holding the account and records. [Capability-map history, commits `bd559e5` and `949bda7`](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/capability-map-skill-history.txt)

**System cause:** capability truth is assembled from prose across several owners. The map can tell an agent where documentation lives, but it cannot distinguish an unavailable route from an available connection missing one operation.

The statement “the send capability existed all along” is therefore too broad. **The connection and permission existed; the product operation did not.** Google’s official reference confirms the permission distinction. [Gmail draft-send documentation](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/send)

---

**C. The router changes the meaning and certainty of information passing through it. — Confirmed**

The listed incidents are supported, with an important correction to the grader story:

| Incident | What happened |
|---|---|
| “The grader was busy” | At 16:56, the Inbox blamed a general inability to accept messages while background work ran. |
| “The grader was free” | At 16:58, it reversed itself because a direct message got through. That conclusion was also unsupported. |
| Later traced cause | The grader **was** doing maintenance, but the conversation screen could deliver into the running turn while the flashcards screen queued behind it. The distinction was the delivery path, not simply busy versus free. |
| “Remove all account notices” | At 17:09, the Inbox expanded Tejas’s objection into removal of every account notice. At 17:12, it admitted that he had not asked for that. |
| “Nothing is wrong” with six-minute repeats | The scheduler followed its configured learning steps, but those steps repeatedly put old cards ahead of the new material he wanted to study. |

Sources: [Inbox, September 29, 16:56–16:58](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/inbox-router-concierge3172-since-0926.txt:8526), [traced flashcard cause, 17:04](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/flashcards-concierge3885.txt:4724), [account overcorrection, 17:09–17:12](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/inbox-router-concierge3172-since-0926.txt:9026), [six-minute explanation, 16:03](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/inbox-router-concierge3172-since-0926.txt:8052).

This predates September 29. The Inbox’s September 22 instruction change explicitly required preserving uncertainty after earlier incorrect Action Button diagnoses. The instruction existed; the behavior recurred. [Inbox instruction history, commit `a2bc1b1`](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/inbox-AGENTS-md-history.txt:1425)

**System cause:** the relay is another unrestricted interpretation step. Request identity survives, but the distinction between observation, hypothesis, requested outcome, and proposed mechanism does not reliably survive.

---

**D. Approval and preferences are retained as prose, then repeatedly reconstructed. — Confirmed**

The Sophie sequence shows both unnecessary caution and excessive reinterpretation:

- **20:59:** Tejas explicitly requested sending.
- **21:08:** the worker offered a paste-it-yourself fallback.
- **21:41:** Tejas said, “Yes, build that out.”
- **21:45–21:46:** the proposal asked for approval again and for a cancellation-window choice.
- **21:52:** the messaging agent acknowledged that the approval was already given and that Tejas’s September 25 words already specified fifteen seconds.
- **22:05:** the Inbox asked him to retrieve application settings from his Mac and submit a credential form.
- **22:19:** the existing Google connection sent the email after the operation was added and its first implementation error corrected.

Sources: [original request](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/inbox-router-concierge3172-since-0926.txt:9527), [approval](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/inbox-router-concierge3172-since-0926.txt:9812), [messaging agent’s admission](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/messaging-agent-mac15.txt:5475), [credential request](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/inbox-router-concierge3172-since-0926.txt:10203), [Gmail receipt](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/thinkering-mac6-notifications-and-sending-since-0924.txt:7647).

The initial distinction between sending one email and permanently changing sending behavior was legitimate. Repeatedly reopening decisions already made was not.

**System cause:** there is no dependable connection between a particular decision, its scope, its later replacement, and the operation now being attempted. Old defaults become walls; new instructions become unnecessarily broad slogans.

The opposite repair—“never ask anything after a command”—would introduce another failure. Ambiguous recipients, genuinely new permissions, and material foundation changes still require judgment.

---

**E. Verification often proves a component or a story, rather than the user’s outcome. — Confirmed**

Three examples establish the pattern:

1. **Discovery:** agents could find the map and explain selected routes. That did not establish email sending or operation while the Mac slept.
2. **Flashcards:** the initial report disclosed that the real grader had not received an answer from the production page. Later records showed 12 answers or reveals across ten old cards, with 86 new cards never reached. The implementation worked according to its defaults while failing the intended study experience. [Initial report, September 29, 06:19; later history](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/inbox-router-concierge3172-since-0926.txt), [recorded counts, 17:04](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/flashcards-concierge3885.txt:4714).
3. **Notice consolidation:** the worker reported 218 migrated locations after inspecting two rendered states and examples of the three notice kinds. The actual update notice was missed. Its controls stretched into a second row; the later investigation explicitly acknowledged skipping the changed surface. [Notice-session reports, September 27, 22:00–22:02; September 29, 15:32–15:47](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/thinkering-session-flow-notices-concierge3265-since-0927.txt)

There is also contrary evidence worth preserving: several workers clearly distinguished “shipped” from “proven live.” The failure is not universal dishonesty. It is inconsistent acceptance criteria and summaries that sometimes collapse those distinctions.

**System cause:** success is frequently defined by the implementation’s own behavior—finding a document, passing simulated checks, compiling, or restarting—rather than the complete task under the conditions Tejas actually encounters.

---

**F. Lessons accumulate faster than enforceable changes. — Confirmed pattern; causal contribution inferred**

The lessons log repeatedly describes failures as repeats of earlier rules. September 29 alone added rules about unnecessary questions, same-day flashcard repeats, account notices, repeated approvals, and making commands happen. The Inbox also already contained rules against inventing mechanisms, losing uncertainty, enlarging requests, and asking answered questions. [Lessons log, September 23–29](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/skills-LESSONS.md)

The refactor did improve discovery and remove duplication. However, its headline measure—164 lines—should not be mistaken for a small instruction burden. The supplied global file contains **5,102 words**; the Inbox file contains **9,711 words in 188 lines**. These are measured file counts, not an estimate of actual model context.

**Inference:** dense, overlapping instructions make reconstruction harder, especially in long-lived sessions. These sources do not isolate prompt length as the cause. The stronger finding is that the same prohibited behaviors remained possible after their instructions were added.

## 2. Changes that prevent or loudly expose these failures

These are proposals, not changes made during this investigation. They should extend existing owners rather than introduce another dispatcher or independent registry.

| Cause | Concrete mechanism and responsible owner | What it prevents or exposes | Foundation approval? |
|---|---|---|---|
| A: role and machine coupling | Concierge assigns the correspondence role to a server session. thnkr.ing retains drafts and delivery. The Mac remains a narrow Messages relay. Engineering requests go to project workers. A role that cannot build must lack code-writing/deployment powers, not merely be told not to build. | Email preparation cannot silently acquire a laptop dependency; a correspondence worker cannot implement infrastructure. | **Yes:** machine placement, session ownership and permissions. |
| B: ambiguous capability truth | Each existing service publishes its supported operations, account identity, machine dependencies, and timestamped connection evidence. The map points to these owner responses. Personal Gmail operations resolve to the existing Google owner; unsupported operations are identified as missing implementation rather than missing credentials. | A documented but unsigned-in command cannot be presented as the working personal-mail route. Duplicate account ownership becomes visible. | **Yes** for a new cross-service contract or refusal; correcting existing documentation alone is not such a change. |
| C: altered scope and certainty | Keep Tejas’s exact request and approved scope attached to every handoff. Separate observations, hypotheses and proposals in the result. Completion and attention views show the owner’s evidence and limitations alongside the router’s explanation. | The router cannot silently turn “investigate” into “remove everything,” or present a worker’s hypothesis as an owner-confirmed result. | **Yes:** request and outcome contracts. |
| D: repeated decisions | Extend existing decision records with the operation and scope they authorize, the source words, and explicit supersession. A repeated request for the same approval points to the existing decision; a materially wider request explains the difference. | Re-approval of an unchanged operation is refused or returned to the worker. Old defaults cannot silently override a newer scoped instruction. | **Yes:** authorization and decision handling. |
| E: proxy verification | A completion claim must identify the requested outcome, installed version where relevant, actual path exercised, and remaining gaps. A discovery check can only close discovery; a deployment can only establish deployment. Add narrowly authorized behavioral checks for the failures in question. | “Three agents described it” cannot become “it works”; “server restarted” cannot become “account switched.” | **Yes** for new delivery gates or exceptions to the current testing policy. |
| F: lessons without closure | Track each retrospective remedy in the existing work records with an owner, required approval, and observable completion condition. Publish current operating decisions from their owner; keep old decisions as history rather than competing instructions. | A lesson cannot disappear into a log while being described as a completed systemic repair. | **Yes** if introducing enforced lifecycle or policy-refresh behavior. |

These mechanisms cannot make arbitrary language interpretation infallible. They can make machine dependency, permission, supported operation, approval scope, and evidence requirements explicit—and reject contradictions the system can actually determine.

For example: “Email Sophie now” should reach a server composer, create the existing paired draft, and invoke the server’s approved sending operation. If the operation is absent, the same Google owner needs an implementation change. If consent is absent, the owner reports that specific fact. Those are different failures with different next actions.

## 3. Why the messaging agent lives on the Mac

**Who decided:** the Inbox router.

**When:** it announced the decision on **September 21 at 04:48:58**, then started the session at approximately **05:33**.

**Reason given:** “on your Mac, where Messages lives.” The project had been created on both machines, so project availability did not force the choice. [Placement announcement](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/inbox-router-concierge3172-before-0926.txt:21171), [session launch](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/inbox-router-concierge3172-before-0926.txt:21358).

Tejas requested a dedicated, persistent messaging agent. The cited request does not explicitly select the Mac. The router selected it and generalized the Messages dependency to the whole role.

| Part of messaging | Physical requirement |
|---|---|
| Writing in Tejas’s voice and applying preferences | No Mac requirement. |
| Keeping drafts and sending Gmail drafts | Server; the successful Sophie send demonstrates this. |
| Reading the Mac’s local Messages history | Requires access to that Mac’s data, unless an explicitly approved retained copy already suffices. |
| Sending through the existing Mac Messages helper | Requires the Mac and its authorized Messages integration. |
| Sending from an iPhone composer | Can use the phone, but the person approves sending in Apple’s interface. It is not an automatic server substitute. |

Apple documents both Messages on Mac and the phone composer’s user-approved sending behavior. [Messages on Mac](https://support.apple.com/guide/messages/set-up-messages-ichte16154fb/26.0/mac/27), [iPhone message composer](https://developer.apple.com/documentation/messageui/mfmessagecomposeviewcontroller?changes=la&language=objc).

**What happens while the Mac sleeps today:**

- A new request following the designated messaging-agent route waits on the Mac, even when its eventual delivery would use server Gmail.
- Concierge retains the request and delivers it when the Mac answers again. After thirty minutes, it reports overdue work to the requesting agent. Under the September 27 policy, a sleeping Mac does not itself notify Tejas; the requesting agent decides whether to escalate. [Peer behavior](/root/workspace/slack-concierge/docs/runbooks/PEER-INSTANCES.md:360), [implemented overdue handling](/root/workspace/slack-concierge/bot/src/session-peers.ts:727).
- An email already scheduled in the server’s sending operation does **not** need the Mac to finish. [Server email scheduler](/root/workspace/thinkering/packages/adapters/src/email-send-scheduler.ts:36).
- The phone has a manual sending alternative for a prepared text. That does not remove the earlier wait if the designated composer has not prepared the message.
- Another server agent can technically prepare correspondence: the September 28 Sophie draft did exactly that while the messaging agent was offline. But that was an explicitly requested Codex task, not an established automatic failover. [September 28 request and result](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/email-sophie-server-concierge3844.txt).

Therefore, “everything runs on the Mac” is incorrect. **A critical coordination step runs there, unnecessarily placing otherwise server-capable work behind a sleeping laptop.**

## 4. Why the discovery test passed

The first test asked four fresh agents to:

1. Check whether the tools project existed on both machines.
2. Check Spotify connectivity without saving.
3. Explain who would compose and store a future text draft.

It did **not** ask them to send email, extend a missing Gmail operation, or complete work while the Mac was asleep. [Exact test prompt, September 29, 05:37:54](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/capability-map-refactor-concierge3865.txt:1117)

It found real defects: an incorrect messaging-agent address and a shell shortcut hiding the sanctioned project command. That was useful testing. It established success for those scenarios, not general capability correctness. [Results, 05:44](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/capability-map-refactor-concierge3865.txt:1530)

The later instruction-placement comparison also changed its prompts between rounds: Todoist/calendar-command tasks before, calendar-buffer/Oura/commit-rule tasks after. The improved results support those later cases, but do not isolate instruction wording as the sole cause of improvement. [Before prompt](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/capability-map-refactor-concierge3865.txt:1686), [after prompt](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/capability-map-refactor-concierge3865.txt:2045).

The messaging agent **did load the capability map** during the failing evening request. This incident cannot be explained simply as “it forgot to discover the capability.” [September 29, 21:01](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/messaging-agent-mac15.txt:5049)

After the incident, three fresh agents correctly described the new email path. That establishes improved routing instructions. The test still explicitly prohibited executing the route, and the server answers still delegated composition to the Mac. It therefore did not establish laptop-independent delivery. [Follow-up check, 22:25–22:32](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/capability-map-refactor-concierge3865.txt:2433)

**A test that would catch this failure must exercise these distinctions:**

| Scenario | Required result |
|---|---|
| Existing Google connection works; command-line personal Google is unsigned-in; send operation is absent | Identify the existing account owner and missing operation. Do not request a second sign-in. |
| Same setup after sending is implemented | Choose the existing server operation and report its actual result. |
| Mac is unavailable | Email preparation and sending still complete on the server; texts report their actual device dependency. |
| Long-lived agent holds the earlier draft-only instructions | Apply the newer scoped send authorization without discarding unrelated draft-only protections. |
| User has already approved the feature and cancellation window | Do not reopen either decision. |
| Draft-only instruction, repeated request, cancellation, interrupted send | Preserve each distinct outcome; uncertain sending must not become either confirmed success or automatic replay. |
| Several natural phrasings of “send this now” | Interpret the intent without requiring a memorized phrase. |

Use the same scenarios before and after a change. Grade against owner behavior and retained outcomes, not agreement among agents. Initial discovery can remain read-only; effectful acceptance needs a separately authorized, controlled recipient. No such test was run in this investigation.

## 5. Should everything be scrapped?

The objective is **reliable completion with fewer interventions from Tejas**, while retaining history, preferences, drafts, and control over consequential actions.

| Option | Where it wins | Where it loses | Evidence |
|---|---|---|---|
| **Scrap and rebuild** | Allows clean roles, machine placement and contracts from the outset. | Recreates integrations and migrates valuable state. The same interpretation and verification failures can recur in new code. | The sources do not establish that the existing storage or service boundaries are irreparable. No credible rebuild estimate was produced. |
| **Keep the system; change specific foundations** | Preserves working custody, Google consent, drafts, request identities and history while removing demonstrated dependency and authority failures. | Requires careful transition and proof that old routes no longer remain authoritative. A documentation-only version would fail. | Sophie was sent through the existing Google connection after a bounded extension. The existing peer queue preserves work during sleep. |
| **Keep as is** | No migration or immediate engineering cost. | Retains laptop-dependent composition, repeated interpretation errors and unsupported completion claims. | The same failure classes recur after explicit instruction additions. |
| **Use Gmail and Messages directly for correspondence** | Uses mature native editing and sending paths with clear human control. | Returns composition, routing and sending work to Tejas; does not meet his autonomous-assistant objective. | This was the functioning draft-and-tap arrangement before the explicit send request. |

**My recommendation is to retain the system and change the specific foundations above.** The distinguishing evidence is that useful services and retained records exist, while the demonstrated failures concentrate at role assignment, capability selection, decision handling, and acceptance.

Expected lower migration risk and faster recovery than a full rebuild are **hypotheses**, not measured estimates. The Inbox’s claim that rebuilding “would take weeks” was not supported by an estimate in the examined evidence.

A rebuild becomes justified if a bounded attempt to establish these boundaries shows that the existing owners cannot enforce them without pervasive duplication. That has not been demonstrated.

## 6. Additional findings

**The previous retrospective has not become a completed architectural repair.**

The September 25 latency investigation identified a 1,348-character update bookmark rejected by a 1,024-character intermediary limit, followed by roughly 23 MB of full data retrieval. It proposed replacing the unbounded read/update path and explicitly left implementation awaiting approval. [Retrospective, September 25, 18:16](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/earlier-retrospective-slowness-concierge3757.txt:587)

The checked main-branch source still contains that 1,024-character restriction and the fallback from an incremental-read error to the full read. This confirms that the specific failure path remains in source; it does **not** establish its current frequency in production. [Intermediary restriction](/root/workspace/thinkering/packages/adapters/src/session-owner-routes.ts:191), [client fallback](/root/workspace/thinkering/apps/web/src/session-cache.ts:506).

The lesson reached documentation, and the investigator later supplied design feedback. I found no approval and completed implementation of the proposed replacement in the examined material. A pending proposal should not be described as an implemented safeguard—or automatically blamed on an agent for respecting the approval boundary.

**Account switching shows a related failure in actual state ownership.**

The retained Codex evidence records refusal of a reused login-renewal credential while the application reported switching successfully. The investigation found credential copying and confirmation based on restarting the engine rather than proving that the selected account could operate. The reported repair remained unproven live at the end of its transcript. [Account investigation, September 29, 17:14–17:41](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/account-switching-concierge3895.txt)

For Claude, competing copies and renewal are a plausible explanation supported by the investigation, but the exact sequence that emptied the saved credentials is less firmly established than the router’s confident account suggested.

The required invariant is one authoritative renewal owner per login, preservation of the working login during a switch, and confirmation from the process that will run the work. Existing native account support should be used where it provides those guarantees. A credential-file label or engine restart is insufficient.

**A newly shipped email recovery path makes another unsupported inference.**

In the September 29 implementation, recovery after interruption checks whether Gmail still holds the draft. If it does not, the app marks the email sent. That code is present in commit `35466f6`. [Recovery logic](/root/workspace/thinkering/packages/adapters/src/email-send-scheduler.ts:55)

But Gmail drafts can also be deleted without being sent. Therefore, **missing draft does not prove sent message**. [Google draft-deletion documentation](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/delete)

This is a confirmed defect in the inference, not an observed cause of Sophie’s delay. Sophie’s eventual send has stronger evidence: Gmail returned a message carrying the Sent label in the intended thread. Recovery should require comparable positive evidence or preserve an uncertain outcome. It should never create another email merely to resolve uncertainty.

**Documentation still has unequal freshness.**

The supplied server copy of the messaging project’s instructions remains a short placeholder, while the Mac transcript contains extensive later manual updates. A server routing-check agent read that placeholder on September 29. This means “read the messaging agent’s instructions” does not necessarily give both machines the same operating knowledge. [Server copy](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/messaging-agent-AGENTS-server-copy.md), [routing check, 22:26](/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/email-routing-check-concierge3905.txt).

**The incident’s duration should not be repeated inaccurately.**

The retained check-in capture was recorded at 20:58:59 and Gmail records sending at 22:19:34: approximately **80 minutes**. The records examined do not establish three hours for this particular request. That does not diminish the failure; repeated retellings should not change its chronology.

## Ranked proposed changes

1. **Remove the unnecessary Mac dependency and separate correspondence from engineering.** Concierge owns routing; the server composer owns wording; thnkr.ing owns drafts and sending; the Mac supplies only device-dependent operations. Requires foundation approval.
2. **Make capability availability come from the service that owns the account and operation.** Preserve the map as discovery, but stop using prose as proof of readiness or missing credentials. Requires approval for the new contract.
3. **Preserve approved scope and decisions through every handoff.** Reuse existing request and decision records; reject repeated approval requests and unsupported widening. Requires foundation approval.
4. **Require outcome evidence proportional to the claim.** Distinguish discovered, implemented, deployed and exercised. Include interrupted-send recovery and actual account use. A bounded test-policy exception needs explicit approval.
5. **Constrain what the router may promote to a confirmed finding or human interruption.** Retain source evidence, uncertainty, outstanding decisions and worker limitations in the existing result flow. Requires foundation approval.
6. **Finish credential ownership and recovery without risking the working account.** Verify the already-reported account repair before treating it as solved; consolidate renewal ownership where duplication remains.
7. **Give retrospective remedies observable closure.** Carry the unresolved latency proposal, documentation freshness, and other accepted remedies in existing work records with owners and approval status. Additional instructions alone do not count as closure.

**Could not verify**

- Current end-to-end behavior with the Mac actually asleep; no live experiment was run.
- Whether the latest account-switching changes were subsequently activated and successfully used.
- Approval or completed delivery of the September 25 read/update replacement.
- Whether the email recovery defect has ever produced a false Sent result.
- The complete historical distribution of messaging instructions, or every earlier incident. Some rendered tool results were truncated.
- Comparative implementation costs or reliability gains for the proposed changes; these remain unmeasured.


