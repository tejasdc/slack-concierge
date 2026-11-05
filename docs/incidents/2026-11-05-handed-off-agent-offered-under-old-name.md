---
failure: In an Inbox thread, Control-Space and the reply box listed the agent he had been talking to for hours under the name of the session it had taken over from, so he could not find it.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# The Slowness thread coordinator was missing from Control-Space

## What was seen

Nov 5, about 3:50 AM ET, thread "A server that stays responsive while agents work", web build
7b335de on his Mac (Tejas: "the Slowness thread coordinator is not appearing in the Control-Space
menu. How has this happened? How does this keep happening?"). Every message in the thread since
06:11 UTC is signed "Slowness thread coordinator (continued)" (concierge:8683).

## Cause

concierge:8586 answered in the thread, then handed its conversation to concierge:8683. The
handoff repair (`02c53316`) merged the chain into one choice and named it after the predecessor
whenever the predecessor had answered in the thread, permanently. So 8683, which wrote every
later message, was offered as "Why the server slowed today and a design that keeps it fast".
Confirmed from the live reply-choice read (one choice concierge:8683 under 8586's title, the
default) and the thread's entries (every post since 06:11 signed with 8683's own title).

## Fix

Each choice is named as its newest message in the thread is signed: the title of the session
that wrote that agent's newest post. The predecessor's name holds only while the predecessor's
message is still that agent's newest one. `prepared-topics.ts` recomputes stored threads once
(`choice_named_as_signed`).

## Acceptance scenario

- **Seed:** session A posts in a thread, hands off to B, then B posts.
- **Action:** read the thread's reply targets.
- **Expected:** one choice, sent to B, titled with B's name (before: A's). With only A's post, it is titled with A's name.
- **Replayable offline:** yes (scratch ledger; rehearsed in the fixing session).
