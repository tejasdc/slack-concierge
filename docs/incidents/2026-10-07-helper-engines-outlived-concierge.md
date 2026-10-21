---
failure: The meaning-search and speech-to-text engines kept running after Concierge stopped, so restarts found leftovers that systemd had to kill.
date: 2026-10-07
fix_commits: [08672901, 77fb7e1b]
cause_status: confirmed
---

# Search and speech helper processes outlived Concierge's stop

## What was seen

During the update restarts of 2026-10-07 the meaning-search engine (llama.cpp, added that afternoon) was left
running across restarts, and at the 8:16 PM EDT stop a `parakeet-server` speech engine outlived Concierge and
systemd had to SIGKILL it as a leftover process of the unit.

## Cause

Confirmed from the commits. Both engines are long-lived children spawned through `nice`
(`EmbeddingEngine.spawnOrAdopt` in `bot/src/meaning-index.ts`, `ResidentEngine` in `bot/src/speech-engine.ts`)
with no parent-death signal and no stop on process exit. When the owner exited or was killed, the child
survived; the meaning engine's adopt-if-healthy path then reused whatever was left on its port.

## Fix

- 08672901 (meaning engine part; the same commit's other fixes are recorded separately): the engine is launched
  through `setpriv --pdeathsig KILL`, and `startMeaningIndex` stops it on `process.exit`.
- 77fb7e1b: the speech engine is launched the same way on Linux and SIGKILLed on exit on every platform.

## Acceptance scenario

- **Seed:** an owner on Linux that has started both engines (the speech engine loaded by one transcription).
- **Action:** stop the owner normally; separately, SIGKILL the owner.
- **Expected:** in both cases no `llama-server` or `parakeet-server` process remains within a second, and the
  next start spawns fresh engines; systemd logs no leftover-process kill.
- **Replayable offline:** yes (stub engine binaries that sleep; Linux needed for `setpriv --pdeathsig`)
