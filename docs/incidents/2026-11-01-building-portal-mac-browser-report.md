---
failure: Mac browser policy allowed direct Chrome DevTools calls and gave no automatic fallback for a recorded server browser failure.
date: 2026-11-01
fix_commits: []
cause_status: confirmed
---

# November 1 building portal Mac browser report

## What was seen

Tejas saw Chrome activity on his Mac while the building portal agent worked and asked why a server-reachable website was using his laptop. He subsequently clarified the placement rule: agents should start on the server and automatically use the Mac when a real server failure calls for it; no per-use permission request.

- The building portal session used Linux Chrome on the server. It approved the Helsinki sign-in request at 21:09:49 UTC and filed both mailbox requests there.
- Mac Chrome history contains the same one-time email approval URL opened at 21:11:21 UTC, 92 seconds later. The URL hashes match. The earlier investigation claimed no portal visit through 23:00 UTC, but its commit was made at 21:31:58 UTC. That future window had not been observed; the claim was wrong.
- A later read-only check of all three Mac Chrome profiles found 17 building-portal visits in the Default profile from 22:23:52 to 22:24:58 UTC. The first portal visit is classified as typed/from-address-bar, then the history follows login, device verification, portal return, and two request pages. The other profiles have no portal visit from 22:15 to 22:35 UTC. The 22:24:02 UTC approval email reports Chrome 155 on Mac OS X 26.7 in New York, consistent with this sequence. A typed classification does not identify a human; automation can initiate such a navigation.
- Mac Concierge has no link-opening receipt in the earlier window. The archived Mac sessions handling mailbox photos and text codes contain no browser-control call there. No archived agent session is identified as the actor for the 22:24 sign-in. Chrome history does not identify who drove the browser. The 21:11 approval-link visit and the 22:24 portal sign-in are separate events.
- Daylight saving ended on November 1: the reported 5:13 PM ET is 22:13 UTC, while the 21:11 Chrome visit was 4:11 PM EST. The 22:24 sign-in happened later than the reported observation and cannot by itself explain what Tejas saw at 5:13 PM.

## Cause

The actor behind Tejas's observed Chrome activity and the 22:24 portal sign-in is unknown. The Mac history now proves portal activity in his Default Chrome profile but does not attribute it to the building-portal agent or to Tejas. Separately, the original direct Mac tool hook did not classify Chrome DevTools calls, and the policy had no recorded server failure path for an isolated Mac browser. A November 3 audit found that it also missed Codex Computer Use and Claude in Chrome tool names: at 22:29:55 UTC on November 1, mac:235 used Computer Use to inspect the thnkr.ing window despite no desktop-capable need. That observed call was five minutes after the portal sequence and is not evidence that it caused the sign-in.

## Fix

The previous managed Mac tool check did not classify direct or nested Chrome DevTools calls as browser control. It now refuses those calls. A Mac browser fallback is separately admitted only when the server request records the attempted website and observed failure. Its launcher checks the active accepted request with the Mac owner before opening a request-specific headless browser with a separate profile; direct use of Tejas's Chrome and desktop focus remains refused. This record is an agent observation, not an independent measurement of server failure. An email or SMS approval for a server sign-in is handled by the server browser.

The managed hook governs provider tools, not arbitrary programs outside that execution path. The new fallback preserves capability without introducing a per-use human approval. A server response that may have completed a write must be checked before submission is repeated on another machine.

The November 3 correction also classifies direct and nested Computer Use and Claude in Chrome calls. Computer Use checks the active Mac owner's accepted need even if an environment variable claims one, and is allowed for recorded Mac app, screen, native iOS, or explicit Mac work. Claude in Chrome remains refused for agent work because it attaches to Tejas's personal browser; a recorded server browser failure instead uses the isolated fallback. The history is evidence of browser activity, not actor identity.

## Acceptance scenario

- **Seed:** An ordinary Mac agent request has no desktop-capable need or recorded server browser failure; a second request has a retained fallback need and exact failed website; a third has a Mac app need.
- **Action:** Attempt direct Chrome DevTools, Claude in Chrome and Computer Use calls, then the isolated browser launcher.
- **Expected:** Direct browser tools are refused for all three. Computer Use is refused for ordinary and browser-fallback work and allowed for the recorded Mac app work. The launcher is refused for the ordinary request; for the active fallback, the Mac owner returns the retained website and the launcher uses its own headless profile without activating Tejas's Chrome.
- **Replayable offline:** partly (the admission and refusal checks run offline; foreground behavior requires the Mac).
