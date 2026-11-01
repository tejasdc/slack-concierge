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
- Mac Chrome history contains the same one-time email approval URL opened at 21:11:21 UTC, 92 seconds later. The URL hashes match. Mac Chrome history across three profiles has no building portal visit from 21:00 to 23:00 UTC.
- Mac Concierge has no link-opening receipt in that window. The archived Mac sessions handling mailbox photos and text codes contain no browser-control call. The Chrome history shows Gmail followed by a Google redirect to the approval URL. Who opened it is unknown.
- The reported 5:13 PM ET time and the retained 21:13 UTC time differ by one hour after the daylight-saving change; 21:13 UTC is 4:13 PM EST.

## Cause

The cause of Tejas's observed Chrome activity is unknown. The trace above does not show a building portal agent driving his Mac Chrome. Separately, the direct Mac tool hook did not classify Chrome DevTools calls, and the policy had no recorded server failure path for an isolated Mac browser.

## Fix

The previous managed Mac tool check did not classify direct or nested Chrome DevTools calls as browser control. It now refuses those calls. A Mac browser fallback is separately admitted only when the server request records the attempted website and observed failure. Its launcher checks the active accepted request with the Mac owner before opening a request-specific headless browser with a separate profile; direct use of Tejas's Chrome and desktop focus remains refused. This record is an agent observation, not an independent measurement of server failure. An email or SMS approval for a server sign-in is handled by the server browser.

The managed hook governs provider tools, not arbitrary programs outside that execution path. The new fallback preserves capability without introducing a per-use human approval. A server response that may have completed a write must be checked before submission is repeated on another machine.

## Acceptance scenario

- **Seed:** An ordinary Mac agent request has no recorded server browser failure; a second request has a retained fallback need and exact failed website.
- **Action:** Each agent attempts direct Chrome DevTools control or the isolated browser launcher.
- **Expected:** Chrome DevTools is refused for both. The launcher is refused for the ordinary request; for the active fallback, the Mac owner returns the retained website and the launcher uses its own headless profile without activating Tejas's Chrome.
- **Replayable offline:** partly (the admission and refusal checks run offline; foreground behavior requires the Mac).
