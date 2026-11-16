# Mac disk maintenance

Owner: Concierge on Tejas's Mac. `com.tejasdc.concierge-autoupdate` already runs
every fifteen minutes while awake; `scripts/update-mac.sh` invokes the Python upkeep
before its unchanged-release and running-work exits. There is no new job, wrapper,
code identity, macOS grant or server poll. The existing launchd observer inventories
this job; completed CPU and peak memory remain unknown where its collector lacks
execution-bound receipts. The upkeep receipt independently records elapsed duration.

`scripts/mac-disk-maintenance.py` owns one policy. The existing update installer
delivers it through Git, never by copying source to the Mac. Run it at low priority
with the same arguments as the updater to exercise the installed behavior. It uses
only Python's standard library and the already installed Git, Bun, lsof and native
`/usr/bin/trash`. A state-directory advisory lock excludes overlapping housekeeping.

## Boundaries

- Only `concierge.log`, `concierge.err`, `speech.log`, `speech.err`, `update.log`,
  `playwright-mcp.log` and `playwright-mcp.err` in Concierge's state log directory are
  rotated. At 32 MiB, keep one full, compressed evidence generation `.0.gz` and three
  compressed tail generations under immutable numeric time identifiers. Each holds
  at most 32 MiB of prior tail plus 32 MiB appended while compressing, making the
  ordinary retained bound 192 MiB uncompressed per log. Generations expire only
  after a complete replacement and successful truncation. Failed archive writes
  preserve all old generations. A known prepublication failure retries; interrupted
  publication holds that log's rotation and records an existing repair-agent notice,
  preserving its active bytes, marker and archives until effects are reconciled.
  The first pinned generation is a separately measured, finite evidence allocation,
  not a repeating archive. The threshold leaves most of a day's observed 50 MB growth
  available and avoids daily log churn; the three generations retain several normal
  days without allowing indefinite growth. See the
  [logging contract](../architecture/BOUNDED-APPLICATION-LOGGING.md#mac-launchd-retention)
  for copytruncate's diagnostic-loss window and between-pass growth.
- Empty identity leftovers must match `antigravity-identity.` plus exactly six
  alphanumeric characters, be a single-link regular file owned by the current user,
  have mode 0600, zero bytes, and unchanged modification/change times for 24 hours.
  This exceeds the status-line reader's lifetime by orders of magnitude. The live
  identity JSON, nonempty staging, links, other modes and recent files are preserved.
  The producer already cleans on EXIT/HUP/INT/TERM; this catches interrupted leftovers.
- Finished worktrees are sought only under the workspace's one- and two-level
  project `.wt` roots, matching the server precedent. Every nonterminal turn's
  working and additional folders in the Mac ledger protect their enclosing worktrees,
  including hosted turns that could otherwise survive an update. A pending session
  with unknown location, or unknown ledger/process evidence, holds all retirement.
  The existing update admission gate's typed worktree-retirement claim holds all new
  starts, including providers allowed through an ordinary restart gate. Every
  target is checked again immediately before moving: clean tracked and untracked
  status, no hidden index flags, HEAD contained in local `origin/main`, no process
  cwd inside, no non-rebuildable file modified/changed for seven days, and ignored
  content limited to the server's explicit build/package-output vocabulary.
  Symlinked project/worktree ancestry, gitlinks and submodule administration refuse
  retirement, because an outer clean branch cannot prove nested history is preserved.
  Private `.env`, review notes and test data preserve the worktree. Nothing is
  inferred finished by age alone. Only successful `trash` moves are retired, the
  exact missing Git registration is removed, and the branch is retained. No Trash
  expiry is added: **moving to Trash does not free filesystem space**. The branch
  recreates the checkout through the existing worktree manager; the trashed folder
  retains the original contents for inspection or recovery of any rebuildable output.
  A thirty-second retirement budget also bounds each native probe by the remaining
  time, then releases the claim in `finally`. The next upkeep invokes the existing
  kernel-identity recovery before claiming, clearing a previous dead housekeeping
  process's gate without stealing a live update. No running process is stopped.
- Free space below 20 GiB starts one incident; 25 GiB clears it for a later incident.
  The 20 GiB margin is an operational choice grounded in this incident's 13 GB debug
  cache and remaining headroom for swap and ordinary work, not a measured maximum
  burst. The additional 5 GiB recovery band prevents repeated notices near the floor.
  The state stores incident numbers and pending delivery before sending, removing
  each pending item only after `recorded` or `duplicate`; an unknown send retries
  the same key even at 21 GiB or after recovery above 25 GiB. Later delivery describes
  an earlier episode as recovered when appropriate. The existing
  authenticated peer channel sends only episode, latest free byte count and recovered flag to
  the server's typed `POST /sessions/v1/peers/mac-disk-warning` sibling. It derives
  its server address and token file from the installed Concierge launchd plist,
  so the updater does not duplicate peer configuration. The server rejects
  unverified peers, arbitrary fields, prose and invalid numeric facts. It composes
  the warning and records Tejas's explicitly requested notice in his server Inbox
  through the existing provider-free notice primitive and response-attention route.
  The Mac itself has no Inbox. Ordinary health failures retain their repair-first behavior.
  No email or new notification
  channel is created. Personal libraries, Downloads, Simulator and unrelated caches
  are outside this upkeep's authority.

## Evidence and rollback

Private state beside Concierge's ledger:

- `mac-disk-maintenance.json`: latest duration, rotated names, identity deletion count,
  successfully retired paths/HEADs, hold reason, errors and current free bytes.
- `mac-disk-pressure.json`: low-space incident identity and transport acknowledgement.
- `mac-disk-maintenance.lock`: prevents concurrent passes without blocking.

The existing update log receives the same structured receipt. Rotation preserves
the output inode; inspect native `lsof +fg` append flags and inode before/after a live
pass, archive readability, the unchanged launchd process and new output afterward.
Count compressed `.0.gz` allocations in capacity reports. Trash size is retained
data, never claimed as reclaimed space. A receipt is housekeeping evidence; a notice
receipt establishes transport acceptance rather than human delivery or reading.

Run `python3 scripts/mac-disk-maintenance-test.py` for disposable filesystem/Git
acceptance: full evidence archive, bounded subsequent generations, open descriptor
continuity, archive failure and links, exact empty-file scope, all worktree refusal
classes, safe post-Trash registration removal with branch retained, pending-turn
  guard and stable notice retry/recovery identity. Run
  `bun bot/scripts/mac-disk-notice-fixture.ts` to exercise the real notice command
  against disposable state: one native Inbox input and response attention despite
  repeated sends, while ordinary health still goes to repair. Neither fixture reads
  production state.

`bun bot/scripts/mac-disk-warning-ingress-fixture.ts` additionally runs the real
foreground gateway and owner route on disposable loopback/private sockets. It
proves the gateway strips spoofed peer marks, requires the paired-peer token, and
accepts/deduplicates a real server Inbox warning. These server fixtures do not claim
Mac-to-server delivery or physical device display.

`bun bot/scripts/mac-worktree-gate-fixture.ts` uses the real claim/release commands
and queued-turn admission: the retirement purpose holds a proven survivable Codex
provider, release admits the same queued work, the ordinary restart purpose still
admits a proven survivor, and existing dead-owner recovery clears a stale claim.

## Pressure exchange state card

The Mac upkeep is the single writer of episode identity and acknowledgement; the
server Inbox is the single writer of accepted warning records. Identity is the
persisted `mac-disk-low:<episode>` across retries, never the reading or a clock tick.
Low space records a new episode locally before transport; server acceptance creates
one service input and attention entry transactionally; only a matching `recorded`
or `duplicate` answer removes the local pending obligation. Pressure recovery never
removes an unaccepted obligation. Server offline, old-server 404,
lost reply or Mac restart leaves the same episode pending until the next existing
fifteen-minute upkeep while awake. Stable receiver dedup also covers an accepted
request whose answer was lost. Above the recovery band, the next low episode gets
a new identity. No provider turn or second scheduler carries this exchange.

Recorded/duplicate establishes server Inbox acceptance, not device display or human
reading. The ordinary Inbox owner files the service input into a thread and existing
attention delivery follows it. Older Mac source never calls the new route; a newer
Mac talking to an older server keeps its pending identity and retries after server
deployment. Disposable acceptance repeats a committed warning with a changed byte
reading and verifies one input, one attention item and original content retained;
it also refuses unverified and prose-bearing requests before mutation.

Rollback uses the existing gated Mac updater with a correcting Git commit removing
the invocation. Existing archives and private receipts remain; nothing is restored
over a running log. Worktree folders remain recoverable from Trash.
