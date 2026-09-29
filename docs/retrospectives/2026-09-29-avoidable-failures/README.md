# Why the agent system keeps producing avoidable failures: retrospective, 2026-09-29

**TL;DR:** You don't need to scrap everything. The parts work, and once someone pointed at the right connection your email to Sophie went out in six minutes. What keeps breaking is the layer that coordinates them: who does what, which machine it runs on, what counts as your decision, what counts as true, what gets passed on to you, and what counts as done. For eight days each failure in that layer has been "fixed" by adding a sentence to an instruction file, so the same failures come back. This report names seven causes and the system change for each. Five of those changes alter the foundations, so they need your approval before anything is built.

Status: approved the same night and built; see [what was built](BUILT.md). Three investigators worked on this independently: GPT-6 Sol, GPT-6 Astra and Claude Fable 5.1. Each read the original transcripts and never saw the others' conclusions. Their full reports are in this folder, and the brief they were given is `investigator-brief.md`. They all read the same records, so where they agree it is three readings of one set of evidence, not three separate witnesses. Where it mattered, I checked their key claims against the records myself.

---

## 1. What happened this evening

- **8:59 pm (all times are server time, UTC):** from your Watch you said "send it right away" about the Sophie check-in.
- **9:01:** the messaging agent is a conversation running on your Mac. It checked the capability map and concluded that "your Sept 24 rule" forbids sending email from the server. It then asked the Mac thnkr.ing session to act.
- **9:08:** the Mac thnkr.ing session said that thnkr.ing's Google connection was live and allowed to send. It also said the app had no send button yet, and that adding one would be "a foundation change" needing your approval. So it offered you a paste-it-yourself fallback. The Inbox passed that on, together with a design question for you.
- **9:41:** you said "Yes, build that out." The Inbox then told the agent to write a proposal first. The agent came back asking for approval again and asking how long the cancel window should be. You had answered that on Sept 25.
- **10:05:** the agent built on a second Google route that has never been signed in on either machine. The Inbox sent you a credential form.
- **10:12:** you said "my word is a command." It was rewired to thnkr.ing's existing connection, and **the email left at 10:19:34 pm.**

It took about 80 minutes from your request to the send, not three hours. That doesn't make it acceptable: three of your nine "needs you" questions today were in this one thread, and your own words already answered every one of them.

Two corrections to how this has been described, because the fixes depend on them:

- **The Gmail connection was working.** thnkr.ing's own connection, signed in on the server, is what finally sent the email. What was broken was *how it was described*. The capability map listed a second Google route that no one had signed in, and it carried a "only your tap sends" line. The thnkr.ing instructions still said "email is never sent from here".
- **Email doesn't run on the Mac.** The drafts, your Google connection and the send all live on the server. Only the messaging agent's *conversation* is on the Mac, and every call it makes goes over the network to the server. That one placement is why a sleeping laptop blocks email.

## 2. The root causes

### Cause 1: Roles are assigned by topic, not by what an agent owns

**Evidence (all three investigators agree).** On Sept 21 you asked for one messaging agent and said "any feature requests, anything that we want to build for the messaging agent also should be handled by that same agent." The Inbox turned that into "own the messaging features: how sending works, the Messages page in Thinkering, and email later."

But the messaging project contains no code. So "owning features" meant the agent wrote build instructions for the thnkr.ing session and overrode the code owner's knowledge. Tonight its build instructions said "do not use thnkr.ing's own Google connection; use the other route." That was the unsigned one. Two builds were thrown away within the hour.

The flashcard grader followed the same pattern. It is a grading conversation, yet it rewrote cards and redeployed the deck *inside* your study session. That is why your answer sat for four minutes.

**The system cause.** Nothing in the system knows what a session's role is. Any session can be handed build work, and the router chooses by topic. You narrowed the messaging agent's role tonight, but only in a sentence; the owner still accepts build requests to it.

**Honest note.** The Sept 21 wording ("anything we want to build … that same agent") was yours, so the agent wasn't inventing its mandate. The failure was that nobody separated *writing and sending* from *building the machinery*, and the system has no way to enforce such a split.

### Cause 2: The machine is chosen by keywords and habit, not by what physically needs it

**Evidence (all three agree; I checked it myself).** At 4:48 am on Sept 21 the Inbox told you: "I start the one messaging session on your Mac, where Messages lives." You never named a machine. The router's standing instructions say to send work to the Mac when it mentions iMessage, Xcode, Finder or another Mac app. With no such signal, they say to use "the machine the most recent session in the same project folder ran on". So the choice was made once by keyword and has stuck ever since. Email was added to that agent later, and no one reconsidered where it runs. Today the global instructions and the capability map both send every drafting request to that Mac session.

**What actually needs the Mac.** Only sending texts through the Messages app, and reading who you text. That is done by a small relay program on the Mac, not by the agent. Everything else runs on the server: writing in your voice, drafts, your Google connection, sending email, recipient lookup and notifications.

### Cause 3: Agents' stopgaps get recorded as your decisions, then treated as walls

**Evidence (Fable traced this; Astra found the same pattern; I checked the key steps).**

1. Sept 22: the 10-second cancel failed on a text. The messaging agent decided on its own that until the cancel was fixed, only your tap would send.
2. Sept 25: the Mac thnkr.ing session wrote this into the code as a permanent safety rule. The messaging agent then told you: "**The safety rule you installed** after the September 22 cancel-tap incident…" You had installed no rule. When you asked why it wasn't sending automatically, you accepted tap-to-send "for now, until we gain some confidence." In the records, "for now" became "his choice".
3. Sept 24: you said the Gmail composer was useful for its editing tools "until we build our own." The thnkr.ing instructions recorded that as "An email is not sent from here at all (Tejas, 2026-09-24)."
4. Sept 28: an agent removed the send-mail permission from your Google connection. Its note said "no code calls Gmail's send", and the permission was later described as removed "by his decision".
5. Sept 29: every agent in the Sophie chain quoted "his Sept 24 rule" as the reason it could not send.

**The system cause.** No record separates four kinds of decision: one you made permanently, one you accepted for now, one an agent made and told you about, and one an agent made silently. Your quoted words are treated as the highest authority, and agents quote each other's paraphrases. When a long conversation is condensed to fit its memory, these paraphrases survive as bare facts, with no source.

### Cause 4: Knowledge lives in several places that disagree, and nothing checks them against reality

**Evidence (all three agree).**

- The capability map gave Google two homes: the thnkr.ing connection, and a command-line route signed in nowhere. The messaging agent did read the map, then picked the wrong row. Astra points out this means the failure wasn't "forgot to look"; the thing it looked at was wrong.
- The map also carried the "only your tap sends" wall from Cause 3.
- The messaging agent's own manual has been edited about 70 times, but only on the Mac. The server copy is still the seven-line placeholder from Sept 21, and a server agent read that placeholder during today's "successful" check.
- The thnkr.ing instructions went on saying "email is never sent from here" for 27 minutes after send-now had gone live.

**Why the "discovery test" passed** (all three agree on the facts). This morning's test asked fresh agents three read-only questions: is the tools project on both machines, is Spotify connected, and who keeps a *text* draft. It asked nothing about email or Gmail, and it never tested the real messaging agent on the Mac. "Pass" meant the agent found the row the map pointed to. It never meant the row was *true*. An agent that followed the map faithfully would have done exactly what the messaging agent did at 9:01. The second check tonight ran after the map was corrected: three agents described the right route, but they were told not to use it, and they still routed drafting to the Mac.

### Cause 5: The Inbox passes things on instead of judging them, and repairs itself with one sentence per incident

**Evidence (all three agree).** Today the Inbox relayed:

- the paste-it-yourself fallback;
- a design question, then a request to approve something you had already approved;
- the credential form;
- "nothing is wrong" about the flashcards repeating every six minutes, which came from a worker that had checked the settings but never looked at your actual queue;
- "the grader was busy", which was right about the symptom and wrong about the cause;
- "remove every account notice", which the Inbox itself admitted three minutes later you hadn't asked for.

After each one, the Inbox added a rule to its own instruction file. There were eight new rules today. The file has grown from about 660 words when it began to about 9,700 words today, over 110 changes, and most of its rules each describe a single incident. The rule against losing uncertainty dates from Sept 22 and still failed today.

The lessons log shows the same thing: most of today's entries are marked "said before: yes".

On Sept 25 the router was also denied the tools it would need to check a connection. Today's rules tell it to "check whether any existing connection can do it", which it cannot do.

### Cause 6: "Done" is claimed from checks on copies and tests, and your own use is the real test

**Evidence (all three agree).**

- The flashcards launch said "your first real answer tomorrow will be the first live run of the real grader".
- Account switching was reported fixed with "nothing has been tested live on the new version yet", and it asked you to do two sign-ins.
- An account fix was called "shipped" while the update was still waiting to install.
- One "live screenshot" was a hand-made page rather than the app.
- The notice cleanup reported 218 places changed but never looked at the update notice, whose buttons broke.

Astra adds a fair counterpoint: several workers did separate "shipped" from "proven live" honestly. The rules for what counts as done are simply inconsistent.

**The tension here is yours to settle.** Your Sept 15 instruction forbids agents from running any tests on Concierge, and it names you as the person who does the end-to-end testing. Workers read that as "don't verify", and the result is that you are the first person to exercise every change.

### Cause 7: Two of your rules collide, and every agent settles the collision by asking you

**Evidence (Fable; the Sophie timeline confirms it).** The Sept 25 rule "foundations change only with his approval" is what made the Mac thnkr.ing session refuse to add a send button at 9:08. It is also what made the Inbox demand a proposal at 9:41, after you had said "build it". Tonight's "my word is a command" points the other way. Nothing defines which changes count as foundations, so an agent unsure which rule applies asks you.

## 3. The changes, one per cause

Each change below is a system, not a sentence: either something that refuses the wrong action, or a source of information that is generated and checked instead of hand-written. **"Foundation" means it changes how sessions, requests, machines, permissions or questions to you work, so under your own rule it needs your approval before anyone builds it.**

| # | Cause | Change | What you'd notice | Foundation? |
|---|---|---|---|---|
| 1 | Where things run | **Move the messaging agent to the server. The Mac keeps only the texting relay.** A session goes on the Mac only when its work declares a need the Mac alone can meet, such as sending texts, Xcode or screenshots. The keyword rule and the "same folder, same machine" habit are retired. | "Email Sophie" works with your laptop shut. A text while the Mac sleeps is written straight away and waits only for the delivery step. | **Yes** |
| 2 | Roles | **Sessions carry a role that Concierge enforces.** A session that *writes and sends* cannot be handed build work; Concierge refuses and names the project that owns it. Build requests about drafts or sending go to the thnkr.ing project. | The messaging agent writes your messages and never again redesigns the system. | **Yes** |
| 3 | Your decisions | **One decisions record, with who decided and how firmly.** Each entry holds your exact words, the date, its scope, and one of: *permanent*, *for now*, *agent's choice*. Instruction files cite an entry, and a line saying "Tejas decided…" with no entry behind it is refused when it's saved. A *for now* or *agent's choice* entry is never a wall: an agent that hits one goes ahead and tells you. | Nothing is blocked by a "rule" you never made. | **Yes** (it changes what counts as approval) |
| 4 | Knowledge | **A capability map that is checked, not written by hand.** Every row has a live check, such as "is this account signed in" or "does this session answer", run on both machines on a schedule. A row that fails its check cannot be offered as a route. Two rows claiming the same account are refused. The discovery test becomes one real request per row, sent to the real session that handles it, and a credential request or question to you counts as a failure. | Agents stop "discovering" routes that don't work. | No |
| 5 | Questions reaching you | **A question can only reach you with your own words attached.** A worker's "needs a decision", a fallback, or a credential form carries the words of yours that started the work, plus a filled-in "why these words don't already answer it". Concierge refuses the question without them. (This is your own Sept 25 idea: "if you make a field mandatory … you are forced to answer it.") Sol's caution applies: no mechanism can *prove* intent. But making the check a required field makes it happen, and makes it visible when it doesn't. | Far fewer questions, and each one says why only you can answer it. | **Yes** |
| 6 | "Done" | **"Done" says what was actually proven:** found, built, installed, or used live, in those words. **Your decision:** may agents run a real check through their own marked entrance (it shows as the agent, not you) before telling you something is done? That would narrow your Sept 15 "no agent tests" rule. | Fewer "fixed" reports that you then find broken. | **Your call** (a policy change) |
| 7 | Rule collision | **Define "foundation" as a short list:** how sessions, requests, threads, outcomes, notifications, permissions and machines work together. Adding a feature you asked for, such as a send button, is never on that list. Everything else follows "your word is a command". | Agents stop asking permission to do what you told them to do. | **Your call** (it's your rule) |
| 8 | The sentence machine | **Stop adding a rule per incident.** Changes to the Inbox's own rule file get reviewed and the file gets a size cap. The roughly 50 one-incident rules get folded into changes 1–7 and then removed. | The Inbox behaves more predictably. | No |
| 9 | Follow-through | **Every accepted change from a retrospective becomes a tracked item with an owner.** The Sept 25 slowness retrospective proposed fixing the cause of the slow page loads. Nothing was built: the length limit that triggers the slow full reload is still in the code. | This report doesn't become another file nobody acts on. | No |

**A defect found in today's email work (Astra found it; I confirmed it in the code).** If the server restarts in the middle of sending an email, the recovery step checks Gmail for the draft. If the draft is gone, it records the email as **sent**. But a draft can also disappear because you deleted it. The fix is to look for the actual sent message, and to say "not sure, check your Sent mail" when it can't be found. This is small and doesn't touch any foundation. I have not changed it, because this task was investigation only.

## 4. Should you scrap everything and start from scratch?

**No. All three investigators reached this independently, and the evidence supports it.** The goal is for the work to get done without you having to step in, while keeping your history, preferences, drafts and control over anything that goes out to people.

| Option | Where it wins | Where it loses |
|---|---|---|
| **Scrap and rebuild** | Starts clean, without accumulated contradictions such as a 9,700-word rule file or three instruction files that disagree. | It rebuilds parts that work: drafts, calendar, Spotify, flashcards, threads, accounts, and your whole conversation history. The failures are in coordination, not in those parts, so a rebuild repeats them unless changes 1–7 are designed first, and those can be made on the current system. Last week's retrospective proposed replacing one layer and it never got built, so a whole rebuild has worse odds. How long a rebuild would take hasn't been estimated; "weeks" is a guess. |
| **Keep it and change the foundations above** | It fixes the places where the failures actually happen, and each fix is a refusal or a generated check, which is what your "systems, not good intentions" rule asks for. The parts stay. | It needs your approval on five proposals, and the pattern continues until they're built. The effort hasn't been measured. |
| **Keep it as is** | Costs nothing now. | Today's fixes are eight more sentences in a file that already holds about 50 of them. The lessons log shows each complaint coming back after its sentence was added. |

Astra adds when a rebuild *would* become the right answer: if building changes 1–5 shows that the current system can't enforce them without duplicating itself everywhere. Nothing seen so far shows that.

## 5. Your messaging when the Mac sleeps, and what should run where

**Today, confirmed from the records but not tested live with the Mac asleep:**

- **Email or a draft:** your request goes to the messaging agent's conversation on the Mac. While the Mac sleeps, Concierge holds the request and delivers it when the Mac wakes. **You are not told.** Since Sept 27 a sleeping Mac is deliberately never a notification. The Inbox gets a note after 30 minutes and decides whether to tell you. So the email waits, silently, even though everything needed to send it is on the server. An email that is already scheduled to send doesn't need the Mac.
- **Text messages:** these genuinely need the Mac, because they go out through its Messages app. When the Mac is away, the draft comes back to your phone and you can send it with one tap. That part already exists.

**What should run where (proposal, change 1):**

| On the server, always on | On the Mac, only this |
|---|---|
| The messaging agent: writing in your voice, your preferences, who's who | The small texting relay that hands a message to the Messages app |
| Drafts, and the ready and sent notifications | Reading who you text recently, for name matching |
| Your Google connection, sending email, calendar | |
| Deciding who a message goes to | |

With this split, "email Sophie" never waits for the laptop. A text is written straight away and waits only for delivery, and your phone can send it in one tap if the Mac stays asleep.

## 6. Where the investigators agreed and where they differed

**All three agreed:** the Inbox chose the Mac on Sept 21 because "that's where Messages lives", and only texting needs the Mac. The discovery test didn't cover email. The Inbox passes things on and changes their meaning. "Done" is claimed without a live check. Don't scrap.

**Found by only one or two:**

- Fable found that agents' stopgaps turn into "your rules" (Cause 3), traced the colliding foundation rule (Cause 7), and noticed the Inbox has been denied the tools its new rules require.
- Astra found the email-recovery defect, the 80-minute rather than three-hour timeline, and that the Sept 25 slowness fix was never built.
- Sol found that a Gmail tool one server session had on Sept 28 was gone by Sept 29, so what an agent can reach varies from session to session, and the map can't show that.

**Where they differed:**

- **How hard to enforce.** Fable proposes that Concierge refuse outright: questions to you without your words, "done" without a check, build work sent to a writing agent. Sol is more cautious: intent can't be proven mechanically, so it wants effects and evidence recorded as distinct states rather than a blanket refusal. Astra is in between, preferring to take a power away from an agent over telling it not to use it. My recommendation above follows Fable's refusals, with Sol's caution noted on change 5.
- **Live checks by agents.** Fable says retire "you own live testing". Sol and Astra say that is your policy to change. I agree it's your call (change 6).

## 7. What still isn't known

- How it behaves live with the Mac asleep. This comes from the records and the design, and was not tried.
- The messaging agent's full current manual on the Mac. Only its edits appear in the transcript.
- Which session removed the send permission on Sept 28. The commit carries the shared identity.
- Whether today's account-switching fix works on the installed version, and whether your two sign-ins were done.
- How much each change costs. None of it has been estimated.

---

Evidence: the three investigator reports in this folder cite the original transcripts line by line. The rendered transcripts they read are temporary copies. The originals are in the transcript archive: the Inbox, the Mac messaging agent, the Mac thnkr.ing session, the capability-map session, the flashcards and grader sessions, and the account and notice sessions.
