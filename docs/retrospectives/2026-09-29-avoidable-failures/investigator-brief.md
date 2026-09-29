# Independent retrospective investigation — brief (read-only)

You are one of several independent investigators. You have NOT been shown anyone else's
conclusions, and you must not look for them (do not open any file under
`tmp/reviews/retro-2026-09-29/` other than `brief.md` and the `sources/` folder). Work
READ-ONLY: do not edit, commit, push, start sessions, send messages or run any command
that changes state. Reading files, grepping, `git log`/`git show`, and web research on
official documentation are all fine.

## Who and what

Tejas is one person running a personal agent system across two machines: a Linux server
("the box", always on, where this checkout lives) and his MacBook ("the Mac", a laptop that
sleeps). Concierge (`/root/workspace/slack-concierge`) owns sessions, requests and
routing; Thinkering / thnkr.ing (`/root/workspace/thinkering`) is the app he uses. A
long-running "Inbox" Claude session (router, project `/root/workspace/slack-inbox`) reads
his captures and dispatches work to other agent sessions, relaying their answers to him.
Standing instructions live in: the global file (`sources/global-AGENTS-current.md`, which
is `~/.codex/AGENTS.md`), per-project `AGENTS.md` files, skills in `/root/workspace/skills`
(notably `capability-map-skill`), and the Inbox's own `AGENTS.md`.

## His words (verbatim, 2026-09-29 evening)

"And the. And 1st of all, why is all of these messaging agents, email agents building this
out, everything is in a Mac. Everything is in Mac, a place that we know is not reliable
because it's a fucking laptop. You literally built the messaging agent session on a fucking
MacBook? What the fuck happens when my macopus licked sleeping, and I want to send an email.
I just want how to wait until my macupurio reopens? Who decided this? Who decided this? What
is happening in our system? What is happening? No, the sneak requires a complete
retrospective. Second opinion, 3rd opinion, 4th opinion, get, get fucking all the fucking
intelligent guns here … we need to figure out why the stupidity is happening in our system.
This is enough stupidity for one day. let alone for me to like, you know, build, like, you
know, see past few days. We definitely have to pass, look through your entire history here,
because this is an unacceptable level of stupidity. And this is giving me more work than I'm
supposed to get there, get out of it. We literally fucking cleaned up our system to make sure
the capabilities and abilities are in one place and like agents are able to discover and all
of that nonsense and you only to come back in the next date for you to make this fucking
mistake. For you to claim that every agent, we did a dry run, like, you know, they were able
to discover this fucking capabilities, to come back and send me these agents, discovered a
Gmail connection, which is not working. After a day after we were built, after a fucking day
of build, and you to go ahead and like start a session in a fucking MacBook. What the fuck is
going on here, dude?"

Earlier the same evening: "why is a fucking messaging agent working on building things? … A
messaging agent's job is to draft messages in my fucking voice. Not to build a system …
Should I scrap every single thing and debate from scratch here?" And: "My word is the command
… Your job is to figure out how the fuck to make that happen and make it happen."

## Incidents the requester listed (claims to verify against the sources, not facts)

Today the Inbox router reportedly relayed to him: a paste-it-yourself fallback, a design
question, a re-approval question, a credential form, a wrong "the grader was busy"
diagnosis, an overstated "remove all account notices", and a "nothing is wrong" about
flashcards repeating every 6 minutes. The Messaging agent reportedly explained (Sophie
thread) that it treated a Sept 24 choice as a wall and that the capability map gave Gmail
two homes. The capability-map / global-instructions refactor (concierge:3865, 2026-09-29)
reportedly passed a "discovery test", yet the same day an agent picked the wrong Gmail path.

## Raw sources

Rendered transcripts (verbatim text; tool calls/results truncated, timestamps UTC) in
`/root/workspace/slack-concierge/tmp/reviews/retro-2026-09-29/sources/`:

- `inbox-router-concierge3172-since-0926.txt` — the Inbox router, Sept 26–29 (start here).
- `inbox-router-concierge3172-before-0926.txt` — the Inbox router Sept 16–25 (12 MB; grep it).
- `inbox-AGENTS-md-history.txt` — every change to the Inbox's instructions, with diffs.
- `messaging-agent-mac15.txt` — the Messaging agent (Claude, on the Mac, since Sept 21).
- `messaging-agent-AGENTS-server-copy.md` — its project instructions as created.
- `thinkering-mac6-notifications-and-sending-since-0924.txt` — the thnkr.ing Mac session
  that built email sending (mac:6).
- `email-sophie-server-concierge3844.txt`, `email-routing-check-concierge3905.txt` — email
  work run on the server by Codex.
- `capability-map-refactor-concierge3865.txt`, `capability-map-skill-history.txt`,
  `capability-map-SKILL-current.md`, `capability-map-references/`, `global-AGENTS-current.md`.
- `flashcards-concierge3885.txt`, `flashcard-grader-concierge3890.txt` — flashcards.
- `account-switching-concierge3895.txt`, `usage-limits-account-notices-concierge3626-since-0927.txt`,
  `thinkering-session-flow-notices-concierge3265-since-0927.txt` — account switching,
  account notices, notice unification.
- `earlier-retrospective-slowness-concierge3757.txt` — a retrospective from Sept 25 on a
  different complaint; check whether its recommendations were acted on.
- `skills-LESSONS.md` — the lessons log agents append to after he gets emphatic.

Full raw JSONL, if you need what the renders truncated: `/root/.claude/projects/`,
`/root/.codex/sessions/`, and the append-only archive `/root/transcript-archive/`
(`claude-projects/`, `codex-sessions/`, `mac-claude-projects/`, `mac-codex-sessions/`)
holding both machines' history. Code and docs: `/root/workspace/slack-concierge`
(`AGENTS.md`, `docs/`), `/root/workspace/thinkering`, `/root/workspace/slack-inbox`,
`/root/workspace/skills`, `/root/workspace/command-line-tools`, `/root/workspace/messaging-agent`.

## Questions

1. What are the root causes of the recurring, avoidable failures — as system causes (roles
   and scope of agents, where things run, how knowledge is found and kept current, how the
   router relays and what it lets through to him, how work is verified before it is called
   done)? For each, cite concrete evidence (file + timestamp or commit) from the sources.
   Distinguish confirmed from inferred. No blame theatre.
2. For each cause, what change would make the failure impossible or loudly refused (a
   system, not a new sentence asking agents to be careful)? Which of these change the
   foundations (how sessions, requests, threads, outcomes, notifications, permissions and
   machines work together) and therefore need his approval first?
3. Why does the messaging agent live on the Mac? Find who decided and when, and the reason
   given. What part of messaging physically needs the Mac (e.g. iMessage/SMS through the
   Messages app) and what could run on the always-on server? What happens today when he
   asks for an email or a message while the Mac is asleep?
4. Why did the capability-map "discovery test" pass while an agent chose a broken Gmail path
   the same day? What would a test that catches it look like?
5. "Should I scrap everything and start from scratch?" Compare at least: scrap and rebuild;
   keep and change specific foundations; keep as is. Say where each wins and loses, with
   evidence, and label unmeasured claims as hypotheses.
6. Anything else you find that the requester did not list but that explains the pattern.

## Output

A single Markdown report, evidence-cited, organised by the questions above, ending with a
ranked list of the proposed changes (highest impact first) and a short list of what you
could not verify. Be direct; disagree with the requester's framing where the evidence says
so.
