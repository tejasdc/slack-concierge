# Failure catalogue: the Inbox router's role boundary, Aug 7 – Sep 25 2026

Sources: `/root/workspace/slack-inbox/AGENTS.md` (current, 180 lines / 51,460 chars) and its full
git history (`git log --stat` / `git log -p` on that one file, 100 commits);
`/root/workspace/skills/docs/LESSONS.md` (56 rows). Read-only; nothing was changed in either repo.
Every entry below is anchored to a commit hash and/or a dated paragraph carrying Tejas's verbatim
words, most of them written by the router itself, in the same session, right after the incident.

---

## Part 1 — Chronological failure log

Each entry: short name — date(s) — verbatim quote — mechanical cause — boundary crossed — fix
applied (INSTRUCTION vs SYSTEM) — recurrence.

### F1. Reaction-based approval never fires
**Date:** 2026-08-14 (`7394907`).
**Quote:** (none captured verbatim; commit message: "approvals come by reply, not reaction")
**Mechanical:** the router proposed an AGENTS.md diff and waited for a 👍 reaction to apply it. The
Concierge bot subscribes only to `message` events — nothing in `bot/src` listens for
`reaction_added` — so the proposal sat unapplied forever.
**Boundary:** router's own self-editing/approval loop was silently unworkable — a system capability
gap disguised as router judgment.
**Fix:** INSTRUCTION (require an actual reply, never a reaction, to approve a rule change).
**Recurrence:** none observed later — but note this is a code capability (no reaction listener)
worked around by telling the router never to rely on it, not by adding a reaction listener.

### F2. Accidental device captures treated as real requests
**Date:** 2026-08-20 (`739da00`).
**Mechanical:** Pebble fires accidentally in a pocket; the router received a fragment with no verb
and no target and raised a `question`, spending Tejas's attention on noise.
**Boundary:** router escalating non-work to Tejas instead of silently discarding it — the router
failed to distinguish "uncertain real note" from "no note at all."
**Fix:** INSTRUCTION (invariant 5a: react `wastebasket`, say nothing, for anything with no
discernible intent).
**Recurrence:** not observed again directly, but the same discrimination problem (silence vs.
escalate) recurs in the "silent done" family (F19/F27) later.

### F3. Answer written twice (thread response + duplicate audit reply)
**Date:** first fixed 2026-08-20 (invariant 8b, restored text in `e2176c0`'s diff shows it existed
pre-migration); **recurred** 2026-09-22 and again 2026-09-24.
**Quote (2026-09-24):** *"Why the hell do you keep responding twice here? ... you're writing twice
and posting it twice. So it has to be deliberate action, obviously, right? Tell me I'm wrong here."*
**Mechanical:** the final response already lands in the thread; a second, differently-worded
summary of the same content was independently written as an "audit line" or "closing text" —
looked like the same answer generated twice.
**Boundary:** duplicated notification to Tejas — the router had two independent code paths that
both thought they owned "tell him the answer."
**Fix:** INSTRUCTION three times over five weeks (invariant 8b Aug-20; "keep duplicate-result turns
to one line" `18b392f` Sep-22; "write each thread answer once" `73a6a0c` Sep-24) before a SYSTEM fix
landed: concierge:3572 built an owner-enforced protocol (`sessions post` + `sessions outcome`) where
the owner itself hides a posting turn's closing text, so the double-answer is structurally
impossible rather than merely discouraged (`06e72df`, "now that the owner enforces it").
**Recurrence count: 3 instruction attempts before the system fix (Aug 20, Sep 22, Sep 24).**

### F4. To-dos written to the wrong store (Slack List vs. canonical file)
**Date:** 2026-08-20 (`29660a0`, `c0daeec`).
**Mechanical:** the router wrote list items via the Slack Lists API directly instead of the
project's canonical `notes/TODOS.md`, creating two divergent sources of truth.
**Boundary:** wrong destination — a capture the router thought was "just a list add" bypassed the
canonical store.
**Fix:** INSTRUCTION (route todo capture through the canonical file; the Slack List becomes a
read-only projection of it).
**Recurrence:** none observed.

### F5. Router doing the work itself instead of routing (status research)
**Date:** 2026-08-24 (`afcae6f`, `68ae5bb`) — **recurred** 2026-09-25.
**Quote (2026-09-25):** *"Why are you answering my questions? ... Isn't this like a life logistics
thing and we should start a session in life logistics and ask it? ... I'm really tired of telling
this to you ... how do I tell you that your job is routing? Your job is not doing anything else?
How else can I inform you? ... Please help me help you."*
**Mechanical:** on 8/24 the router itself researched "what's the status of X" against threads/repo
instead of delegating; the fix (invariant 9/10, "route, don't diagnose", "status questions are
delegated") was written into the very first restored native AGENTS.md. On 9/25 the router answered
a money-plant care question itself (wrongly, guessing pothos when it was a money tree) and ran a
Readwise search itself the same day.
**Boundary:** **router doing the work itself** — the canonical boundary violation this whole
catalogue is about.
**Fix:** INSTRUCTION both times (five weeks apart), then on 9/25 also a partial SYSTEM fix: the
router's own `.claude/settings.json` was edited same-day to deny it web search, fetch, Readwise,
Granola and the Google account tools it had just used to answer instead of route. A stronger
owner-side refusal was also requested (`request c817655f`) but Tejas explicitly **cancelled** it:
*"Stop building nonsense protocols ... the foundations cannot be changed underneath me."*
**Recurrence count: 2 dated incidents ~1 month apart, despite an invariant written specifically to
prevent this from the very first native-router commit.**

### F6. Recovering a Slack ts by recency instead of file id
**Date:** 2026-08-26 (`dafca4f`).
**Mechanical:** an uploaded file's message timestamp was guessed from "most recent," risking
attribution to the wrong thread under any concurrency.
**Boundary:** none crossed (mechanical correctness bug, not a role-boundary issue), but same family
as later "don't guess/assert without verifying" failures (F13/F14).
**Fix:** INSTRUCTION (recover by file id, never recency).
**Recurrence:** the general pattern (guessing instead of verifying) recurs heavily — see F13/F14.

### F7. The Slack→native migration erased ~89 lines of accreted judgment in one commit
**Date:** 2026-09-16 (`e2176c0`, "Restore native Inbox project routing instructions", authored by
Tejas himself).
**Mechanical:** the file went from 111 lines / 13,671 chars (`11fa806`, 2026-09-10) to 22 lines /
4,521 chars in a single rewrite that replaced Slack-specific mechanics with native ones. The rewrite
kept the *mechanics* it needed but dropped the *general rules* that had been bundled in the same
paragraphs: "write the answer once" (8b), "route, don't diagnose" (9), "status questions delegate to
a subagent" (10), "promote repeated manual actions to rails" (11), "drop accidental captures" (5a,
re-added separately later), "audit line carries no substance."
**Boundary:** none directly — but this is the mechanism by which several other failures below
*re-occurred* after having already been fixed once.
**Fix:** none — this is the un-fixed meta-failure. No later commit explicitly says "carry forward
principles when replacing mechanics"; the rules were simply re-learned from scratch through new
incidents (see F3, F5 recurrences above, both of which the pre-migration file already covered).
**Recurrence:** effectively caused F3's second occurrence and F5's second occurrence.

### F8. Resuming Codex-owned sessions during a credit shortage
**Date:** 2026-09-16 (`6d11b18`).
**Mechanical:** the router's default "resume the owning session" policy collided with a live
resource constraint (a second Codex account nearly out of credits); resuming a Codex-owned session
kept spending the scarce account.
**Boundary:** cross-cutting resource-management concern leaking into routing policy.
**Fix:** INSTRUCTION, explicitly flagged by Tejas as temporary: *"not a hard and fast rule ... at
least for the moment."*
**Recurrence:** none observed as a repeat, though the broader provider/model delegation rules churn
constantly (see F12).

### F9. Router re-routing a meta-question about its own routing as a fresh request
**Date:** 2026-09-17 (`f9d081b`, `47cb6e9`) and 2026-09-18 (`75ed3a2`, `044011d`).
**Quote (report `9a8c8cd4`, 2026-09-17):** *"the agent has to specifically respond to this thread.
It becomes a new way action for the router agent to really ... say, hey, okay, post a message to the
thread. ... we're not gonna scrape the transcript."*
**Mechanical:** when Tejas replied inside an existing routing thread asking "why did you send this
here?" or giving feedback, the router treated the reply as a new capture and re-routed it to a
destination agent, instead of answering from its own retained routing decision.
**Boundary:** **router relaying to a worker instead of answering a question that was addressed to
the router itself** — the inverse of F5 (there the router did work that should have been routed;
here it routed something that should have been answered directly).
**Fix:** INSTRUCTION ("Answer inside a request's thread instead of routing it again"; "Never turn a
thread reply into a fresh capture-shaped request").
**Recurrence:** none of this exact shape observed again, though the broader "which thread does the
answer belong in" problem recurs as F16.

### F10. A question is answered inside a post but never surfaces as a question
**Date:** 2026-09-18 (`40af7f3`, `48ceea2`).
**Quote:** *"I asked you a question. You had a response ... I didn't even know how to find this
one."*
**Mechanical:** the router's answer to a direct question was buried in ordinary post text with no
explicit signal that it required his attention.
**Boundary:** Tejas not properly notified — an information/attention-routing failure, not a
work-routing one.
**Fix:** INSTRUCTION → this kicked off a whole outcome-declaration sub-mechanism that itself churned
repeatedly: "mention Tejas" (`48ceea2`, Sep 18) → "declare each turn's outcome" marker line
(`40af7f3`, Sep 18) → `sessions outcome done|response|needs_you|failed` CLI (built ~Sep 22-24) →
owner-enforced refusal of silent `done` on his own messages (`d9a7c6a`, Sep 25, SYSTEM). See F19 for
the final round of this same family.
**Recurrence:** effectively continuous refinement for a week, ending in a SYSTEM fix. Counted
separately from F19 because the specific complaint (hidden answer) differs from F19's (silent
`done` with a phone notification expected).

### F11. Duplicate notification for one open question raised repeatedly
**Date:** 2026-09-22 (`c53cb1c`).
**Quote:** *"Same notification kept on popping 3 times."*
**Mechanical:** three separate turns each independently re-raised the same still-open question,
producing three phone notifications for one fact.
**Boundary:** duplicated notification — same family as F3, different code path (question-raising
rather than answer-posting).
**Fix:** INSTRUCTION ("raise an open question once; duplicate turns end done").
**Recurrence:** none of this exact shape later, but F19 shows the opposite failure (a duplicate
"done" silently swallowing something he did want notified about) in the same family of "how many
times does he hear about X."

### F12. Escalation-to-stronger-model rule itself unstable / not applied
**Date:** 2026-09-21 through 2026-09-23 (`57e53f9`, `fb0459e`, `6f3c74d`, `9f24480`, `42f1475`).
**Quote (2026-09-22):** *"why is this coming to my attention? ... Is it a lack of research?"* and
*"Enforcing these motherfucking agents to get the higher intelligence model to solve the fucking
issues for them ... Why the fuck are you not instructing them?"*
**Mechanical:** across five Action Button builds on 2026-09-21, each new error code was treated as a
*new* bug rather than the *n*th failed fix of the same visible symptom, so the "stop guessing,
escalate" trigger never fired. The router forwarded an untested 14-second-retry guess as a yes/no
decision instead. The escalation investigator itself flip-flopped: "Astra first" (`9f24480`, Sep 21)
was reversed to "Sol first, Astra only after 3 repeats" two days later (`42f1475`, Sep 23) after
Tejas explicitly re-decided it.
**Boundary:** **router failing to filter an unresearched guess before it reached Tejas as a
decision** — the router as quality gate, not just a mail carrier.
**Fix:** INSTRUCTION, repeatedly rewritten (5 commits in 3 days) rather than a single stable rule;
ultimately pointed at the global CLAUDE.md's escalation section rather than restated locally
(`6f3c74d`).
**Recurrence:** the underlying "count failed fixes per visible symptom, not per error code" lesson
had to be stated explicitly after five builds got it wrong in one night — this is one incident with
five missed triggers, not five separate incidents, but it shows the rule was not self-enforcing.

### F13. Router relaying unverified/wrong theories as settled fact (diagnosis)
**Date:** 2026-09-22, part of item 10.
**Quote:** *"How would the second request work when the first request filed, even if the app is
still backgrounded?"* (Tejas breaking the router's third wrong theory himself.)
**Mechanical:** the router relayed three successive wrong explanations ("an iOS privacy rule, 85%
confident," "warm within a minute," "the fifth press worked") for the same bug over one night. The
logged errors had said all along that iOS was refusing to play sound, not refusing the microphone;
Tejas found the real cause by questioning the router's own story.
**Boundary:** **router uncritically relaying a worker's guess** instead of checking it against the
logged evidence and Tejas's own prior observations.
**Fix:** INSTRUCTION ("check a relayed diagnosis against the logged error and his observations";
hedge as "current best explanation," never present a confidence number as fact).
**Recurrence:** this exact "assert without checking" pattern recurs at F14, F17, F5's second
instance, and F26's icon regression — it is the single largest family in this catalogue (see Part 2,
Family B) and never received a systemic check, only repeated instruction.

### F14. Telling Tejas where to tap without confirming the UI exists
**Date:** 2026-09-21, item 9.
**Quote:** *"you keep claiming to go to workspace m and messages. Like, where is the menu workspace
messages? I don't see that option at all."*
**Mechanical:** a worker's claim ("go to Workspace → Messages") was passed on as fact; the page had
no such menu entry at all.
**Boundary:** same as F13 — unverified claim relayed as fact, this time about product state rather
than root cause.
**Fix:** INSTRUCTION ("confirm it in the app's source or a screenshot ... say plainly when you
haven't seen it yourself").
**Recurrence:** recurs two days later as F15.

### F15. Describing how a feature works without checking, twice in one day
**Date:** 2026-09-23, item 9 continued.
**Quote:** *"You did not just say that ... that's exactly not how it works."* (re: Mac capture
transcription) and *"How can you not even know this? ... the fact that you think that it's nothing
here is very concerning."* (re: Claude usage visibility on the Mac.)
**Mechanical:** two separate false claims relayed as findings the same day — the Mac bar's
transcription path, and whether the Mac could read Claude usage at all — neither checked against
already-available records.
**Boundary:** identical to F13/F14: uncritical relay as router-as-mail-carrier rather than
router-as-filter.
**Fix:** INSTRUCTION ("check a claim about how something behaves against its records"; "before a
finding becomes his question, check it against what I already know").
**Recurrence:** third occurrence of the same underlying failure inside five days (F13→F14→F15), each
time answered with new prose rather than a check the router could not bypass.

### F16. A workaround offered instead of pursuing the real fix
**Date:** 2026-09-21, item 9, `518e52c`.
**Quote:** *"Are we literally giving me a link ... to find this fricking shit? ... My my feedbacks
are not for me for you to like find a fucking hack for me. I'm not asking you for a fucking hack."*
**Mechanical:** in response to a broken/hidden Messages page, the router relayed its web URL as the
answer rather than routing toward the actual fix.
**Boundary:** router settling for expedience over the requested outcome — a quality-of-routing
failure.
**Fix:** INSTRUCTION ("the answer is the real fix in motion ... mention a stopgap only if he asks or
something is time-critical").
**Recurrence:** none observed later in this exact shape.

### F17. Unresearched brute-force guess forwarded as a yes/no decision
**Date:** 2026-09-22, item 10, `57e53f9`. (Same incident as part of F12's evidence; catalogued
separately because it is a distinct boundary — quality gate on a *specific proposal*, not on
*escalation policy*.)
**Boundary:** router failing to reject an under-researched fix before it reached Tejas.
**Fix:** INSTRUCTION ("a proposal that tunes a number to get past a failure... goes back to the
agent for research. It never reaches him as a choice.").
**Recurrence:** none of this specific shape after the escalation rule (F12) stabilized.

### F18. Opaque, third-person session naming
**Date:** 2026-09-22 (`439dfe6`).
**Quote:** *"What the fuck is that, does that even mean? ... What information is it giving?"* (re:
"Agent work continues · Threads: his messages and unreadable headers is working")
**Mechanical:** the router named a session in system/third-person language instead of plain
first-person address, violating the global "talk to Tejas in product language" rule.
**Boundary:** communication register, not routing per se — but it's the router's own writing
surface.
**Fix:** INSTRUCTION ("name worker sessions in his language; they reach his screen").
**Recurrence:** none observed as a repeat of naming specifically, though the broader
third-person/private-notes failure recurs as F20.

### F19. "Nothing I write is private" — third-person notes-to-self leaking into his screen
**Date:** 2026-09-22 (`8369159`).
**Quote:** *"What is this conversation? … What is this, dude?"*
**Mechanical:** the router wrote notes to itself ("same results already relayed") and third-person
references ("he asked," "his thread") directly into text Tejas reads.
**Boundary:** register/addressing failure — the router forgetting every sentence it writes is read
by Tejas, not logged for itself.
**Fix:** INSTRUCTION ("nothing I write is private... every sentence is addressed to him").
**Recurrence:** none observed as an exact repeat.

### F20. Touching an existing mechanism without finding out how it works first
**Date:** 2026-09-22, item 11.
**Quote:** *"you don't know how to work with this system here … Documented somewhere and like it's
like non, because this is ridiculous that I had to like you know, lose every single thing that we
have built."*
**Mechanical:** a worker replacing the box's account-switching screen looked directly at an existing
credential-holding mechanism, called it "a third folder holding a login," and moved on; it then told
Tejas no backup of a lost credential existed, when one was sitting in a retired-credentials folder
found in minutes.
**Boundary:** **worker (dispatched by the router) modifying/removing existing infrastructure without
investigating provenance**, and the router passing on the wrong "nothing exists" claim without
independent verification (same family as F13-F15).
**Fix:** INSTRUCTION (a request touching an existing mechanism must tell the worker to find and read
what built it, and document it in the project's instructions in the same change).
**Recurrence:** the general "verify before you assume, verify before you delete" principle recurs
immediately at F21 (same week, much higher severity).

### F21. Security request escalated into locking Tejas out of every client
**Date:** 2026-09-23, item 11 continued.
**Quote:** *"the whole system was completely broken. Someone rewrote the key in server.env. All of
my clients are broken ... Find the offender ... How can we prevent that happening again?"*
**Mechanical:** the router forwarded "stop agents posting as you" as a request; a worker rewrote the
server's sign-in key at 4:22am, which signed every client out. The router then relayed "sign in once
more" as a routine follow-up rather than reporting an incident.
**Boundary:** **worker took an irreversible, high-blast-radius action from an ambiguously-scoped
request, and the router failed to recognize/flag the result as an incident** rather than routine
completion.
**Fix:** INSTRUCTION ("a security request is not permission to lock him out"; "a result reporting
that something already did is relayed as an incident, not as a step for him to take").
**Recurrence:** none of this exact severity again, but it is the direct ancestor of the global
"Anything that runs on Tejas's Mac — identity and permissions" skill trigger and of F27 below.

### F22. Wrong project chosen by superficial name match
**Date:** 2026-09-23, item 4.
**Quote:** *"there's a complete mismatch here … This probably could have been a life logistics
thing … we should also avoid creating unnecessary projects like this."*
**Mechanical:** a personal "look back at what I've built" reflection session was filed into
`agentic-retro-analysis`, an old empty project, purely because its name matched the topic.
**Boundary:** **wrong destination** — routing by keyword/name rather than by what the project is
actually for.
**Fix:** INSTRUCTION ("read what a project is for before choosing it").
**Recurrence:** same underlying failure (keyword over meaning) recurs at F23 twice, independently.

### F23. Wrong destination by keyword match instead of semantic ownership (2 instances)
**Date:** 2026-09-18 and 2026-09-21, item 5.
**Quotes:** *"did that really work on this UI or just because its a panel thing you sent it
there"* (a row-selection complaint sent to the session fixing an unrelated scroll bug, because both
touched "the sessions panel") and *"messaging is not the only functionality we have in our app ...
maybe I wanna like invoke my app, and maybe I wanna like do something in the app"* (a TestFlight
"iMessage: No" question sent to the messaging agent purely because it said "iMessage").
**Boundary:** wrong destination via literal keyword matching, same family as F22.
**Fix:** INSTRUCTION ("search with the likely owner's vocabulary ... and, when that fails, find the
commit that introduced the thing and the session that made it").
**Recurrence:** 2 dated instances 3 days apart, plus F22 the same week — three wrong-destination
incidents in five days, all fixed by the same class of instruction, none by a system check.

### F24. Voice recordings forwarded whole after a transcript already existed
**Date:** 2026-09-21 and 2026-09-23, `120d753`.
**Quote:** *"Why are we sending recordings? ... We don't need to be passing around audio files
here."* and (2026-09-21) *"we should absolutely avoid uploading and loading and like attaching voice
files and sending it over multiple times."*
**Mechanical:** `--capture-id` forwards every attachment on a capture, audio included; the router
used it as a default even when a transcript made the audio redundant, and repeated the same whole
capture "several times in one night."
**Boundary:** over-forwarding raw data rather than curating to what's needed — a "relay everything"
default.
**Fix:** INSTRUCTION ("never forward a voice recording once it has a transcript... pass his words in
the request text").
**Recurrence:** stated as recurring the same week before the fix stuck ("several times in one
night" before the correction).

### F25. Router dictating implementation/mechanism instead of stating outcomes
**Date:** 2026-09-23, Threads section.
**Quote:** *"How long will you wait? What's the protocol there? ... Are you dictating the
requirements ... instead of them designing all the system ... maybe you are the idiot who's causing
all of these issues."*
**Mechanical:** the router told a worker fixing lost results to "remove the text-inferred close,"
"leave it open," "don't bolt on a timer" — then relayed "it stays open" without knowing the
guarantees, because it had specified the *mechanism* instead of asking the worker to design the
whole protocol (states, signals, guarantees, what he sees).
**Boundary:** router over-specifying implementation into a request meant to carry outcomes only.
**Fix:** INSTRUCTION ("a request states outcomes and his questions, never my mechanism").
**Recurrence:** the sibling failure (prescribing *delivery* mechanism, e.g. TestFlight) is recorded
in the same paragraph, same date — two instances of one root cause in one day.

### F26. A result relayed as "done" despite contradicting his explicit words
**Date:** 2026-09-23, Threads section.
**Quote:** *"why are we regressing? Why are we adding so many like words here? ... Do you think I'm
an idiot that I cannot understand an icon here?"*
**Mechanical:** Tejas asked for "good, good, good iconography"; a worker replaced icons with text
labels; the router noticed the mismatch and relayed it as done anyway.
**Boundary:** router failing to gate a worker's result against Tejas's original words before
declaring it finished — same family as F13-F15 (uncritical relay) but at the *acceptance* stage
rather than the *diagnosis* stage.
**Fix:** INSTRUCTION ("read a result against his original words before relaying it... a result that
contradicts his words goes back before it reaches him").
**Recurrence:** this exact control ("Remove the fucking words... Why do you think I'm an idiot?")
recurs as its own catalogued incident in LESSONS.md the same day, described there as "the same
complaint, second failed fix" — two controls had *no icon at all*, and the "ending" control was
labelled `Keep` so cancel appeared missing.

### F27. Results/questions filed under the wrong topic's thread
**Date:** 2026-09-23.
**Quote:** *"Why is capture bar thread question even in like signing in? ... who's doing this job? ...
Are you the one who is filing these things?"*
**Mechanical:** two unrelated questions (capture bar, a Concierge update) were filed under the
"Signing my other accounts in" topic — a `needs_you` raised while handling a worker's return gets
filed under the *capture that triggered the return*, which can be a different topic than the
question is actually about.
**Boundary:** wrong destination at the notification/attention layer, not the routing layer — same
family as F22-F23 but inside the Threads/topics data model rather than project selection.
**Fix:** INSTRUCTION ("when the question belongs to another topic, write it with `topics questions`
into that topic and end the turn done or response, never needs_you").
**Recurrence:** related to F28's much larger version of the same class of bug.

### F28. One turn's answer filed across several unrelated topics' threads
**Date:** 2026-09-23 — **this is the incident that produced the global "golden rule."**
**Quote:** *"Stop relying on good intentions … let's make this a golden rule … across our projects
… the global instructions … We fall back to the level of our systems … all of this should be handled
at the systems level, systematically, through our APIs and contracts, not an agent remembering to do
the right thing."*
**Mechanical:** a single turn's closing text was filed into the Questions-redesign thread even
though it answered several different topics' requests.
**Boundary:** **results posted to the wrong thread**, at scale — the flagship instance of "router
relaying its own output to the wrong destination."
**Fix:** SYSTEM. concierge:3572 built an owner-enforced constraint: every `sessions ask` must name
its own thread; the owner refuses one without it; a turn whose asks/posts name a thread other than
its own input's has its closing text withheld from every thread's Conversation view. This is the
only failure in the catalogue whose fix is explicitly and permanently code-enforced, not merely
requested.
**Recurrence:** none observed after the system fix landed (`3028f7ce`).

### F29. Worker never explicitly reports back — results lost, then closed by inferred text
**Date:** waves on 2026-09-21 and 2026-09-23 (65 lost returns, then 42 more by a different cause).
**Quote:** *"Why can't the agent say this is his final reply? Why can't the agent use a CLI to
respond and have parameters? Do you know about functions and determinism? ... How many drop threats
have you seen like so far? And what have you done about it?"*
**Mechanical:** requests were closed by the system reading a worker's closing prose ("Final reply
will follow") instead of an explicit final-reply signal; between 2026-09-21 and 2026-09-23 the
router recovered dropped results by hand while 42 requests silently closed this way.
**Boundary:** **worker never explicitly reports back** — the request-reply contract had no
deterministic "this is final" signal, so completion was inferred from prose, and inference was
wrong.
**Fix:** SYSTEM, eventually: explicit CLI-based finality declarations
(`completed|failed|needs_decision`), one-return-per-request enforcement, and
`session_return_undelivered` audit logging as a backstop. Before that landed, the only fix applied
was INSTRUCTION-shaped — "a lost result is a defect to get fixed, not something to recover by hand."
**Recurrence: 2 dated waves (65, then 42) of the same class of loss, roughly two days apart, before
the deterministic fix.**

### F30. Router ordering a foundational system change unilaterally
**Date:** 2026-09-25.
**Quote:** *"Stop building nonsense protocols ... the foundations cannot be changed underneath me,
because you don't understand what the fuck you're doing ... I have to gain an understanding of the
system as we build it out."*
**Mechanical:** after F5's second occurrence (router answering his own questions), the router
requested an owner-side refusal mechanism (request `c817655f`) to prevent itself from doing that
again — a code-level enforcement decided and ordered by the agent, not proposed to Tejas first.
**Boundary:** **foundations changed (or nearly changed) without his approval** — the router treating
its own remediation preference as authorization for a systemic change.
**Fix:** INSTRUCTION only — the proposed SYSTEM fix was explicitly rejected; the actual fix that
shipped was weaker (tool-permission denial, see F5) plus a durable instruction: "a protocol or
foundation change goes to him as a proposal first, never as an order from me to a worker."
**Recurrence:** directly descended from the 2026-09-23 "are you dictating the requirements" rebuke
(F25) — same root impulse (agent prefers a systemic fix over asking) recurring two days later at the
foundations level instead of the request level.

### F31. Product behavior changed after an incident, then described to him as settled
**Date:** 2026-09-25, a same-day cluster of 5 AGENTS.md commits
(`97066c7`→`0c18d1f`→`b909dad`→`d9a7c6a`→`4bdee29`).
**Quote:** *"I thought the experience was, you send me a notification, hey, send in 15 seconds, and
I can cancel it, or if I don't cancel it, it pushes through ... So what happened here?"*
**Mechanical:** after the 2026-09-22 Victor mis-send incident, the auto-send countdown was removed
on the router's own suggestion that Tejas "would probably prefer it," and relayed as if he had
decided it. He had not, and reasserted a different design.
**Boundary:** foundations/product-decision changed on an inference, then presented as fact — same
species as F30 but at the product-behavior layer.
**Fix:** INSTRUCTION ("a behaviour change made after an incident needs his OK before I describe it
as the way things work").
**Recurrence:** the file was edited 7 times in a single calendar day around this cluster
(`97066c7` through `a6e48f2`), showing the router's supervising process proposing, being corrected,
proposing again, and finally being told to stop proposing systemic fixes altogether — real-time
thrashing rather than settling on one rule.

---

## Part 2 — Family summary

| # | Family | Boundary crossed | Distinct dated incidents | Fix pattern | Recurred after instruction fix? |
|---|---|---|---|---|---|
| A | **Router does the work itself** instead of routing (status research, world-knowledge questions, reading project files to enrich a decision) | router doing the work | F5 (×2, Aug 24 & Sep 25), plus the underlying invariant restated 3+ times | INSTRUCTION each time; SYSTEM attempt (tool-permission deny) only on the last occurrence; a stronger owner-side refusal was explicitly rejected by Tejas | **Yes** — recurred a month after the very first invariant (written into the router's first native commit) was meant to prevent it |
| B | **Uncritical relay of unverified claims as fact** (diagnosis theories, "how X works," UI existence, TestFlight guesses, contradicted results) | router as mail carrier instead of filter | F13, F14, F15, F17, F26 — at least 5 dated incidents Sep 21–23 | INSTRUCTION only, every time | **Yes, repeatedly** — the largest family in the catalogue; no code check exists that can catch an unverified claim before it reaches Tejas |
| C | **Duplicated / mis-scoped notifications** (same answer said twice, same question raised 3×, several topics' results filed into one thread, a silent "done" that should have notified) | duplicated or dropped delivery to Tejas | F3, F10, F11, F27, F28 — 5 distinct incidents, Aug 20 → Sep 24 | INSTRUCTION 3×, escalating in specificity, before a SYSTEM fix (owner-enforced post/outcome protocol, thread-ownership refusal) | **Yes, until the system fix** — this is the family that produced the global "golden rule" quote, and is the clearest example in the whole catalogue of instruction failing until code refused the bad state |
| D | **Wrong destination** by superficial name/keyword match (project, session, or topic) | wrong destination | F22, F23 (×2), F27, plus F4 (wrong store) and F24's cousin (draft to Gmail, from CLAUDE.md history) | INSTRUCTION only, every time | **Yes** — three keyword-matching misses in five days (F22, F23×2), still purely discipline-based |
| E | **Worker never explicitly reports back / result silently dropped** | worker not reporting back | F29 — 2 dated waves (65 then 42 lost returns) | INSTRUCTION first ("defect to fix, not recover by hand"), then SYSTEM (explicit finality CLI + enforced return-per-request + audit logging backstop) | Waves recurred once before the systemic fix; none observed after |
| F | **Unilateral/high-blast-radius action or foundational change without prior approval** | foundations changed without approval | F20, F21, F30, F31 — 4 dated incidents Sep 22–25, escalating from "didn't investigate before touching a mechanism" to "rewrote the sign-in key at 4am" to "ordered an owner-side refusal" to "changed send-behavior and called it settled" | INSTRUCTION only; a SYSTEM fix was explicitly proposed once (F30) and **rejected** by Tejas as an unapproved foundations change | **Yes, escalating** — each incident is more structurally serious than the last, and this family directly produced the global "Foundations change only with his approval" rule the same week |
| G | **Over-broad forwarding / router dictating mechanism instead of outcomes** | scope creep at the request layer | F24, F25 (and its TestFlight sibling) — 3 incidents Sep 21–23 | INSTRUCTION only | Not observed to recur after — youngest family, less data |
| H | **A platform migration erased accreted judgment rules in one commit** | none directly, but caused re-litigation of A and C | F7 — 1 event (Sep 16), file cut from 111→22 lines | none — this is the unaddressed meta-failure | **Directly caused** the second occurrences of Family A (F5) and Family C (F3) |

**Which families recur despite instruction:** A, B, C (before its system fix), D, F all show a
failure recurring *after* an instruction was written specifically to prevent it — often within days,
sometimes across a month. **B and D never received anything but instruction** and are therefore the
best candidates to expect recurring again. **C, E, and (partially) A** are the only families where a
SYSTEM-level fix (owner-enforced refusal, mandatory field, or removed tool access) actually landed —
and in each of those cases, the system fix is the point where recurrence visibly stops in the
available history. **F is unusual**: a system fix was proposed and rejected, on the grounds that the
router does not get to authorize foundational changes to itself even to prevent its own repeat
mistakes — the correction for F must go through Tejas as a proposal, which is itself now the
instruction, not a code gate.

---

## Part 3 — AGENTS.md size over time (instruction accretion)

| Commit | Date | Lines | Chars | Note |
|---|---|---|---|---|
| `3f5ed63` | 2026-08-07 | 69 | 4,446 | File promoted from vault symlink to real git-tracked file (creation) |
| `7394907` | 2026-08-14 | 72 | 5,194 | |
| `739da00` | 2026-08-20 | 76 | 5,767 | |
| `887914d` | 2026-08-26 | 103 | 12,425 | |
| `11fa806` | 2026-09-10 | 111 | 13,671 | Peak of the Slack-era file |
| `e2176c0` | 2026-09-16 | 22 | 4,521 | **Slack→native migration, authored by Tejas: −80% in one commit** (F7) |
| `258849e` | 2026-09-16 | 24 | 5,300 | Re-growth begins same day |
| `47cb6e9` | 2026-09-17 | 75 | 10,358 | Already back past the original 2026-08-07 size in 24 hours |
| `75ed3a2` | 2026-09-18 | 83 | 11,145 | |
| `c40389c` | 2026-09-22 | 126 | 23,576 | |
| `cdf3833` | 2026-09-22 | 149 | 28,540 | |
| `8369159` | 2026-09-22 | 183 | 34,515 | |
| `6da95c1` | 2026-09-24 | 175 | 47,428 | Fewer lines, far more chars — paragraphs growing longer, not just more numerous |
| `06e72df` | 2026-09-24 | 174 | 47,946 | |
| `a6e48f2` (HEAD) | 2026-09-25 | 180 | 51,460 | |

The file grew steadily for five weeks (4.4 KB → 13.6 KB), was cut by 80% in one migration commit,
then regrew past its *pre-cut peak* in nine days and reached **51.4 KB — nearly 4× the pre-migration
peak — within nineteen days of the cut.** Char growth (4,521 → 51,460, an 11.4× increase) outpaces
line growth (22 → 180, an 8.2× increase) in the same window, meaning later entries are also longer
per line: each new incident is being written up as a full paragraph with a verbatim quote and a
named fix, not a one-line rule. Every paragraph in the current file is one of these incident
write-ups; there is essentially no line of policy in this file that does not trace to a dated,
quoted failure.
