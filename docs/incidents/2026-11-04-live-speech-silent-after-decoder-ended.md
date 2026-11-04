---
failure: Think-aloud kept showing that it was listening while the Mac had stopped turning Tejas's voice into words, and nothing told the page.
date: 2026-11-04
fix_commits: []
cause_status: best-explanation
---

# Think-aloud stopped delivering words after the microphone came back

## What was seen

On his Mac (Safari installed web app), Canvas think-aloud delivered words until the Control-Space
capture and then two bug reports took the microphone in turn. Every hand-off and hand-back
happened (the page's route log shows each), but after the first hand-back no think-aloud words
reached its agent, and the page recorded no speech failure (thnkr.ing reports 4edde4bb, 5d05977f,
1ecf; 2026-11-04 04:14–04:21 UTC).

## Cause

Best explanation, not reproduced on his Mac: think-aloud paused and resumed its Safari
MediaRecorder at each hand-off, and the fragmented MP4 written after a resume is not something the
long-running ffmpeg pipe here keeps decoding (WebKit has documented unusual MP4 chunks around
capture pauses, bug 279432). Confirmed part: once the decoder had exited, `append` still accepted
pieces into its closed stdin and `drain` kept answering with no new segments, so the page could
not tell a dead decoder from silence.

## Fix

`append` and `drain` refuse with `SPEECH_DECODER_ENDED` once the decoder has closed, cancelling the
engine stream and logging `live_speech_decoder_ended`. The page's existing reconnect then starts a
fresh recording. thnkr.ing separately stopped pausing the recorder at hand-offs (it records silence
instead) and shows which recorder holds the microphone.

## Acceptance scenario

- **Seed:** a live recording begun on the Mac's live speech routes.
- **Action:** its ffmpeg decoder exits (kill it, or feed bytes it cannot decode), then the page appends and drains.
- **Expected:** append or drain answers 409 `SPEECH_DECODER_ENDED` instead of empty segments; the page reconnects and later words arrive.
- **Replayable offline:** no (needs the Mac's Apple speech helper and ffmpeg).
