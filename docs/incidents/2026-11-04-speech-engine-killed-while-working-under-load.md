---
failure: Watch recordings sat on "Writing your words" for an hour because the speech engine was killed while still working and its recordings went to a far slower engine
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# His Watch showed "Writing your words" for an hour and kept re-sending

## What was seen

From about 2:40 PM ET on 2026-11-04 Tejas's long Watch recordings stayed on "Writing your words";
the Watch re-uploaded them again and again. The speech worker logged `transcriber_timeout` for
Parakeet on a 226 s recording (14:48) and a 537 s one (15:15), each followed by
`transcriber_fallback` to whisper.cpp; the 226 s recording took `transcribe_ms` 998035 on
whisper.cpp. Host load was 60–67 on 12 processors from agent builds and browser checks.

## Cause

`ParakeetEngine.transcribe` killed the engine at a fixed 60 s + audio length, on the assumption
that Parakeet runs at about ten times real time, so anything slower must be wedged. Under that
load Parakeet was working but slower than real time. The kill threw its work away and handed
the recording to whisper.cpp, which ran at about a quarter of real time. Recordings queue one at
a time, so every later recording waited behind it. (thnkr.ing's share route also held the
device's upload open meanwhile; that half is fixed in thnkr.ing.)

## Fix

At the deadline the engine is stopped only if `ps` shows it used no processor time since the
last look; otherwise it is looked at again a minute later and `transcriber_slow` is logged.

## Acceptance scenario

- **Seed:** a speech engine child that keeps using processor time past 60 s + audio length.
- **Action:** a transcription request reaches the deadline.
- **Expected:** no `transcriber_timeout`, no whisper.cpp fallback, and the request settles with
  the engine's words; an engine with no processor time since the last look is still killed.
- **Replayable offline:** yes (a stand-in engine script that busy-loops or sleeps)
