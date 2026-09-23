# Seeing a usage wall coming — what shipped, and what is only designed

2026-09-23. Follow-on from [the 2026-09-22 incident](../incidents/2026-09-22-usage-limit-silent-stop.md),
where an account ran out at 23:51 UTC and nobody was told until Tejas asked at 02:14.

His instruction, verbatim: *"the system should be notified 30 minutes before, like 50 minutes
before one hour before, it should know that like, oh, we're running out of credit. We should
be smart about this. Let's inform our agents."* And, resolving the conflict the router raised
about downgrading running sessions: *"we don't have to switch to our cheaper model suddenly …
The sessions who are working on it can be informed. And notified and say, hey, the session is
running low. Are you making sure that you're using the intelligence intelligently?"*

## Why none of this existed

Not an oversight in the reading — a missing consumer. The commit that added per-account usage
(`1cb514f`, 2026-09-18) says what it was for in its own message: *"Readings refresh every 30
minutes and ride on the providers read so the Provider accounts dialog can show them."* The
architecture note said the same in one sentence that stood unchallenged for five days:
**"Nothing here gates dispatch."** The numbers were built as a display. Nobody owned the
question "what should happen *before* the wall", so nothing read them back, and the readings
went on being taken all through the outage that they described.

Two smaller facts fall out of the same gap and are fixed here: only the latest reading was
kept, so there was no series to see a climb in; and the periodic read was wired only into the
Slack-enabled composition, so an instance running the native-only runtime spent the same
accounts while never watching them on a timer at all.

## What shipped

**A forecast, with its working shown.** Readings are now kept per account and window, so a
rate exists. Where the provider forecasts a window itself — it does this for the weekly
allowance — that projection is used as given. For the five-hour window, which is the one that
actually broke and which the provider forecasts not at all, the projection is a straight line
through this machine's own samples since the window began. Every forecast carries its source,
how many samples it rests on, the span, and the rate. Nothing invents a countdown: a line
through past readings cannot promise a time, and the words everywhere say so.

**Readings tighten near the wall.** Half-hourly is right while there is room and useless for
an hour's warning on a five-hour window — two samples cannot draw a line. Once a window on
the account in use passes about halfway, readings move to every five minutes and relax again
afterwards. A reading costs one short-lived process against a local cache (~90 ms), so the
dense period is cheap and bounded.

**Tejas is told before it happens**, once per window per allowance period, through the same
notification path the outage notice uses — no provider turn, no router session, so it
survives the provider being the broken thing. It names when it expects to run out, when the
allowance refills anyway, which other account has room, and that it is a forecast.

**A signal anything can read**: `router-actions.sh sessions usage` returns, per provider, the
account in use, the closest wall with its minutes and its basis, the accounts with room, and
every window's forecast. It recommends nothing and changes nothing. This is what the Inbox
router reads before dispatching new work.

**Running sessions are told, and decide for themselves.** Two deliveries, because the two
cases are different:

- A turn that *starts* while the account is low reads the situation in its own per-turn
  context. This costs nothing extra and is current at the instant the turn begins.
- A turn already *under way* — the case that actually spends the allowance, a session an hour
  into a long run with no reason to look anything up — is told inside that run.

The second is pinned to the exact live run, so it can never start a turn on an idle session;
if the run ends first the notice fails rather than queueing. One per session per allowance
period, keyed by the window's reset instant, so a tightening window cannot become a stream a
session learns to skip. It states the numbers, names where the room is on *both* providers,
says plainly that nothing about the session is being changed, and asks one question: are you
spending your own turns on work that has a fixed acceptance criterion and could be handed
down? It instructs nothing.

**His model-binding rule is untouched.** Nothing switches a running session's model, adds a
fallback chain, or moves work between providers. The whole design is information.

## Not built: switching account automatically

Designed here, not implemented, per the router's instruction.

**Which account.** The one whose every window is below a threshold at the last reading, on
the same provider, preferring the one with the most headroom in the window that is about to
bind. Never an account with any window spent; never an account whose reading failed.

**What happens to work already running.** Nothing. Claude reads its credential file once at
process start, so a switch cannot affect a turn already running — it changes where the *next*
process looks. Codex is different: the App Server holds its token in memory, so a Codex
switch needs the sanctioned restart, which already defers while a Codex turn is running.

**What he sees.** The switch would have to be announced the way the hold is, naming which
account it moved to and why, and be visible in Provider accounts afterwards. A silent switch
is not acceptable — it changes which subscription his work is billed against.

**Why it is not built, beyond needing his approval.** Two things on this box are not proven:

1. *Two switching mechanisms exist and do not know about each other.* Concierge swaps
   `~/.claude/.credentials.json` from its own `~/.claude/auth-profiles/`; `claude-swap` keeps
   its own copies under `~/.claude-accounts/` and reports which account is `active`. The usage
   reading takes `current` from claude-swap, while a usage limit is scoped from the credential
   file. Switch through one and the other can disagree — the forecast would then be watching
   the wrong account's headroom. Any switching design has to collapse these to one owner
   first, or teach one to read the other.
2. *No switch has been completed end to end by anyone.* The second Claude account's sign-in
   path was only repaired on 2026-09-22; claude-swap's stored copy for its second slot dates
   from 2026-09-18 and is a different size from the live credential. Until a switch has been
   done by hand and the account in use verified afterwards, automating it would be automating
   an unrehearsed step.

**Recommendation.** Do the first switch by hand, once, and check what `sessions usage` then
reports as the account in use. That single rehearsal answers both unknowns and costs minutes.
Automation after that, or never — the notice plus a one-tap switch may be enough.

## Proposed wording for the global Model selection section

Point 3 of his instruction — *"There's no point in using only their own sub agents. They
should be using like across both"* — is a real asymmetry in the delegate-down table: a Claude
session reaching GPT models is written down; a Codex session reaching Claude appears only as
the Fable fallback during an escalation. Nothing anywhere says to prefer the provider that has
room.

This section is the one authority for delegation and `concierge:3633` is editing it tonight
for the new model generation, so this is a proposal, not an edit. Two sentences, to be added
to **Delegate down**:

> Hand work down across providers, not only within your own: both credentials are on these
> machines and both accounts' usage is readable, so a Claude session delegates to GPT models
> and a Codex session delegates to Claude models, whichever has room.
>
> When your own account is close to its limit you are told so, with the numbers and where the
> room is. That is information, not an instruction: your model does not change, and what to
> hand down stays your judgement — but prefer the provider that has room for it.

Ordering: whoever lands second rebases onto the other; the two changes do not overlap in
substance, only in file.
