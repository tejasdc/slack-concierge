# Concierge drain hang blocks all channels (2026-08-12)

## Symptoms

- 06:27:52 CEST — `concierge-bot.service` entered `deactivating (stop-sigterm)` state.
- 06:27:52 → 07:00 CEST — bot stayed in drain for **~30 minutes**. Active `bun` process (PID 1343068) alive but refusing new Slack events.
- Effect: every new user message in every channel silently dropped. Mid-turn steering in the ONE thread that had a live turn (session 305 in `#slack-concierge`) continued to work because that path routes to the active turn, not through the new-event admission.
- Confirmed dropped messages: two chann-app posts sent 12 and 19 min into the outage never appeared in the bot's journal (`journalctl -u concierge-bot | grep C0BNLJ6Q68M` empty for that window).

## Root cause

- Session 305 (`#slack-concierge`, thread `1786152111.965719`, provider `codex`) was in an unusually long turn started at 06:05.
- pstree at time of investigation:

  ```
  bun(1343068) → node(1678310, codex app-server)
                   → codex(1678317)
                     → codex-code-mode(1679003) [12 threads]
                     → zsh(1708886)
                       → codex(1708887)          ← NESTED codex-in-codex
                         → codex-code-mode(1709788) [15+ threads]
  ```

- The concierge codex agent had `zsh -c "codex exec …"`-spawned a **second, independent codex process** inside its own turn. That nested codex was still running when SIGTERM arrived.
- The concierge bot's shutdown handler is drain-aware: it waits for in-flight turns to reach a terminal state before exiting. The outer codex reported no `session_turn_lock_released` — presumably because its child (the nested codex) had not returned. Drain waited forever.
- Origin of the SIGTERM itself was NOT identified: no `systemctl stop` in the system log for that window, no in-flight `deploy.sh`, no `git pull` since Aug 10. Best guess: an internal drain path (per `a7a651f Make deployments drain-aware and recover interrupted turns`) fired without leaving a distinctive trace.

## Fix applied

- `systemctl kill -s SIGKILL concierge-bot` on AX41. systemd reported "Failed to send signal SIGKILL to auxiliary processes: Invalid argument" but the unit rotated correctly — auto-restart via `Restart=always` brought a fresh instance up 3 seconds later.
- New MainPID 1713759, `ActiveEnterTimestamp=2026-08-12 07:00:42 CEST`, `concierge_bot_online` event fired in journal.
- Dropped messages were NOT retried; user (Tejas) instructed to re-send in the affected threads.

## Architectural gaps — NOT fixed today

Deferred by explicit decision — noted here so future work has the context.

### 1. Drain has no timeout

`drain-aware` shutdown waits indefinitely for in-flight turns to reach a terminal state. If a subprocess chain never returns (nested codex, hung tool call, deadlock), the bot stays in drain forever, blocking every unrelated channel from receiving new events.

Proposed shape when we get to it: drain has a bounded deadline (e.g. 5 min). Turns that exceed it are force-killed (SIGKILL on the subprocess chain), their session marked as `errored_drain_timeout`, and the bot proceeds to exit. Sessions marked this way are recoverable on restart per the existing interrupted-turn recovery in commit `a7a651f`.

### 2. Drain state silently drops new messages

While draining, new Slack events (messages in any channel) hit the Bolt handler and are ignored with no user-visible signal. Users don't know their message was dropped until they notice nothing happened.

Proposed shape: while draining, respond to any new user message with an ephemeral reply — "Concierge is restarting; your message was not accepted. Please resend after a moment." Or optionally park the message in `state.db` and process it after restart (would require reasoning about ordering and idempotency).

### 3. Per-thread heartbeat, not per-thread-message heartbeat

Reported by Tejas on 2026-08-12 (referenced in image #57 in the conversation). Current design (`f371de9 Keep cumulative TLDRs on Slack thread status`) maintains ONE durable status message per thread, edited in place across every subsequent turn. Consequence: after the user sends message #2 in a thread with active work, the status heartbeat is still updating the message at the TOP of the thread — the user has no visual signal underneath their reply that anything is happening.

Proposed shape: status/heartbeat message per top-level user message in the thread. First message's status stays at the top; subsequent messages get their own status reply immediately after them. The cumulative TL;DR guarantee stays (concierge already computes it) — just render it in the newest status message too.

### 4. Elapsed timer meaning is ambiguous

The status message shows "N minutes elapsed" which measures the CURRENT turn's age, not the thread's total wall-clock or the current user request's wait. When a thread has multiple sequential turns, "21 minutes" appears next to a message that started an hour earlier — reads as if the bot lost time.

Proposed shape: distinguish "current turn: 21m" from "thread age: 1h 8m" in the status text. Or drop the misleading elapsed counter and switch to relative wall-clock ("started at 06:05, updated 30s ago").

### 5. Single-process bottleneck (architectural, big scope)

`concierge-bot` is a single bun process. One Slack Socket Mode connection. One event loop. Any process-level unhealth (drain hang, crash, memory pressure) blackholes every channel simultaneously. Channels' agent subprocesses ARE isolated, but the parent event dispatcher isn't. This incident is one instance of that single-point-of-failure surface.

Not proposing a fix here — this is a real tradeoff (simpler ops vs isolation) and the right answer probably starts with (1)–(4) above bounding the blast radius before contemplating a bigger substrate change like per-channel workers or an async event queue.

## References

- Commits touching the drain / recovery path: `a7a651f`, `cf253de`.
- `bot/src/index.ts` shutdown handler and `session_turn_lock_*` events.
- Investigation transcript: this session (Claude Code, cortex project, `88577ed5-bdb7-4718-b9d2-7eb7413f4af1`).
