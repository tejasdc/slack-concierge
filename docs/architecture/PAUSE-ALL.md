# Pause all agent sessions

Concierge owns the pause. The cloud owner's SQLite ledger holds one generation and one
admission gate. The native and legacy queue claims consult that gate in their claim
transaction, so new messages, agent requests, scheduled turns and watch firings can be
retained but cannot start a provider turn. The Inbox project router is the one exception:
it remains answerable and can call `router-actions.sh sessions pause status|all|resume`.
Its new child requests and its own scheduled turns are still held by the gate. Watch
polling and command launch also wait while their session is held. An optional schedule
expiry keeps its original meaning: if its window ended during the pause, it expires
when that session resumes.

`POST /sessions/v1/pause-all` records the gate and the exact running turns in one
transaction. It marks Stop intent for each eligible run, then asks the execution host to
interrupt it. The host waits until tracked provider tools have reported completion
before issuing the provider's native interrupt. The status distinguishes requested,
confirmed stopped, unconfirmed and ChatGPT still thinking. A stalled tool can delay the
interrupt; native provider reports cannot prove an external side effect is fully rolled
back. A ChatGPT request already thinking has no native Stop and may finish while paused.

The cloud sends the generation to each peer. A Mac that sleeps retains its local gate;
on startup it reads the cloud state before adopting or claiming work. If that read is
unavailable, it holds claims until the cloud sends a confirmed state. The cloud status
reports a peer as pending until it acknowledges the current generation. A peer response
includes its bounded paused-work snapshot, so thnkr.ing can show both machines.

`POST /sessions/v1/pause-all/resume` with only an action ID clears the gate on both
machines. With `sessionIds`, it keeps the global gate and admits only those sessions.
Queued work in an admitted session uses its normal queue order. For each stopped run,
Concierge adds one service continuation that tells the agent to inspect retained work
and current files before continuing, rather than replaying an input whose side effects
may have occurred. A stable action ID makes a retry the same control. Existing session
level suspension still applies, and a stopped session with an unresolved provider
outcome still requires inspection.

The product entrance is the shared thnkr.ing header's Pause all agents control. It
posts through the authenticated Thinkering command entrance to the cloud owner. The
paused sheet shows running and queued sessions, peer acknowledgements and selected or
all resume. It never calls a provider directly.

Pause all governs Concierge session admission and the providers' running turns. It does
not stop arbitrary processes or independent tools started outside Concierge. If a
provider has detached background work, its own lifecycle and the running session's
record remain the source of truth; the pause status must not label that work stopped.
