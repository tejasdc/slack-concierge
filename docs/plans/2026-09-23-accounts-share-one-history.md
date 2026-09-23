# Two accounts, one history — so a conversation never waits for a refill

**Status:** mechanism and Mac continuation proven; dispatch wiring committed for delivery,
live Concierge acceptance pending (2026-09-23).

Tejas settled the question this design exists to answer: "Why are we waiting until 5:10? …
all of my accounts should work across both," and "never wait for a refill while another
account has room." A design where an in-progress conversation sits out an account's
five-hour window while another account is empty is the thing he rejected, so it is not on
the table.

The obstacle is real and was measured before anything was designed. On the Mac,
2026-09-23, a conversation started under one account's configuration home and resumed under
the other's did not degrade — it refused to start:

```
$ CLAUDE_CONFIG_DIR=~/.claude-accounts/tejas-chann-app claude --resume 802095ed-… -p …
No conversation found with session ID: 802095ed-…
```

The transcript exists only in the home it was created in. **The history is his, stored on
his own machine; it is not the account's.** So it should not be filed under one.

## What the history is, and what it is not

A Claude configuration home holds two unrelated kinds of thing:

| Kind | Examples | Belongs to |
| --- | --- | --- |
| Who is signed in | `.credentials.json`, the macOS Keychain item | the **account** |
| What was said | `projects/<cwd-slug>/<session-id>.jsonl` | **him** |
| This machine's own state | `settings.json`, `history.jsonl`, shell snapshots, caches | the **machine** |

Only the middle row is shared. Credentials are never shared, copied, moved or refreshed by
this design — that is the whole point of per-account homes and the thing that broke on
2026-09-22 when one shared credential was rewritten underneath running work.

## Where the history lives, and how each home sees it

**It stays exactly where it already is.** The default home's `projects/` remains a real
directory that nothing moves, renames or replaces. Each *extra* account's home borrows it:

```
~/.claude/projects                                  (real directory — unchanged, ever)
~/.claude-accounts/<account>/projects  ->  ~/.claude/projects      (symlink)
```

The asymmetry is deliberate. The default home is the one every existing consumer already
reads: the box's nightly transcript archive, the Mac's five-minute push to it, the
episodic-memory index, and Concierge's own history reads. Turning *that* path into a
symlink would quietly change what those copy (rsync follows or preserves links depending on
flags nobody set for this). Borrowers take the indirection; the lender is untouched.

Nothing else is shared. `history.jsonl` — the typed-prompt history — is the one genuinely
shared mutable *file* a home has, and it is deliberately left per-home so there is no file
two accounts append to at once. Settings, caches and shell snapshots are machine state and
stay put.

### Proven, at zero cost

The mechanism was isolated without spending any allowance and without a credential, by
using the order in which the CLI does its work: it resolves the conversation before it
authenticates. Two empty configuration homes, same command, one variable different:

```
A  (empty home)                    -> No conversation found with session ID: a407d3a3-…
B  (empty home + projects symlink) -> Not logged in · Please run /login
```

B got past resolution. Sharing the history directory is *sufficient* to make a conversation
found from another home. What that probe cannot show — because it had no credential — is
whether the conversation then continues with its context intact under a different account.
That is the live proof, below.

One side effect the probe exposed: **B appended a record to the shared transcript even
though it never logged in.** A borrowing home writes there regardless of whether it can
authenticate. Harmless in itself (the file is append-only and the record was its own), but
it settles the next question as a real requirement rather than a theoretical one.

## What stops two processes writing the same conversation

Nothing new, because nothing new is needed — and that is the point.

- **One turn per conversation at a time** is already the owner's invariant: execution is
  serialized through the existing per-session FIFO and provider owner. Sharing history does
  not add a second writer; it adds a second *place the single writer may run from*.
- **Two different conversations never collide**, even on two accounts, because each
  conversation's transcript is its own file named by its session id. The shared directory
  has no shared mutable file in it.
- **A move happens only between turns.** Nothing is ever swapped underneath a running
  process — the same rule that already governs credentials now also governs history.
- The one writer this does not cover is a human running `claude --resume` on the same
  conversation in a terminal. That hazard exists today, within a single home, and is
  unchanged by sharing.

If the FIFO invariant were ever weakened, this design breaks with it. That is a dependency
worth stating out loud rather than a defect to patch around here.

## Which account a conversation runs on

`bot/src/provider-account-choice.ts` holds the rule as a pure function. Shared history
changes one line of it: the pinning that was forced by the measurement above is no longer
forced, so a conversation whose account has run out may continue on one with room.

1. Only accounts this machine can actually launch as are candidates — one with its own
   home, or the default login. An account with neither is unreachable, because reaching it
   would mean writing over the shared credential.
2. A conversation stays on its own account while that account has room. Staying is still
   preferred: it is free, and it keeps his usage legible.
3. When its account has no room and another does, the conversation **moves** and continues
   there with its context.
4. When no account has room, the existing hold applies and the turn waits for the soonest
   reset — now genuinely because there is nowhere to go.

**Mid-turn exhaustion needs no new machinery.** A turn that runs out fails with the
provider's own usage refusal, which carries its reset instant; it returns to its own queue
under every existing effect-safety check, and the next attempt re-runs the choice above and
lands on an account with room. The process ends and the next one starts elsewhere. Nothing
is ever migrated live.

## What he sees

- A conversation shows the account it is running on, beside the model it already shows.
- When a conversation moves, **one line, once per move**, in his words: *"Continued on
  tejastej.dc@gmail.com — tejas@chann.app had run out. Nothing was lost."* Not per turn.
- The accounts page marks which account each machine is sending new work to.
- The hour-ahead warning already fires; it now also says whether another account has room,
  so "you are running low" and "and there is somewhere to go" arrive together.
- When nothing has room, the wait names the soonest reset and says every account is spent —
  which is now the only reason anything waits.

## The live proof, before any wiring

Two things are still unproven, both on the Mac, both gated on the second account's
five-hour window refilling at 21:10 UTC:

1. **Continuation.** A conversation started on one account, given a fact to remember,
   resumed under the other account's home, and asked for that fact — answering correctly,
   with the other environment's authentication reporting a genuinely different account.
2. **Concurrency.** Two different accounts answering at the same moment. Three attempts so
   far, each defeated by the second account being at its own limit rather than by anything
   refusing. Proven for Codex; assumed-but-unmeasured for Claude.

Both must also leave both credentials byte-identical and the default home's `projects/` a
real directory.

**No wiring lands before those pass.** Building a dispatch path on an assumption is what
the 2026-09-22 outage was.

## Both proofs passed — 2026-09-23, 21:2x UTC

**Continuation.** Session `74077648-f24a-4a4c-ac1b-baf0f6c7d3f6` was started under the
default home (`tejastej.dc@gmail.com`) and asked to remember `BRONZE-FALCON-7294`. Resumed
under `~/.claude-accounts/tejas-chann-app` (`tejas@chann.app`), the same session id returned
`BRONZE-FALCON-7294`. Context carried across accounts.

**Concurrency.** Two one-word requests launched concurrently, one per home, both returned,
each environment's `claude auth status` reporting a different account — the fourth attempt
and the first with real room on both. Account attribution rests on the per-environment
authentication status, not on anything the model said about itself.

**Nothing disturbed.** Both Keychain credential items identical before and after
(`18:48:04` and `19:48:41` UTC), `~/.claude/projects` still a real directory, both homes
still reporting their own accounts, nothing signed in or out. The second home's own prior
history is preserved beside the link as `projects.before-sharing`.

So the rule below is now the behaviour, not the plan.

## Dispatch integration

The owner now reads the existing usage snapshot immediately before a Claude process starts.
It checks that an extra home's `projects` path resolves to the default home's history,
passes the chosen home to that process alone, and records its account after start. On the
next turn that account is passed back as a preference. Usage refusals belong to the selected
account, so an exhausted default login cannot block an extra home. A safe refusal can retry
on another account at once; if all accounts are spent, the existing reset hold applies.
The session view and one account event carry the chosen account and the rule's wording.
There has been no agent-run test or deployment of this integration; Tejas will check it live.

Pressing a Claude account in Thinkering now saves only a selection of its existing home.
No credential is copied into the default login, and the outgoing default account is not
snapshotted. The next turn prefers the selected account; later turns keep their last account
while it has room. Codex's activation remains separate and unchanged.

## What changed when continuation passed

Pinning was a consequence of the measurement, not a preference, and it did not outlive it.
Written down here because the thing most likely to make it permanent is nobody remembering
it was temporary.

`provider-account-choice.ts` knows two states today: a turn is **bound** to an account — it
runs there or waits — or it is not. When continuation passes, a conversation stops being
bound and becomes **preferring**, which is a third state:

| | today | after the proof |
| --- | --- | --- |
| a conversation | bound: runs on its account or waits | prefers its account; moves when that account has no room |
| a banked release | bound: runs on the named account or waits | unchanged — bound |
| new work | most headroom | unchanged |

Stickiness stays. Staying is free, and a conversation that hops accounts for no reason makes
his usage harder to read. What goes is the *refusal*: `bound-account-has-no-room` stops
applying to conversations, which is precisely "never wait for a refill while another account
has room". Only banked work keeps it, because moving it would spend the wrong subscription
and lapse the allowance it was saved for.

Nothing has to be undone to get there. The rule never decides *whether* a conversation is
bound — the caller supplies the binding, and no caller exists yet. Nothing persists a
conversation-to-account association anywhere, so there is no stored state that would force
binding later.

The one thing that could have gone stale silently is not behaviour but what he is told: the
waiting sentence says *"a conversation cannot change accounts — its history lives with the
one it started on"*, which becomes false the moment sharing works. That is now compiler-held,
and it has been watched to fail: removing `"this-session"` from the binding reasons breaks
the build on that exact sentence (`TS2367 … '"spending-this-window"' and '"this-session"'
have no overlap`). The false explanation cannot survive the change that makes it false.
