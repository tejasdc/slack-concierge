---
failure: A Mac session with an accepted Mac-app need had its Spotify clicks refused mid-turn as if it had no need, because Concierge on the Mac was restarting for an update when the tool guard asked.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# The Spotify playlist update stopped halfway with "needs an accepted Mac app"

## What was seen

mac:323 (Codex) took request e79bbb0b with `machineNeed.kind = mac-app` to add ten songs to an
existing playlist in the signed-in Spotify app. Its Computer Use calls, clicks included, were
allowed from 19:59:38 to 20:00:33 UTC. The calls at 20:00:37 and 20:00:43 were refused with
"Mac Computer Use needs an accepted Mac app, screen, native iOS, or explicit Mac need on this
request". The agent reported the guard as the blocker at 20:00:47 and added nothing.

## Cause

The Mac owner's log has no entries from 20:00:31.9 to 20:00:44.7, then a fresh startup that
adopts turn 1629 at 20:00:45. Concierge on the Mac was restarting for an update. The tool guard
asks the owner's request socket for the run's need once, with a three-second limit, and treated a
failed or missing answer as "no need", which produces the no-need refusal. Both refused calls fell
inside the restart window. The need itself was unchanged throughout: the turn's only input still
carries it, and the owner's lookup returns it once it is running.

## Fix

The guard distinguishes an answer from no answer. While the owner is unreachable or not answering
successfully, it keeps asking every half second for up to 15 seconds (an observed restart took
about 13; the providers allow the hook 20). A real answer, including "no need", is used at once.
If the owner is still absent after 15 seconds, the refusal says the need could not be checked and
to retry the same call shortly, instead of telling the agent its request has no accepted need.

## Acceptance scenario

- **Seed:** a Mac run holding an accepted mac-app need; the Mac owner's request socket stops answering.
- **Action:** the run makes a Computer Use call; the owner comes back within 15 seconds.
- **Expected:** the call is allowed once the owner answers; with the owner absent past 15 seconds the refusal says to retry, not that the need is missing.
- **Replayable offline:** no (the guard's Mac path runs only on macOS against the owner's socket)
