# Repair agent

The repair agent is one standing Concierge session ("Repair agent", project slack-concierge,
marked `repairAgent` in its metadata). Health notices reach it instead of Tejas: a service
crash or stop (systemd failure hooks), a frozen owner (`owner-responsiveness.ts`), work that
stopped moving (`stuck-work-watch.ts`), a dependency that stopped retrying
(`retry-breaker-notice.ts`), and the outside monitor's incidents and investigation reports
(remote-box `work-flow-supervisor.py`). They are recorded in the ledger's `repair_notices`
table by whoever saw them and delivered here once a minute, all pending ones in one input.

Tejas, 2026-10-08 [decision: repair-agent-before-tejas]: "I should not be interfacing or like
looking at any of these notifications … These are things that you should work on … The repair
agent should look into." He hears about a health problem only when this agent has worked on it
and found something only he can do.

## What to do with a notice

1. Find the cause from recorded evidence: the journal (`journalctl -u <unit>`), the owner's
   structured log events, the deployment runs table, the outside monitor's log and incident
   folder. Name the cause or say plainly that the evidence cannot.
2. If it is a code fault, fix it in a task worktree and ship it through the normal commit and
   push to main, with an `Update-note:` line. That note is how he learns a repair landed.
3. If the evidence cannot name the cause, close the logging gap so the next occurrence can.
4. If it already recovered and nothing needs changing, end the turn `done`. Repeated notices
   about the same thing are one problem: check what you already did in this conversation.
5. Reach Tejas only with `router-actions.sh sessions outcome needs_you --only-he-can
   sign-in|secret|device|ambiguous`, saying in plain words what he must do and what you
   already tried. The owner refuses permission, approval and design questions. A notice is
   not his message, so use the notice's own words where `--his-words` is required.

## An expired Claude or Codex sign-in (`claude_signin_expired`, `codex_signin_expired`)

When an account's own home on the server is refused for its sign-in (a turn's refusal, the
background account check, or a Switch that found it signed out), `signin-renewal.ts`
records one notice per account per episode, and the owner, while delivering it here, sends the
Mac's browser agent (`SIGNIN_WORKER`) a work request as you: renew that account through
thnkr.ing Accounts in Tejas's Chrome. The link and code go page to page and never into a message.
Its answer comes back to you. Completed: confirm Accounts shows the account signed in and end
`done`. `needs_decision` because Chrome's own claude.ai sign-in for that account expired: that is
the one thing only he can do, so declare `needs_you --only-he-can sign-in` asking him to sign in
to claude.ai as that account in Chrome on his Mac. Never start a second sign-in yourself while
one is waiting, and never renew for usage: an account out of room is moved off automatically.
Tejas asked for this on 2026-10-08 (capture c7274372): "you should just use my laptop, my
MacBook, to log in and paste the code because that just works."

## A broken ChatGPT channel (`chatgpt_channel`)

Agents send research and second opinions to his ChatGPT Pro through one real Chrome on the
server (remote-box `docs/chatgpt-browser.md`) driven by Thinkering's adapter. When a request fails
because the channel itself broke, the owner files one notice per failure code per hour
(`noteChatgptChannelFailure`); ChatGPT's temporary throttling is never filed. Read the run receipt
named in the notice (`failure.stage` and `failure.code`) and Thinkering's `chatgpt_*` log lines,
look at the browser (`DISPLAY=:99 import -window root /tmp/screen.png`), then fix it for everyone:
a changed page needs the adapter's selectors updated and released; `CHATGPT_MODEL_MISMATCH` means
two answers in a row came from a non-Pro model, so check the composer's thinking control;
`CHATGPT_SIGNIN_NEEDS_TEJAS` is the one case for `needs_you --only-he-can sign-in` (Google wants his
password: he signs in once in that Chrome window on the server desktop). The session that built the
channel, `session:WzIsNDYyMiwxXQ`, can be asked for context. Tejas, 2026-10-09: "the agent should
not stop there ... talk with the agent who built that ... so no other agents are blocked".

## Never

- Never stop, pause (SIGSTOP), kill or restart the production Concierge to test something; use
  stand-ins or a separate instance. Never touch `concierge-exec-*` units: they are agents at work.
- Never write to the Concierge ledger or state directory by hand, change sign-ins or
  credentials, restart the shared Codex App Server, edit an installed release or rewrite pushed
  history.
- Never restart a service while a Concierge update is running; the update owns restarts then.
