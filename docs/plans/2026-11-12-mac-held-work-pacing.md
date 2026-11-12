# Mac held-work pacing, shared browser helper and freeze evidence

Date: 2026-11-12. Requests 45403e67 (diagnose and cut agent memory) and 4a569069 (Tejas's approval).
Current-state homes: [turn lifecycle](../architecture/TURN-LIFECYCLE.md#paced-starts),
[peer instances](../runbooks/PEER-INSTANCES.md#paced-starts-shared-playwright-and-memory-evidence-on-the-mac),
failure record [Mac memory-pressure freezes](../incidents/2026-11-12-mac-memory-pressure-freezes.md).

## Problem in his words

> Yeah, let's uh, stagger them on like, let's kind of like uh, add some jitters, and uh, queue them up
> and like, Create a queue on, like, you know, when we are notified as, like, you know, some of these
> things are like in queue and held back. Let's like, you know, now, basically have an agent kind of
> like, you know, add priorities, uh, based on the context and uh, schedule them.

This is his explicit approval under `machine-wide-resource-changes-need-his-approval` for pacing how many
held sessions start and for holding new starts while memory is under pressure. It does **not** approve
changing any agent's processor or memory priority (nice, QoS, taskpolicy); nothing here does.

## Evidence (2026-11-12, read live over SSH)

- The Mac (36 GB, 14 cores) had 14.1 of 15.4 GB swap in use with no Concierge agent running. Chrome
  helpers ~13 GB, WebKit ~4 GB, WindowServer ~1.8 GB, Codex desktop ~2.3 GB, Voice Memo transcription ~2.2 GB.
- Concierge itself is small: 318 MB footprint 15 minutes after a restart (208 MB already compressed).
- Every `owner_unresponsive` since Nov 4 has `starved: true`: 1.2–1.8 s of CPU across ~65 s blocked; the longest
  single block is 12–21 s; 528 blocked-task records since Nov 10 sit in the provider usage watch timer, the
  most frequent timer touching cold memory.
- Best current explanation (inferred, not observed): the Mac is permanently near memory exhaustion, macOS
  compresses or swaps the idle owner, and each timer wake faults pages back in while the disk and
  compressor are contended. A 25-turn burst makes it worse but is not required. Section 5 turns the
  inference into an observation at the next freeze.
- Every Concierge Claude session on the Mac loads his plugins; Playwright (npm wrapper + node server, 90–130 MB)
  and episodic memory (50–115 MB) start a process per session. Since Oct 13, 24 of 719 Mac Claude
  transcripts used Playwright and 25 used episodic memory.

## Design

1. **One shared Playwright server** for the Mac's Concierge Claude sessions: a long-lived pinned
   `@playwright/mcp` under its own launchd job (`com.tejasdc.concierge-playwright`), loopback HTTP,
   `--isolated` (each connection gets its own in-memory context, never his signed-in Chrome), `--headless`
   (browser starts on first use, closes after an idle hour). A Concierge configured with its URL launches each
   Claude session with that server added through `--mcp-config` and the `playwright@claude-plugins-official`
   plugin switched off in the `--settings` JSON it already passes. A host without the setting (the server)
   launches exactly as before. Episodic memory and the language servers stay.
2. **Paced starts** enforced where a queued turn is claimed for a new provider process, so every release path
   (allowance refill, account switch, Pause-all release, restart recovery) shares one bound. Per machine, via
   launchd environment: 3 starts per 2-minute window and 0–30 s jitter; unset means unpaced. Why those
   numbers: 25 held sessions at ~0.5 GB each start over ~17 minutes instead of 11, never putting more than
   ~1.5 GB of new demand in one window. A turn not admitted stays queued with its next attempt at its slot,
   so the existing wake clock drives it. Exempt: a direct human message, the Inbox router, ChatGPT (no
   process). Memory gate: macOS's own pressure level (1 normal, 2 warning, 4 critical); warning holds paced
   starts one slot and re-checks, critical holds every start. Swap fullness is not a signal (the Mac sits at
   ~92 % with no agents).
3. **Agent-set order.** When more than one group waits, a Haiku one-shot with no tools (the consultation-only
   restriction) orders them from title, summary, project, how the input arrived, age and request summary,
   returning an order and a one-line reason each. Late (30 s) or malformed answers leave the fallback:
   Tejas-originated, then Inbox-thread-waiting, then oldest. Asked again only when new starts join.
4. **What he sees.** A held start's status line says its place and time ("Waiting its turn: 7th, starts about
   3:12 PM") or that memory is under pressure, through the existing queued-input status. No phone notification
   and no Inbox thread per burst: being queued needs nothing from him.
5. **Freeze evidence.** `owner_unresponsive`, `owner_task_blocked` and `owner_task_still_blocked` on macOS carry the
   owner's compressed memory, page-ins since the previous record, the memory-pressure level and swap use,
   copied from a sampler that runs off the owner's blocked path.

## Acceptance

- After a release of several held marked test turns on the Mac: starts at most 3 per 2 minutes with jitter, in
  the agent's order, each held session shows place and time, no `owner_unresponsive` during the release.
- A marked Concierge Claude session on the Mac has no per-session `playwright-mcp` or `npm exec` child, and its
  Playwright tools work through the shared server.
- The server's behavior is unchanged.
