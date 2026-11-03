---
failure: On the Mac, an account whose login had expired was treated as having room, so the renewal fixed the wrong machine, the notice promised a move that could not happen, and his message moved to Codex while he was signing in.
date: 2026-11-02
fix_commits: []
cause_status: confirmed
---

# His Mac work said "moves to tejas@chann.app by itself" and then disappeared into Codex

## What was seen

All evening on 2026-11-02 the Mac's tejastej.dc@gmail.com Claude week was spent (until Nov 4,
3 AM ET) and its tejas@chann.app home was signed out. Mac sessions were held with "no usage left
until 3 AM … it moves to tejas@chann.app by itself". At 7:28 PM ET his message to mac:75 ("Third
spaces online") was moved into a new Codex session (mac:256) and mac:75 showed it cancelled; he
read it as lost. At 7:30 PM he signed tejas@chann.app back in through Accounts, which worked, but
mac:75 had nothing left to resume.

## Cause

1. The Mac's own sign-in renewal asked its browser agent to "renew the server's Claude sign-in"
   (the text was the same from both machines). The agent renewed the server's healthy login at
   18:51 UTC and reported success; the Mac's login stayed signed out for six more hours.
2. The usage reader holds its own copy of each login, so the Mac's tejas@chann.app read as having
   room while its home could not run. The hold notice listed it as where work moves.
3. The Claude-to-Codex transfer counts only launchable accounts, so the sign-in looked like an
   allowance wall and his new message was moved out of the session he wrote it in.
4. A transient `.storage-write.lock` in the main Claude folder (left by a terminal sign-in) made
   both extra homes read as incomplete, because only `.storage-write` was treated as per-login.

## Fix

The renewal text names the machine whose login was refused. `claudeAccountLaunchableHere` is the one
answer for "can this machine run this account now"; the hold notice names only those as where
work moves and lists the others as needing a sign-in; the Codex transfer does not run while an
account with room only needs a sign-in. `.storage-write.*` is per-login.

## Acceptance scenario

- **Seed:** a Mac with two Claude homes: one at its weekly limit, the other signed out but reading room.
- **Action:** he sends a message to a Claude session on the Mac.
- **Expected:** the message stays queued in that session; the notice names the signed-out account
  as needing a sign-in (not as where work moves); the renewal request names the Mac's login; after
  the sign-in the same message runs in the same session.
- **Replayable offline:** no (needs a real expired Claude login on the Mac)
