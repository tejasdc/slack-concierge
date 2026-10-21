---
failure: For two hours the Mac's Concierge could not restart because its old helpers still held the read sockets, and the server assumed the Mac was asleep and told nobody.
date: 2026-10-10
fix_commits: [7f40a553]
cause_status: confirmed
---

# Leftover Mac helpers blocked Concierge from restarting

## What was seen

The Mac's 12:45 AM update on October 10 restarted Concierge while its request gateway was finishing a graceful stop.
Every restart for two hours failed with "Read API already has a live listener", so the server could not reach the Mac
while Tejas was using it. The server treated the unreachable peer as a sleeping Mac and raised nothing.

## Cause

The foreground gateway and its two read workers outlived the owner (macOS has no parent-death signal) and kept the read
sockets. Separately, `bot/src/session-peers.ts` treated every connection failure as quiet sleep, including a refused
connection, which means the machine is awake and nothing listens.

## Fix

7f40a553 adds `bot/src/exit-with-parent.ts`: once a stop begins the process exits by a deadline, and a process whose
parent is gone exits within five seconds; the gateway and both read workers use it. A refused peer connection now
announces the peer breaker to the repair agent; a timeout stays a quiet sleep.

## Acceptance scenario

- **Seed:** Mac-style owner with gateway and two read workers running; kill the owner process abruptly mid-stop.
- **Action:** Start a new owner after five seconds; separately, point the server's peer client at a port with nothing
  listening.
- **Expected:** The old helpers have exited and the new owner binds its sockets; the refused peer connection files one
  repair notice, while a timed-out peer files none.
- **Replayable offline:** partly (helper exit is replayable on Linux with the same code; macOS-specific parent behaviour
  needs the Mac)
