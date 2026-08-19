---
title: "Platform hardening source design (superseded Pebble plan)"
type: exploration
status: superseded
date: 2026-08-19
---

# Platform hardening source design

> This document is preserved as the complete source exploration behind several
> possible future projects. It is **not** an approved implementation plan and
> is **not** a prerequisite for the Pebble webhook. The bounded Pebble plan is
> `docs/plans/2026-08-19-pebble-concierge-handoff.md`; extracted future work is
> indexed in `docs/future-plans/README.md`.

## Outcome

Ship `https://capture.tejas.nyc/pebble` without installing another Slack app
or placing a Slack credential in an Internet-facing process. A valid Pebble
transcript is durably accepted by a narrow local queue, posted once to
`#slack-inbox` by the existing Concierge bot, and admitted once as a fresh
capture-specific router turn.

The user-visible outcome matches the useful part of the current Monologue
flow: the capture is visible in `#slack-inbox`, and the router works in its
thread. The message is deliberately bot-authored rather than impersonating
Tejas. Concierge already ignores its own `bot_message` events, so the trusted
delivery worker can bind the visible message to the intended turn without a
Socket/API race.

This rollout does not migrate the working Monologue poller into the new queue or
change its user-authored Slack/router behavior. It does add a durable receipt
around the existing post-before-seen handoff so deployments and backups can
prove every Monologue Slack timestamp was classified. A later queue migration
remains a separate review.

## Security and lifecycle invariants

> The public HTTP process can authenticate, normalize, and forward only a
> bounded capture record. It has no Slack credential, persistent write path,
> queue database access, Slack destination, or router-state access.

> A trusted local queue service is the only capture-acceptance writer. It
> validates the record again and durably commits it before HTTP returns `202`.

> The primary Concierge process is the only Pebble/capture Slack writer and the
> only agent-admission owner. The separately retained Monologue poller keeps its
> current user-authored post. A Pebble Slack post is not completion; completion
> requires one atomically bound external-capture input claim, fresh session, and
> concrete turn.

> Stable source identity plus a retained acceptance ledger is the recovery
> invariant across retries and restores. Restored state is reconciled against
> external Slack/provider evidence before any side effect can replay.

## Confirmed constraints

- The production Pebble ingress from commit `dfe9cb6` has not been deployed.
  `/etc/concierge/capture-slack.token`, the Pebble token, and the proposed
  capture database are absent.
- The current live `/audio` receiver is `/opt/agent-inbox.py` on loopback port
  8080. This rollout leaves that service and storage path intact.
- The live Monologue timer starts as the current five-minute root poller. Its
  source and user-authored Slack flow stay in scope, but the effecting Bash/
  Python implementation is replaced by the sealed receipt-aware TypeScript
  entrypoints required by this rollout; migration into the capture queue is out
  of scope.
- `#slack-inbox` is `agent-auto` and `single-persistent`; ordinary message
  admission is therefore not equivalent to capture admission.
- The existing Slack bot token is already trusted by Concierge and has the
  required write capability. The manifest must add the capture, restore-cutoff,
  and project-ready metadata schemas and `metadata.message:read`, followed by a reinstall, before capture metadata
  can be the recovery proof. Monologue keeps its existing user token and uses a
  self-describing authenticated receipt whose secret is confined to its poller
  and a verify-only service; no second app is needed.
- `capture.tejas.nyc` currently falls through the Cloudflare/Vercel wildcard
  and returns 404. The one sanctioned Cloudflare token can manage Workers,
  routes, and Custom Domains, but cannot list or write DNS records.
- Caddy 2.11 is healthy at the existing `sslip.io` origin. A Worker Custom
  Domain can supply the readable hostname without a second Cloudflare token.
- AX41 runs Linux 6.8 with headers for `SO_PEERPIDFD` and systemd 255 has no
  `PrivatePIDs=` directive. Although `kernel.unprivileged_userns_clone=1`,
  Ubuntu's `kernel.apparmor_restrict_unprivileged_userns=1` profile currently
  denies the mount/`sys_admin` operations required by the rootless launcher.
  Provider PID isolation therefore requires the executable-specific AppArmor
  prerequisite below and is never credited to a nonexistent unit option or the
  permissive userns sysctl alone.

## Architecture

```text
Pebble phone
  -> https://capture.tejas.nyc/pebble
  -> Cloudflare Worker Custom Domain (exact path allowlist)
  -> Caddy origin (exact path allowlist)
  -> concierge-capture-ingress on 127.0.0.1:8082
       route bearer, 256 KiB ceiling, multipart transcript normalization
       no database, no persistent write path, no Slack/config access
  -> concierge-capture-queue on 127.0.0.1:8083
       independent enqueue credential, schema validation, trusted quotas
       /var/lib/concierge-capture-queue/state.db
  -> Concierge bot
       idempotent import into trusted main state -> Slack bot post -> atomic turn bind
  -> fresh capture-specific router session in #slack-inbox
```

The queue service has one authenticated mutation operation: enqueue a
normalized event. It cannot post to Slack or admit a turn. The public ingress
can call that operation but cannot read, acknowledge, delete, lease, or modify
queue rows. The non-root Concierge bot reads and leases the trusted queue
database directly through the dedicated ledger-group contract below; unlike the
rejected design, that pathname and its directory are not owned or traversable by
the public process.

## Detailed design

### 1. Separate public parsing from durable acceptance

`concierge-capture-ingress.service` runs as `concierge-capture` and listens only
on `127.0.0.1:8082`. Its systemd sandbox has `ProtectSystem=strict`,
`ProtectHome=true`, an empty capability set, and no `ReadWritePaths` or
`StateDirectory`. `/tmp` and `/var/tmp` are explicit private, noexec, 16 MiB
tmpfs mounts rather than unbounded writable host filesystems. Its only
credentials are the Pebble route bearer, the local queue enqueue credential,
and its read-only route view. The Worker-to-origin credential terminates at
Caddy and is never exposed to ingress.

Public ingress is pinned to Bun 1.3.14 `node:http.createServer`; it does not use
`Bun.serve` or an ambient framework parser. It launches with
`--max-http-header-size=8192`; constructor options set `maxHeaderSize=8192`,
`headersTimeout=3000`, `requestTimeout=15000`, and `keepAliveTimeout=1000`;
properties set `maxConnections=16`, `maxHeadersCount=64`, and
`maxRequestsPerSocket=1`; `listen` uses backlog 16. The connection callback
starts one absolute 15-second accept-to-close deadline which header/body/queue
activity cannot renew. Excess pre-header connections are closed; a parsed
request that cannot immediately acquire one of eight multipart-plus-queue slots
gets `503` and `Connection: close` without its body being read. Each header is
at most 4 KiB, fixed and chunked multipart bodies share the 256 KiB streaming
ceiling, and a stalled queue call remains inside the same deadline. The unit
sets `MemoryMax=128M`, `TasksMax=32`, and `LimitNOFILE=128`. Raw slow-header,
slow-chunk, connection/backlog flood, multipart-slot flood, and queue-stall tests
exercise ingress itself through Caddy; broker limits are never credited as
protection for port 8082.

For `/pebble`, ingress:

1. checks the bearer with a timing-safe comparison;
2. streams at most 256 KiB and rejects a non-empty audio part;
3. validates and normalizes `transcription`, `recordedAt`, `client`, optional
   `sourceId`, and optional `title`;
4. sends the normalized record to the queue service with the independent local
   enqueue credential;
5. returns `202` only after the queue reports a durable commit, `200` for an
   identical duplicate, `409` for an identity/payload conflict, `429` for a
   trusted rate limit, and `503` for trusted capacity or queue unavailability.

Pebble adapter v1 has one complete normalization contract. The multipart
allowlist is `transcription`, `recordedAt`, `client`, `sourceId`, `title`, and
`audio`; every field may occur at most once, unknown or duplicate parts are
rejected, and `audio` must be absent or zero bytes. Text parts are decoded as
strict UTF-8, reject a BOM, NUL, unpaired surrogate, and C0 controls other than
tab/CR/LF, and convert CRLF and bare CR to LF. Adapter v1 deliberately performs
no Unicode normalization and depends on no Unicode Character Database or ICU
version. It trims only the exact scalar set U+0009 TAB, U+000A LF, and U+0020
SPACE from both ends; every other valid scalar—including non-ASCII whitespace
and currently unassigned scalars—is preserved byte-for-byte in its shortest
valid UTF-8 encoding. Limits are applied to the resulting UTF-8 bytes; raw
multipart bytes remain subject to the earlier 256 KiB ceiling. `transcription`
is required and must contain a scalar outside that exact trim set. `recordedAt`
is required as only ASCII
decimal digits, has no sign/decimal/exponent/leading zero other than literal
`0`, and must parse to a positive JavaScript-safe integer millisecond timestamp.
`client` maps missing or normalized-empty input to the route-contract literal
default `ring`; otherwise it is required to fit its bound. `sourceId` and
`title` map missing or normalized-empty input to null, distinct from any
non-empty string. The normalized queue JSON always carries explicit
`recordedAt_ms`, `client`, and nullable `sourceId`/`title`; it never asks the
broker to infer a default. Ingress and broker share golden cases, but the broker
repeats strict JSON/type/bound checks and the same canonicalization and refuses
any value that changes on renormalization. Golden vectors include each exact
trim scalar, adjacent non-trim Unicode whitespace, composed/decomposed pairs,
and valid currently unassigned scalars to prove byte stability across runtime
upgrades.

The ingress has no spool. A public-process compromise can make bounded enqueue
requests but cannot consume disk directly or alter a queue row after acceptance.

`concierge-capture-queue.service` runs as a different identity,
`concierge-capture-queue`, on `127.0.0.1:8083`. Its primary group is the fixed
`concierge-capture-ledger` group; `concierge-bot` is its only non-root
supplemental member. `StateDirectory=concierge-capture-queue` is owned
`concierge-capture-queue:concierge-capture-ledger`, mode 2770, and both services
run with `UMask=0007`. Canonical `state.db`, `state.db-wal`, and `state.db-shm`
are owner `concierge-capture-queue`, group `concierge-capture-ledger`, mode 0660;
the setgid directory preserves that group for SQLite-created sidecars and
attempt-owned temporary files. Startup rejects any different owner, group,
mode, ACL, sidecar, or group membership before opening SQLite. Ingress,
provider, Monologue, and all other service identities are absent from the group
and cannot traverse the directory. The
service exposes only `POST /enqueue` and `GET /health`. There is no network API
for dequeue, acknowledgement, lease, listing, or administration.

The enqueue credential is not treated as a parser or resource-control
boundary: compromise of ingress exposes it. The broker is pinned to Bun 1.3.14
running `node:http.createServer`, not `Bun.serve` or a custom parser. The server
is launched with `--max-http-header-size=8192`; constructor options set
`maxHeaderSize=8192`, `headersTimeout=3000`, `requestTimeout=10000`,
and `keepAliveTimeout=1000`; properties set `maxConnections=16`,
`maxHeadersCount=64`, and `maxRequestsPerSocket=1`; and `listen` uses backlog 16.
The connection callback starts an absolute ten-second accept-to-close timer
which header/body activity cannot extend. Excess pre-header connections are
closed without parsing; a parsed request that cannot acquire one of eight
application body/SQLite slots immediately receives `503` and `Connection:
close` without its body being read. The unit pins `MemoryMax=128M`,
`TasksMax=32`, and `LimitNOFILE=128`, so the kernel backlog, accepted sockets,
runtime tasks, and memory are all bounded before handler dispatch.

After header parsing the broker permits at most 4 KiB per header, requires
`Content-Type: application/json`, rejects `Content-Encoding`, and streams at
most 64 KiB for both fixed-length and chunked bodies under the same absolute
deadline. Invalid UTF-8, duplicate JSON keys, trailing data, non-object roots,
and unknown fields are rejected. It then revalidates the normalized fields
independently: configured `route_id`, positive safe-integer `recordedAt_ms`,
`sourceId` at most 512 UTF-8 bytes, `client` at most 256 bytes, optional `title`
at most 512 bytes, and `transcription` at most 48 KiB and non-empty under the v1
normalization above. These bounds apply before hashing, rendering, rate-bucket
mutation, or SQLite access. Tests open raw sockets for incomplete-header drips,
oversized headers, backlog/connection floods, and deadline expiry in addition
to parsed-body floods; the implementation never relies on handler admission to
bound pre-handler work.

The broker, not ingress, computes the canonical event ID and payload hash from
the normalized fields. It also derives the exact v1 Slack envelope from the
route's immutable render contract and rejects it before persistence unless its
UTF-8 byte length is at most 39,000. This deliberately conservative metric is
shared with the bot and guarantees that the rendered text cannot exceed Slack's
40,000-character ceiling even when Slack's character definition changes.
Queue insert is one `BEGIN IMMEDIATE` transaction:
check for a semantic duplicate first, then update durable rate buckets, enforce
route/global row quotas, and insert. A known identical duplicate succeeds and
consumes no rate token even at capacity. The database has an explicit 2 GiB
maximum page count, and systemd memory/task ceilings; the public process has no
host-persistent writable filesystem.

The initial trusted policy is configuration, not code:

| Limit | Pebble | Global |
|---|---:|---:|
| Token-bucket capacity | 20 | 30 |
| Token refill/hour | 60 | 90 |
| Rows waiting in queue DB | 250 | 500 |
| Rows waiting in trusted bot DB | 250 | 500 |
| Retained acceptance-ledger rows | 45,000 | 60,000 |
| Concurrent external-capture turns | — | 2 |

Each route and the global scope has a persisted integer-microtoken bucket. A
new event spends one token from both buckets in the same acceptance transaction;
refill uses elapsed UTC milliseconds, clamps backward clock movement to zero,
and caps a forward jump at 24 hours. Duplicate/conflict requests never mutate
the buckets. Changing values is a route-policy edit and deployment, not an
adapter change. Excess work stays unposted in trusted pending state; it never
holds a live owner or the deployment gate while waiting for turn capacity.

### 2. Use stable event identity and dequeue, not epochs or cursors

Every queue row contains `event_id`, `route_id`, `route_contract_version`,
`identity_version`, `payload_version`, `render_contract_version`, `source_id`
when supplied, normalized source fields, transcript, `payload_hash`,
`parser_version`, the accepted rendered UTF-8 byte length, acceptance time,
trusted-import time, and purge eligibility. Payload, identity, and contract
columns are immutable. Detail fields are immutable while present and have one
legal mutation: verified terminal compaction may clear them after writing the
complete authoritative tombstone in the same transaction. Otherwise only
broker/root lifecycle columns change. It contains no Slack token, channel,
Slack timestamp, turn ID, or delivery owner.

All v1 hashes use one canonical tuple encoder. `tuple-v1(tag, fields...)` is
the ASCII tag followed by a NUL byte, then each field as a one-byte type tag
(`s` string, `i` integer, `n` null), a four-byte unsigned big-endian byte
length, and the value bytes. Strings are the already canonical adapter-v1 bytes
encoded as UTF-8, with no additional Unicode normalization;
integers are their minimal base-10 ASCII representation; an absent optional
field is the `n` tag with zero length and is distinct from an empty string.
No concatenation without this framing is permitted.

Semantic identity is independent of parser implementation:

- with a source ID: `SHA-256(tuple-v1("capture-source-v1", route_id,
  source_id))`;
- without one: `SHA-256(tuple-v1("capture-request-v1", route_id,
  recordedAt_ms, client, title-or-null, transcription))`.

`payload_hash` is `SHA-256(tuple-v1("capture-payload-v1", route_id,
identity_version, source_id-or-null, recordedAt_ms, client, title-or-null,
transcription))`. The literal stored versions are
`identity_version="capture-source-v1"` or `"capture-request-v1"`,
`payload_version="capture-payload-v1"`, and
`render_contract_version="capture-slack-text-v1"`. Shared golden byte/hash/
render vectors are consumed by ingress validation tests, queue acceptance
tests, bot import tests, and restore tooling.

`route_id` is the stable source namespace and can never be reused for different
source-identity semantics. Its identity version is fixed for that namespace; a
new identity version requires a new `route_id`. Delivery policy is deliberately
absent from both hashes. On first acceptance, the broker snapshots the then-current
`route_contract_version` onto the stable event. Later identical requests find
that event before current-contract quota/policy evaluation and return `200`
under its original contract; changed source facts return a first-wins conflict.
Changing label, destination, metadata, or rendering creates a new contract
version for new events but cannot change an accepted event. Only an intentional
new source namespace receives a new `route_id`. `parser_version` is stored
separately and may change without changing identity.

The bot imports a bounded batch into root-owned trusted delivery state, keyed by
globally unique `event_id`. Import compares route, semantic identity, and
payload hash. An identical main row idempotently marks the queue row imported;
a mismatch marks a durable conflict in both ledgers and never deletes either
record. A new main row and the queue row's `imported_at` are separate commits;
a crash between them repeats the compare and acknowledgement safely.

Before reading a candidate, the importer creates one queue-resident lease bound
to event ID plus exact process/PID/start-time/boot identity in the same immediate
transaction that checks `capture_snapshot_gate` is absent. This queue lease is
always first. The importer then claims its registered main effect lease; fence
refusal causes an owner-conditional queue-lease release and retry without any
main mutation. Once both leases exist it retains both through the idempotent main
comparison/insert; queue acknowledgement and queue-lease removal are one final
transaction, followed by main effect-lease settlement. No code path may acquire
these two leases in the reverse order. A live queue owner blocks snapshot-fence
acquisition; a proven-dead owner is reconciled by comparing main
identity/payload before either acknowledging/removing both leases or returning
the event to importable state. Thus no import can pass a pre-check and later
straddle a main/queue generation boundary. Crossing-fence tests assert this
queue-then-main order and cover refusal after the first lease.

The queue row is not deleted after import. It is the authoritative acceptance
ledger and preserves duplicate/conflict answers after dequeue and contract
upgrades. Only an event in `router_admitted` whose linked ordinary turn is
terminal is eligible for automatic queue compaction. Unknown, parked,
conflicted, or `restored_review` rows retain full detail until an operator
records a specific disposition. After an eligible event has been terminal for
at least 16 days, a transaction first verifies the main identity/payload/outcome
and then replaces transcript/source detail with an immutable tombstone
containing event ID, stable route ID, identity/payload versions and hash, first
contract version, acceptance time, and terminal outcome. Tombstones are never
automatically deleted or reinterpreted; they
continue to answer duplicate/conflict before current policy evaluation.
SQLite uses incremental auto-vacuum after bounded compaction batches. Under
storage or row pressure it never deletes tombstones or shortens the 16-day
detail horizon; it returns `503` for every unknown new event. A new `route_id`
does not create capacity and is never presented as a remedy. Service remains
exhausted until an independently reviewed configuration release deliberately
raises the global row/page bound after an operator proves storage headroom;
known duplicates and conflicts continue to resolve from the retained ledger.
A 60,000-row total ledger cap and 2 GiB SQLite page cap therefore bound state
under the shipped policy even under bearer abuse.

Backups are application-consistent generations, not raw live-file coincidence,
and are a coordinated release with the machine-level `remote-box` repository.
Slack Concierge owns a versioned snapshot/restore CLI; `remote-box` owns the
systemd backup orchestration, restic selection, exclusions, and operator
runbook. The two repository commits and their required deploy order are pinned
in the cutover journal.

The `remote-box` prerequisite release is deployed before receipt migration but
only after the current backup installation is quiescent. Before changing its
checkout, script, exclude file, or unit, the cutover claims the operations
inhibitor, records the exact installed hashes and prior unit states, persistently
stops and masks `remote-box-backup.timer`, and masks future activation of
`remote-box-backup.service` without stopping an invocation that is already
active. If the service is active, it records the exact systemd invocation ID,
MainPID, process start ticks, and restic child identity and waits for that exact
old-byte invocation to exit normally; it never issues `systemctl stop` or a
signal and then calls the invocation drained. Only after the recorded process
tree is dead, the unit is inactive, and no restic lock owned by it remains does
the driver change the checkout, executable script, exclude file, or executable
unit definition; the earlier persistent mask is an activation-state change and
preserves the original bytes in the journaled vendor path for that running
invocation. If the bounded
drain deadline expires, cutover stops without modifying those bytes; deliberate
abort is not a rollout path. It then deploys and checksum-verifies the
prerequisite. That release
keeps legacy behavior until a root-owned
`coherent-capture-required` marker exists; after the marker, a missing or
failed Concierge snapshot is a hard backup failure. It excludes the live main,
queue, and operations DB/WAL/SHM file sets, the live provider home, and all
provider credential paths as application restore points. Session continuity is
backed up only through the provider-state bundle inside a coherent generation;
credentials require the explicit supported re-auth prerequisite after disaster
restore. Its
explicit restic selection includes the immutable generation named `ready` in
the fsynced generation catalog plus the locally retained generations named
`uploaded`; it excludes staging, quarantine, and every generation absent from
that catalog. The cutover installs the snapshot CLI and marker before restoring
the exact prior backup-timer state, so no backup can race the ownership change.

The coordinated `remote-box` release is itself immutable. The installer copies
the backup driver, exclusion manifest, snapshot/upload entrypoint, retry
entrypoint, alert entrypoint, and the exact restic executable into one root-owned
read-only `/opt/remote-box/releases/<manifest-digest>` tree, fsyncs it, and
points every unit `Exec*` at that tree. The manifest binds every file's SHA-256,
realpath, owner/mode, restic version and `version --json` contract; every
invocation revalidates the manifest before interpreting restic output. No unit
executes the mutable checkout or resolves an exclusion relative to it. A later
upgrade may atomically switch the unit only while the operations inhibitor and
backup masks are held and after the new digest is recorded in the owning
journal. Concierge similarly binds the Monologue executable's realpath,
version, SHA-256, runtime/import closure, and JSON/cursor contract into its
sealed release and revalidates them immediately before every poll. The closed
inventory applies the same realpath/version/digest-at-use rule to every external
executable whose output can advance a durable transition; an unpinned tool may
produce diagnostics but cannot authorize state.

The sealed release contains `concierge-sqlite-snapshot-v1`, a narrow C helper
statically linked to the official SQLite 3.53.4 amalgamation. The implementation
commit pins archive SHA-256
`1e71ddf93849c6a6ecf58b827c0692073d2dd7ee40196158068f7b29f422e87d`
for `sqlite-amalgamation-3530400.zip` and requires
`sqlite3_sourceid()` exactly
`2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc`;
the build uses pinned GCC `13.3.0-6ubuntu2~24.04.1` and
`-O2 -DSQLITE_THREADSAFE=1 -DSQLITE_OMIT_LOAD_EXTENSION
-DSQLITE_DQS=0`, links no host SQLite library, and records the compiler-binary,
source, and helper-binary digests in the release and every generation manifest.
It opens a source read-only with `query_only`, applies a five-second busy
timeout, creates a destination exclusively, and calls
`sqlite3_backup_init(destination, "main", source, "main")`. It steps
256 pages at a time, retries only `BUSY`/`LOCKED` with bounded backoff, and fails
the generation after 60 seconds or any other result. After
`sqlite3_backup_finish`, it converts the copied destination header with
`PRAGMA journal_mode=DELETE`, requires the returned mode `delete`, sets
`synchronous=FULL`, closes, fsyncs, and reopens with the same fixed runtime.
Success requires `integrity_check=ok` and no journal/WAL/SHM sidecar.
Hot-WAL/concurrent-writer,
busy-timeout, interrupted-copy, and standalone-restore tests exercise this exact
binary. Neither Bun `serialize()`, `VACUUM INTO`, nor the host `sqlite3` CLI is a
permitted fallback.

Every control JSON object described here—generation catalog and manifest,
snapshot/restore/cutover journal, provider-state inventory, and terminal audit—
uses one computable `self_digest` rule. The digest is lowercase hexadecimal
SHA-256 over the RFC 8785/JCS canonical UTF-8 encoding of the complete closed-
schema object with its top-level `self_digest` member omitted; the stored member
is then added without changing any other value. Readers reject duplicate JSON
keys, non-I-JSON numbers/strings, unknown fields, or a noncanonical recomputed
value. References to another object's digest use that stored value. Shared
golden vectors cover Unicode, member ordering, integers, empty structures, one-
bit mutation, and the terminal pre/post-rename audit object, so “self-
authenticating” never depends on hashing a field that contains its own hash.

Backup storage is pinned in both repositories. Root owns mode-0700
`/var/backups/concierge`; immutable content lives under mode-0700
`/var/backups/concierge/generations/generation-<id>`. The authoritative
mode-0600 catalog is `/var/backups/concierge/catalog-v1.json`, with closed
schema `{version, revision, ready, uploaded[], prune_pending, restore_lease,
self_digest}`.
Snapshot staging and orphan quarantine share one bounded workspace at
`/var/backups/concierge/snapshot-work/{staging|quarantine}`; retained restore
file sets have an independent one-attempt slot at
`/var/backups/concierge/restore-quarantine/<attempt-id>`, and first-rollout
rollback has a distinct one-attempt slot at
`/var/backups/concierge/cutover-rollback/<attempt-id>`. Terminal restore audits
use the bounded fixed slots
`/var/backups/concierge/restore-audit/{latest,previous}.json`; after a new fixed
journal is durably claimed, its first journaled cleanup may unlink the prior
`previous`, rename+fsync `latest -> previous`, and reserve `latest` for this
attempt. All are on the same ext4
filesystem as verified at preflight. The `remote-box` manifest pins these
paths, owners, modes, and one-attempt bounds. Its restic source file uses
`--files-from-verbatim` to add the catalog and exactly the realpath-validated
ready/uploaded generation directories to the existing whole-box roots, while
the exclude file rejects live main/queue/operations file sets, the live provider
home and credential paths, and every staging/quarantine path. A missing,
duplicate, outside-root, wrong-owner, or
catalog-unreferenced selected path aborts backup.

Restore ownership is external to all three databases it replaces. The one
bounded active journal is root:root mode 0600 at
`/var/backups/concierge/restore-journal-v1.json`; catalog `restore_lease`
contains only its exact token, journal revision/digest, and active/terminal
status. The fixed path is also the restore-admission lock: creating it with
`O_CREAT|O_EXCL`, fsyncing it, and fsyncing its parent is the first mutation of
an attempt, and no later attempt may begin while that path exists, regardless
of the catalog lease. The journal's closed schema contains version/revision/status; restore
token and exact instance/PID/start-ticks/boot identity; selected catalog
revision, generation ID and manifest digest; restore-control and sealed-release
digests; the pre-restore edge plus exact timer/service enabled/active/masked
states and unit hashes captured by the current restore attempt; staging and
restore-quarantine realpaths; and a fixed `main`, `queue`, `operations` map.
It also contains fixed maps for per-image WAL conversion, per-channel Slack
cutoff sentinel intent/result/search state, restored-ready membership and
reclassification, a closed provider-state bundle install map, every hold
release/prior-unit-state restoration, and final lock retirement. No side
database or moved journal is needed to discover an unfinished restore.
Each file-set member records expected source/destination/quarantine paths and
checksums plus one intent/result phase from `untouched -> move_intent -> moved
-> install_intent -> installed -> verify_intent -> verified`. Status advances
only `preparing -> installing -> reconciling -> accepted -> cleanup_pending ->
complete`. Every revision is written to a same-directory exclusive temp,
fsynced, atomically renamed, and parent-fsynced before its described mutation.
Only after the matching result revision may the next mutation begin. The
journal is authoritative and is created first; catalog-pointer creation/removal
is a separately journaled intent/result, and startup repairs a missing/stale
pointer from the one exact journal token/digest rather than assuming two-file
atomicity.

Each map entry enumerates the only legal live SQLite names—`state.db`,
`state.db-wal`, and `state.db-shm`—and records presence/absence plus digest for
each before the first move. The journal has no catch-all filename field: a
`state.db-journal`, super-journal, or any other SQLite sidecar makes preparation
fail before mutation. This closed set is valid because all three schema owners
install a clean WAL-mode canonical image and reverify WAL mode before every
subsequent live durable write; an interrupted first-build temp and all of its
sidecars remain outside the canonical filename and are quarantined together.

A crash leaves this journal and catalog pointer outside the replaced DBs. A new
restore invocation that finds the fixed journal enters recovery rather than
creating a second attempt; it refuses a live owner and, after exact
dead-process proof, it
atomically adopts the same token/paths/selected generation and resumes the
first incomplete intent by inspecting both source and quarantine file sets and
their hashes. It never snapshots current masked unit state as the original
state. Acceptance and cleanup are token-conditional. While the same restore
token still owns the edge, bot, queue, main-effect, operations, Monologue, and
backup holds, it delegates those same tokens to the snapshot core, creates a
fresh local coherent generation, and verifies the generation and catalog. It
then journals and commits a catalog revision with `restore_lease=null`, and
verifies that the catalog references only selected generation directories. The
fixed journal deliberately remains in place and continues to exclude every new
restore while restic selection is re-enabled, fresh normal bot health is
proved, every hold is conditionally released, and every prior timer/service and
edge state is restored. Thus every remotely selected catalog is self-contained
without prematurely freeing restore admission. A second active restore attempt
or any unjournaled/mismatched file is a hard stop.

Retiring the fixed journal is the last idempotent mutation of restore. After
all recorded releases/restorations have result revisions, the journal writes
`retire_to_audit_intent` with its exact final audit path and pre-rename digest,
fsyncs, atomically renames itself to the previously reserved
`restore-audit/latest.json`, and parent-fsyncs both directories. The terminal audit journal is
self-authenticating: it records the final expected pre-rename digest and a
status whose only missing result is proven by its own final path. A crash before
rename leaves the fixed journal adoptable; a crash after rename has no remaining
hold or unit mutation and allows a new restore only after admission verifies
that no fixed journal exists and the terminal `latest` audit object matches its
recorded token/digest. No code writes a journal after losing its fixed path, and
no normal startup may remove or move it. The restore driver alone performs this
retirement after rechecking that all database holds are absent, the backup and
Monologue states equal their recorded originals, edge state is restored, and
the current bot invocation remains healthy. Rotation and final rename crash
tests prove the audit set is bounded at two and never obscures an active fixed
journal.

Every snapshot has one durable operation token in the operations DB, bound to
exact process identity, queue gate, main effect gate, bot gate, provider-state
fence, inhibitor, workspace path, generation ID, and catalog phase. Acquisition
order is fixed: operations inhibitor -> bot gate -> provider-state fence ->
queue snapshot gate -> main effect gate. After the bot gate prevents new turns
or provider starts, the provider-state fence tells the broker to reject new
`start`, `steer`, `fork`, and `continuity_probe` requests and waits for every
authenticated provider run and child to reach its terminal/reaped boundary. It
then stops the broker service and proves its provider-home writer set is empty.
This is the only moment a snapshot may read provider state; a provider home is
never stable-read while the broker or an interactive process can mutate it.
The queue immediate transaction installs `capture_snapshot_gate` only when no
importer queue lease exists. Enqueue and import-lease transactions both refuse
while it is held, so every pre-existing queue-first importer finishes or is
reconciled before the fence. The main immediate transaction then installs
`external_effect_snapshot_gate` only after every registered main-effect lease
is terminal or released. Both effect-intent synthesis and
`claimExternalEffect` check it; input classification that would create an intent
waits without committing. A reserved handler that dies is recovered through its
input-recovery row after release. There is no reverse acquisition path.

A later snapshot process may adopt the operation only after proving the exact
owner dead. One operations transaction replaces its owner while retaining the
original token/generation/workspace; it then owner-conditionally reconciles the
provider fence, queue gate, main gate, catalog phase, and workspace before doing new work. This
recovery runs even when the catalog already has `ready`, so no fast path can
leave a stale fence. Gates release only in reverse order—main, queue,
provider-state, bot, inhibitor—under the same token; broker restart restores its
exact recorded prior active state only after provider-state release. Crash tests
cover every acquisition/release boundary, provider child terminality, and both
importer crossings.

Normal `claimExternalEffect` governs only normal Concierge runtime mutations.
Snapshot, restore, and cutover use a separate sealed control-plane API whose
manifest enumerates the exact database tables and absolute filesystem paths it
may mutate. The standalone CLI receives control authority only after it has
claimed the exact inhibitor and bot gate. An existing cutover/restore owner may
instead mint a runtime-validated, non-exportable delegation bound to its same
live operation and gate tokens; the core must not reacquire, overwrite original
unit state, release the caller's gates, or accept a different token. Bot/service
entrypoints cannot import or execute this root-owned module. The target no
longer runs the bot or providers as host UID 0 and does not place them in one
credential-bearing process tree. `concierge-bot.service` runs as the fixed
non-root `concierge-bot` identity and receives only Slack bot/app/signing
credentials plus its exact main-state, attachment, and configured vault-capture
paths plus membership in `concierge-capture-ledger`; it receives no provider,
Monologue-user, operations, backup, or control credential. Real-UID tests open
the queue and perform the exact lease/import/ack transactions as the bot and
queue service, while ingress/provider/Monologue traversal and SQLite opens fail.

The UID split has one cutover-owned filesystem-authority migration. Under the
held bot gate after every legacy writer is dead, the standalone fixed helper
copies the main database to `/var/lib/slack-concierge/state.db`, applies the
same WAL-header install protocol used by restore, and verifies it before the
unit path changes. `/var/lib/slack-concierge` is
`concierge-bot:concierge-bot` mode 0700; the canonical DB/WAL/SHM and attachment
tree are owned by that identity with modes 0600/0700. The old root-state file
set is retained in the attempt's rollback quarantine until data becomes
forward-only and is never opened by the target. Every configured state,
attachment, receipt, and projection path is similarly relocated to an exact
service-owned `/var/lib` path; no target service uses `$HOME` or `/root` for
mutable runtime state.

Project data remains at its canonical user-visible location, so the driver
generates a closed `filesystem-authority-v1` inventory from every registry
`code_path`, `vault_path`, and realpath-resolved `additional_path`, their
required ancestors, the configured workspace root used for future project
creation, and the one approved code-`notes` to vault symlink relationship. It
rejects an escaping/cyclic link, overlapping incompatible policy, mount change,
hardlink outside the inventory, or path identity change. Before applying an
ACL, it stores a numeric recursive `getfacl` image, inode/type/mount/device map,
ownership/mode manifest, and digest in the fsynced cutover rollback set. It then
grants named POSIX access/default ACLs with no change of owner: `concierge-bot`
gets `rwx` on registered code/vault roots and the configured project-creation
root; `concierge-provider` gets `rwx` only on the exact code/additional roots
authorized by each sealed workspace policy; each identity gets execute-only
traversal on otherwise unreadable ancestors such as `/root`. Neither identity
gets list/read permission on `/root` itself or any credential/config sibling,
and provider policies never inherit the bot's creation-root authority.

The journal records ACL apply intent/result per inode batch and rechecks the
complete manifest after every crash. Before data-forward, rollback reapplies the
exact saved ACL/owner/mode image and reinstalls the original main file set;
afterward recovery repairs forward. The exact target UIDs must pass read,
create, atomic rename, fsync, append, and Git worktree/index probes for every
declared write set, while cross-policy, `/root` listing, credential, other-vault,
and other-project probes fail. New channel/project admission extends the durable
inventory only through the bot-owned managed-root contract defined below, under
its registered external-effect intent, and proves the new ACL/policy before
exposing the path to bot/provider code; it cannot edit the sealed legacy
root-owned inventory.

`concierge-provider-broker.socket` is the only provider control endpoint. It is
an `AF_UNIX` `SOCK_STREAM` socket at
`/run/concierge-provider/provider-v1.sock`, created by systemd in a root-owned
mode-0710 directory with socket owner/group `root:concierge-bot` and mode 0660;
there is no loopback listener. The socket unit uses `Accept=no`: systemd passes
one named listening descriptor to the singular
`concierge-provider-broker.service`, which runs as the distinct fixed non-root
`concierge-provider` identity and owns the accept loop and all provider children
in one cgroup. The listener is nonblocking; the daemon permits at most eight
accepted bot streams and eight live provider runs, uses
`accept4(..., SOCK_CLOEXEC|SOCK_NONBLOCK)`, applies a ten-second pre-auth/frame
deadline, and closes excess connections before reading. It validates
`LISTEN_PID`, exactly one `LISTEN_FD`, its Unix path/type/owner/mode, and the
parent directory before readiness. For each accepted descriptor and before
reading a byte, the broker calls
`getsockopt(SOL_SOCKET, SO_PEERCRED)` and requires the exact configured
`concierge-bot` UID and the kernel-supplied peer PID must equal the bot PID
named by the request's durable owner. It also acquires `SO_PEERPIDFD`, records
that pidfd plus the host boot ID, and treats pidfd readability/death as client
loss; support for this deployed-kernel contract is a cutover preflight. The
request's owner instance/start ticks are then checked against the already
persisted `provider_runs` row by the bot-side state machine rather than trusted
as broker authentication. Listener and accepted descriptors are `CLOEXEC`, only
the daemon accepts, the accepted stream is never passed to a provider child, and the
provider mount namespace does not contain `/run/concierge-provider`. A real
Codex/Claude child must receive `EACCES`/`ENOENT` when it tries the path and must
be rejected by `SO_PEERCRED` even if handed an alternate socket descriptor.

The versioned, length-prefixed broker protocol permits only `start`, `steer`,
`fork`, `continuity_probe`, `cancel`, `query_run`, provider protocol events, and
terminal status.
Every normal runtime request names a random `provider_run_id`, Concierge turn
ID, provider, operation, exact bot process instance/PID/start-ticks/boot
identity, expected provider session/turn identity when applicable, channel-
config digest, and one workspace-policy ID. A `continuity_probe` instead names
the live master-journal token/revision/digest and its exact predeclared UUID;
the broker accepts it only while the bot gate is held and no normal run is live.
The broker resolves cwd and additional directories from a root-owned sealed
policy table; client-supplied paths, environment names, CLI flags, executable
paths, and session IDs not proven by the bound main row or cutover journal are
rejected. It receives
only provider-specific authentication and explicitly enumerated provider
environment values; it never inherits `process.env`, `CREDENTIALS_DIRECTORY`,
Slack/user/Monologue credentials, or bot configuration. The provider executable
and runtime closure are copied into the content-addressed target release with
realpath/version/digest checks and auto-update disabled at every invocation.

The main database owns `provider_runs`. A row is inserted before connecting and
binds the run to the exact turn, bot owner, operation, provider/session request,
workspace-policy digest, broker invocation ID, child host PID/start-ticks/boot
ID/process group, PID/mount namespace inodes, and phases
`request_intent -> request_sent -> broker_accepted -> child_spawned ->
provider_acknowledged -> terminal`, plus terminal `definitely_not_started` and
`ambiguous`. The broker echoes the run/turn binding in every frame and refuses a
second start for either identity. Codex frames preserve
`initialize -> thread/{start|resume} -> turn/start -> turn/started ->
turn/completed`; Claude frames preserve exact initial replay, interrupt control
response, replacement replay, and final non-aborted result. The existing
provider-start classifier consumes only those broker-authenticated boundaries,
not socket writes or child stdout.

There is no unsafe reconnect to a live provider. EOF, peer-pidfd death, malformed
frame, broker timeout, or broker cancellation makes the broker synchronously
terminate the run's outer launcher/process group, wait until its exact host PID
and start ticks no longer exist, reap it, and only then emit or persist terminal
status. Simultaneous-connection tests prove per-stream run isolation and both
global bounds. `concierge-provider-broker.service` uses
`KillMode=control-group`; a broker crash/restart therefore kills every launcher
and descendant before the new invocation becomes ready. Main-state recovery
first authenticates a new broker connection and queries the exact run. It may
adopt a terminal broker result or proceed after the new invocation proves the
old broker invocation and child PID/start/boot identities dead; if the request
had reached `request_sent` without a provider acknowledgement, it records
`ambiguous/provider_start_unknown` and never starts another child automatically.
It cannot release or reclaim the owning turn/session lock while a matching
launcher or broker invocation is live.

Systemd 255 on AX41 has no `PrivatePIDs=` primitive, so the plan does not claim
one. Instead the sealed release supplies
`concierge-provider-sandbox-v1`, a narrow, non-setuid C launcher whose source,
static binary, syscall contract, and SHA-256 are release-manifested. Cutover
also renders an AppArmor profile whose attachment is the exact
content-addressed launcher path—not a mutable glob. The closed profile permits
`userns`, only the namespace-local `sys_admin`, `dac_override`, and
`dac_read_search` capabilities required by the attested setup sequence, private
mount propagation, tmpfs root, procfs inside that root, and bind mounts whose
sources are restricted to the sealed provider/runtime/tool roots plus configured
workspace/vault roots and whose targets stay beneath the per-run sandbox root.
It denies network/control/credential mounts and any executable other than the
manifested launcher/runtime closure. The release records the profile text,
parser binary/version, compiled policy digest, and expected audit-denial set.

Profile install, `apparmor_parser` load/replace, verification, rollback unload,
and prior-profile restoration are separate cutover journal intent/result phases
executed before the provider unit exists. Global disablement of
`kernel.apparmor_restrict_unprivileged_userns` is forbidden. Cutover
preflight must prove the deployed kernel plus that loaded profile permits an unprivileged
`CLONE_NEWUSER|CLONE_NEWNS|CLONE_NEWPID` launch by the exact
`concierge-provider` UID; absence or later disablement fails provider start
before exec. The launcher maps only its host UID/GID into the new user namespace,
makes mounts private, forks an inner PID-1 reaper, mounts a fresh procfs, pivots
into a tmpfs root, and bind-mounts only the read-only provider/runtime/tool
closure, the provider-owned home, and the request's one policy-approved
workspace/additional-directory set. It binds no bot/Slack/Monologue/control/
backup path and no broker socket. The outer launcher records the host child PID,
start ticks, boot ID, process group, and namespace inodes before the broker may
report `child_spawned`; on signal or stream loss it kills the namespace init and
reaps the complete descendant tree. Namespace setup and identity reporting are
covered by a host-kernel integration test, not inferred from systemd directives.

Bot, broker, Monologue poller, verifier, and projection worker still receive
separate systemd mount namespaces with `PrivateMounts=yes`, `PrivateTmp=yes`,
`ProtectProc=invisible`, `ProcSubset=pid`, `NoNewPrivileges=yes`,
`RestrictSUIDSGID=yes`, empty `CapabilityBoundingSet`/`AmbientCapabilities`, and
a service-specific `InaccessiblePaths` that includes
`/var/lib/concierge-operations`, `/var/backups/concierge`,
`/opt/concierge-control`, every restore/cutover journal and quarantine root,
`/etc/concierge`, all other units' credential source/destination paths,
`/run/systemd/private`, and `/run/dbus/system_bus_socket`. Each unit bind-mounts
back only its minimum allowlist; no unit receives the host root filesystem
through an allowlisted cwd or fd. Provider children receive the stronger
per-run launcher boundary above. Snapshot/cutover/restore units execute outside
those namespaces with their own exact credentials.

Runtime probes run from the real bot, broker, Codex, and Claude process
identities—not an approximate shell—and must fail to read direct privileged
paths, another service's environment/credential files, and every visible
`/proc/*/{root,cwd,fd}` alias to them; provider probes also prove a distinct PID
namespace inode, PID-1 reaper, absence of host proc entries, and broker-socket
denial. The real-UID probe also verifies the expected AppArmor profile label,
that the complete UID/GID-map/private-mount/tmpfs/proc/pivot sequence succeeds,
and that a launcher with a different inode/path/digest or an out-of-policy bind
is denied. Attempts to open systemd control sockets or join another mount/user
namespace also fail. The privileged unit must pass the inverse probe. Static
syscall/import/SQL audits, provider-environment allowlist tests, and wrong-token/
dead-owner/disconnect tests cover this privileged surface; root ownership, an
inaccessible direct pathname, or environment stripping alone is never cited as
isolation.

The bot/provider identity switch includes explicit provider-state and provider-
credential migrations, not merely new home directories. They deliberately have
different authorities. Under the cutover inhibitor and bot gate, after every
legacy Concierge bot and its Codex/Claude descendant is proven dead, a generated
closed `provider-state-v1.json` begins with every distinct provider UUID and
provider kind referenced by the main database. For Codex it resolves each UUID
through the source App Server/index to its exact rollout/session files and takes
fixed-helper Online Backups of every native SQLite store those resolved threads
require; it includes stable-read copies of non-secret `config.toml`, installation
identity, and the config-referenced plugin/skill/rule/memory package closure. For
Claude it resolves each UUID to the exact project/session JSONL/index entries and
includes stable-read copies of non-secret `settings.json`, `/root/.claude.json`,
and the settings-referenced plugin/skill/command closure. A stable-read copy
requires matching pre/post inode, size, mtime, and SHA-256 or retries after the
writer quiesces. Codex `auth.json`, Claude `.credentials.json`, every API key,
OAuth access/refresh token, and provider keychain material are unconditionally
excluded from this inventory and from every raw backup, rollback copy, and
generation. Global cache, logs, generated media, tmp, shell snapshots, stale
lock files, backups, and unrelated sessions are explicitly classified
`non_continuity_state` and are not silently treated as dependencies. An unknown
referenced path, open writer/lock for a referenced session, source/index race,
escaping symlink, or unresolved UUID stops migration. Curated global `AGENTS.md`
and canonical shared skills are not copied as mutable provider state; their
recorded immutable snapshot is bind-mounted read-only from the sealed release.

The driver copies the closed non-secret inventory into a same-filesystem
mode-0700 staging home, normalizes ownership to `concierge-provider`, fsyncs
every file and directory, and records source/destination manifests and digests
in the master journal before atomically renaming it to the dedicated provider
home. The old root-owned source remains unchanged through rollback and is never
mounted into the target. A separately journaled, manual `provider_auth_v1`
prerequisite then obtains one fresh supported credential for each enabled
provider directly into that dedicated home: Codex uses `codex login
--device-auth` as the target identity, or a dedicated API key delivered as a
systemd credential; Claude uses `claude setup-token` as the target identity, or
its supported dedicated service credential. Copying `/root/.codex/auth.json`,
`/root/.claude/.credentials.json`, a root refresh token, or any live credential
file is forbidden. The operator may retain independent root interactive login,
but only the target provider identity may mutate or refresh its own credential;
there is no credential sync in either direction. The journal stores only the
provider/account identity, source kind, target credential-file metadata and
digest, never credential bytes. Target-UID status and one bounded no-tool
provider health request must succeed both before and after a forced supported
refresh/re-auth cycle. Until that manual prerequisite passes, provider start
and production deployment remain blocked rather than borrowing the root login.

Continuity verification is a broker operation named `continuity_probe`, not an
ordinary Concierge turn and not a free-form provider request. The master journal
owns one closed row per provider UUID with immutable provider/session/workspace,
probe-prompt digest, target-state digest, start boundary, and phases `intent ->
sending -> accepted -> proved | absent | ambiguous`. It records no Slack turn
or external-effect row. For this phase root renders that closed request set to a
mode-0400 provider-readable, journal-digested one-shot manifest before starting
the broker, and launches a checksum-addressed credential-free submitter as the
real `concierge-bot` UID. The broker accepts only a byte-identical manifest row
and reports results to the submitter; neither process can read the root journal,
Slack credentials, or invent another UUID. Codex probes may use only App Server `thread/read` and
`thread/resume`; the broker rejects `turn/start`, tool execution, writable
mounts, and every operation other than resolving the exact UUID/workspace.
Claude lacks a side-effect-free read primitive, so its probe is exactly
`--resume <uuid> --fork-session --print` with one release-pinned inert prompt,
`--safe-mode`, `--tools ""`, `--strict-mcp-config`, an empty sealed MCP config,
one-turn and small-budget caps, provider-API-only network, a read-only workspace,
and bounded time/output. The resulting fork UUID is probe evidence only and is
never bound to Concierge. Pre/post manifests must prove the source session and
workspace unchanged; any tool request, filesystem write, non-provider network,
or unexpected event fails closed.

Because provider acknowledgement and the journal are not atomic, a dead owner
in `sending` is never blindly retried. Recovery scans the target provider index
inside the persisted start boundary for the exact parent/source UUID, immutable
probe digest, and target-state digest: zero matches permits one new attempt,
one exact match binds it, and multiple or unprovable matches become `ambiguous`.
Every proof resolves the expected UUID and workspace policy. A failed, absent,
or ambiguous UUID is atomically marked `archived_provider_state_missing` in the
main database and its visible Slack thread receives a deterministic reset notice
on the next user reply; it is never silently resumed or replaced mid-thread.
Provider state, proof results, archived dispositions, executable/runtime
manifests, and the main DB transition are generation inputs. Target provider
execution is forward-only after the first acknowledged target provider turn.

With acceptance, provider mutation, import, and every normal external effect
fenced, that core uses the fixed helper to copy main, queue, and
`/var/lib/concierge-operations/state.db` into the single snapshot staging slot.
The operations image intentionally records the active inhibitor/snapshot owner;
restore later rewrites it to its exact attempt. In that same staging directory
it creates a closed `provider-state-v1` bundle under the already-held provider
fence: Online Backup images for every native provider SQLite store plus
stable-read session JSONL/index/config/package files required by every main-DB
provider UUID, the provider-state inventory, and one explicit main-session
mapping whose disposition is `continuity_proved` or an archived terminal state.
The bundle excludes all credential bytes and the live provider home remains a
raw-backup exclusion. A referenced provider UUID without a bundled state object
and explicit disposition aborts the generation. The core fsyncs all three DB
images, the provider bundle, schema versions, release SHA, checksums,
generation/registry/fence/control-manifest digests, and sealed-release package,
fsyncs staging, atomically renames it to `generation-<id>`, and fsyncs the
generation root. The generation manifest enumerates every bundle file and binds
its digest to the same operation token and DB-image digests; there is no
separately timed provider backup. It then atomically writes+fsyncs a new catalog
revision with `ready=<id>`. A crash after rename but before catalog commit leaves
a final-name orphan: startup scans every
`generation-*`, and either adopts the sole directory whose manifest/token/hash
matches the interrupted operation or moves it into the one snapshot-quarantine
slot before another attempt. All other unreferenced directories are a hard
operator error; repeated crashes cannot create another workspace.

The immutable directory never stores upload state. When `ready` exists, restic
first uploads that exact generation and catalog. Machine-readable success moves
it to `uploaded(id,snapshot_id,created_at)` in a new fsynced catalog revision. If
three uploaded directories already exist, the same revision records the oldest
as `prune_pending`, temporarily bounding local uploaded content at four. Startup
finishes that phase before selection: delete only the exact pending directory,
fsync the parent, then remove its catalog entry/flag in another fsynced revision;
a missing pending directory completes the catalog transition. Restore quarantine
and snapshot workspace are separate bounded slots and never block each other.

A scheduled invocation is successful only after a generation created during
that invocation is uploaded. If it began with stale `ready`, it uploads and
settles that backlog, then sequentially creates and uploads one fresh generation
using the now-free ready/workspace slots. Failure leaves at most one ready item,
marks service health degraded, and transitions the owning
`snapshot_operations` row to `retry_pending` with attempt count, exact error
class, `next_attempt_at`, last fresh-generation creation/upload times, and the
still-owned ready/catalog identity. Backoff is 5, 15, 30, then at most 60
minutes with deterministic jitter and never moves the freshness deadline.

The coordinated `remote-box` release installs
`concierge-snapshot-retry.timer` with `OnCalendar=*:0/5`,
`AccuracySec=1m`, and `Persistent=true`; the database due time remains the
ownership authority, so calendar catch-up cannot run an early retry. Its
oneshot always executes a clock-owned health phase before deciding whether a
retry is due. In one immediate operations transaction it reads the durable last
fresh-upload timestamp and current wall-clock sample, clamps backward movement
without making the generation younger, records the sample, and sets or clears
the 26-hour overdue latch plus its desired projection revision. The projection
worker and `concierge-backup-health.service` then run on every invocation,
including when there is no retry row, no retry is due, the daily backup timer is
disabled, or the previous run succeeded. Only after that health phase may the
oneshot exit without snapshot mutation or adopt a due dead exact owner and
invoke the same snapshot/upload state machine. `Persistent=true` supplies one
boot catch-up; database timestamps, not timer monotonicity, decide age. A unique partial
index permits only one nonterminal snapshot/retry operation. The snapshot unit
has `TimeoutStartSec=45m`, `TimeoutStopSec=2m`, and `KillMode=control-group`;
the packaged restic child receives explicit connect/request low-speed timeouts,
and no invocation can remain a live owner beyond the service bound. A sealed
`ExecStopPost` finalizer uses the service result plus the exact token and dead
MainPID/start identity to persist a timeout or signal as `retry_pending` before
the next timer claim. Timer polling plus the durable row—not an in-memory
callback or `OnFailure` alone—survives reboot, a killed restic tree, and service
failure.

Success terminalizes the retry row and updates the durable last-fresh-upload
timestamp. The remote-generation objective is 26 hours: crossing it cannot
conjure success during a restic outage, but it atomically sets a latched overdue
row and advances the desired revision of the concrete
`concierge-backup-alert-v1` projection. Its root-only worker writes a mode-0600
`/var/lib/concierge-operations/backup-overdue.alert` by temp+fsync+rename and
marks that exact revision delivered; startup retries a pending/mismatched
projection. `concierge-backup-health.service` is the authoritative consumer: it
runs on boot and after every five-minute health evaluation, reads the DB latch (the file is human-visible
projection only), writes the exact generation/age/error to journald, and remains
failed while overdue. Deploy and machine-health checks require this unit
healthy. A fresh upload clears the DB latch and advances a clear projection;
that worker removes/archives only the matching alert revision before marking it
delivered, and the health unit then resets. No cross-filesystem/database
atomicity and no nonexistent mail, Slack, or host alert prerequisite is
assumed. A fixture with no `retry_pending` row and a 27-hour-old
last-fresh-upload timestamp must latch, project, and fail health on the next
five-minute invocation; a fresh upload must clear all three on the same path.
Normal retention is three uploaded
directories, transiently four only during the journaled prune phase, plus one
snapshot workspace and one restore quarantine. First upload, repeated restic
failure, stale-backlog recovery, reboot, dead-owner adoption, orphan-final-
directory adoption, prune crashes, hung-restic termination, catch-up, and RPO
reporting inspect actual restic selection and this exact alert target.

Restore is an explicit offline command, not service startup magic. It never
depends on the live operations database being readable. The first restore
action uses `O_CREAT|O_EXCL`, fsync, and parent-fsync to claim the one external
restore journal; an existing journal is adoptable only after its exact
PID/start-ticks/boot owner is proven dead. That journal plus a matching
token-bound catalog `restore_lease` is the sole offline singleton. Before
opening any replaceable DB, it records current edge and unit definitions/states,
places the edge in maintenance, inhibits Monologue and backup using persistent
masks, and stops every process that can open main, queue, or operations state.
This is the one explicit exception to operations-DB-first inhibition: it is
legal only for `restore`, only while the live operations DB is missing, corrupt,
or deliberately unopened, and only with the exclusive external journal/catalog
lease and all listed units proven stopped. If the live operations DB is healthy,
its current inhibitor state is copied into the journal for audit but it is not
trusted as the restore singleton.

Restore verifies the catalog's complete bounded generation set into same-
filesystem staging and uses the packaged fixed helper for every check. Before
it allocates the one snapshot workspace or asks the snapshot core for the
mandatory fresh generation, it resolves one selected restic snapshot's
machine-readable ID. It first executes the pinned argument vector `restic dump
<snapshot-id> /var/backups/concierge/catalog-v1.json`, streams stdout to an
exclusive staging file with a 1 MiB hard limit while hashing the raw bytes, and
requires stderr/status plus the catalog JCS digest contract. It builds the
closed referenced set from `ready`, every `uploaded` entry, and
`prune_pending`; the schema and retention invariant bound that set to five
distinct generation IDs, and aliases or a reference outside the generation root
fail.

For every referenced generation, including ones not selected as `ready`, the
helper executes the exact argument vector `restic ls --json --recursive
<snapshot-id> /var/backups/concierge/generations/generation-<id>`, requires one
regular manifest and exactly the regular files enumerated by it, and rejects
directories masquerading as files, special files, hardlinks, duplicates, or
extras. It then executes `restic dump <snapshot-id> <absolute-file-path>` once
per regular file—not the invalid colon-joined snapshot/path form—streaming raw
stdout into an exclusive file with the manifest-declared size cap and SHA-256.
Per-file caps, a 4 MiB manifest cap, and a 2 GiB aggregate restored-catalog cap
are checked before and during output; restic is killed on overflow, timeout, or
extra bytes. All `ls` and `dump` calls use the same exact snapshot ID. The
restored catalog/manifest/file digests must match, every catalog reference must
exist locally after atomic staging installation, and no unreferenced generation
is installed. Fixtures cover missing/extra members, `ready`, every uploaded and
prune-pending state, a directory passed to `dump`, spaces/colons in paths,
wrong-snapshot substitution, truncated stdout, oversized stdout, and a catalog
whose unselected uploaded generation is corrupt.

The restored catalog must name exactly one generation as `ready`; missing,
different, or multiple ready objects fail closed. A journaled catalog intent
then reclassifies exactly that generation as
`uploaded(id, selected_snapshot_id, restored_created_at, selected_snapshot_time)`
and clears `ready`. If this would exceed the three-uploaded steady bound it
enters and completes the existing `prune_pending` state before continuing.
Recovery compares the journal intent, selected snapshot ID, directory manifest,
complete catalog set, and catalog revision, so it either repeats or proves the same reclassification;
it can never substitute a different snapshot. This makes the slot available
without invoking restic while the restore lease is held. A normal successful
restic snapshot whose embedded catalog contains `ready != null` is a required
restore fixture.

As soon as the staged operations image passes read-only integrity and schema
validation, its journaled WAL-transform transaction installs the current
external restore token, original unit-state/hash snapshot, and inhibitor; from that point
all recovery uses both the external journal and the restored operations row and
requires them to agree. A missing/corrupt live operations DB therefore cannot
block the operation whose purpose is to replace it, and no normal DB user starts
during the offline exception. In their respective journaled WAL-transform
transactions, the staged images replace any stale main drain owner with a durable held
gate plus `restore_reconcile`, rewrites the copied main
`external_effect_snapshot_gate` as `restore_effect_hold`, and replaces the
queue snapshot gate with `restore_hold`. In the staged operations transaction,
it copies every nonterminal generation-era `snapshot_operations` and
`restore_operations` row into `operations_audit`, marks each copied row terminal
`restored_generation_source` bound to the selected generation and current
restore token, inserts the separately typed live `restore_operations` row, and
rewrites the inhibitor from the external restore journal's current-attempt token
and original unit-state/hash snapshot—not the historical values copied from the
generation. It asserts that no generation-era control operation remains
adoptable and that the current external-journal token is the sole nonterminal
restore authority. The queue, main-effect,
operations-inhibitor, and bot holds therefore have one recovery identity.
Queue acceptance and normal external-effect claims cannot resume until that
token is conditionally released after restore acceptance.

The generation helper deliberately emits standalone `DELETE`-mode images, so
restore has a separate closed `wal_transform` phase for each of `main`, `queue`,
and `operations` before any live-file move. For one image at a time it first
records `wal_transform_intent` with input digest, fixed SQLite source ID, exact
staging path, and expected schema mutation digest. The packaged SQLite runtime
opens only that staged image, executes `PRAGMA journal_mode=WAL`, requires the
single returned value `wal`, applies the token/fence/terminalization rewrites
above in committed transactions, executes `PRAGMA wal_checkpoint(TRUNCATE)` and
requires a fully checkpointed result, then closes. The helper fsyncs the main
file and staging directory and first requires no sidecar plus database header
bytes 18 and 19 both equal `2`, SQLite's persistent WAL read/write versions. It
then reopens through the exact percent-encoded URI
`file:<absolute-path>?mode=ro&immutable=1` with
`SQLITE_OPEN_READONLY|SQLITE_OPEN_URI`, while every DB user is still stopped,
for `integrity_check=ok` plus exact schema/state checks. It deliberately does
not query `PRAGMA journal_mode` on that immutable handle, because SQLite reports
`delete` there despite the WAL header. After close it rechecks the unchanged
main-file digest/header and rejects any `-wal`, `-shm`, `-journal`,
super-journal, or unknown sidecar. Only
then does the external journal record `wal_transformed` with the output digest.
A crash before the result may operate only on the same image-specific transform
staging path: matching output is adopted after full revalidation, matching input
is rerun, and every other byte/sidecar shape is quarantined and stops restore.

While all three DB users and the provider broker remain proven stopped, restore
moves the target provider session/config home—excluding its independently
issued credential paths—into an attempt-owned fsynced provider quarantine, then
installs the generation's complete `provider-state-v1` bundle through an atomic
same-filesystem rename. The external journal records every source, quarantine,
and installed provider-state manifest/digest before its corresponding mutation.
It restores the main database and provider bundle as one acceptance unit: every
main-DB provider UUID must resolve to the bundled object or the bundled archived
disposition, and no session file absent from the selected generation may be
silently retained. Target credentials are preserved separately and remounted
only after this relation passes. A crash can roll forward or back from the
journaled pair; it can never expose a restored main DB with newer provider state
or restored provider state with a newer main DB.

Restore then moves each destination
database together with any existing `-wal` and `-shm` sidecars into an
attempt-owned fsynced quarantine directory. It installs all three standalone
WAL-header images with no sidecars, fsyncs files and parent directories, and
repeats that same immutable URI integrity/schema/header/digest/no-sidecar
validation before any service opens the path. Every later writable runtime
connection verifies the returned mode is `wal` before beginning a transaction.
Consequently the exhaustive live file
set is exactly `{state.db,state.db-wal,state.db-shm}`. Restore fails closed before
the first move if `state.db-journal`, a super-journal, or any other unrecognized
SQLite sidecar exists, and it repeats that rejection before transform, install,
and verification. Pinned-SQLite fixtures prove that an ordinary read-only open
would create zero-byte WAL plus SHM and is therefore forbidden for closed-image
validation; positive immutable validation creates no sidecar, while a nonempty
WAL, SHM, wrong header, mutable URI, or changed main digest fails. Crash tests
cover every transform intent/result and live move/install boundary; a hot rollback-journal injection test proves it cannot survive
beside an installed image. The
quarantine is retained through acceptance and removed only by later explicit
cleanup after a new coherent generation succeeds. A crash resumes from the
journaled file-set phase; it never mixes any restored image with a stale WAL.
Only then does the orchestrator start the pinned restore-only entrypoint from
the generation's verified sealed-release package. The broker remains stopped
until reconciliation accepts the restored main/provider mapping and the fresh
target provider credentials pass their non-mutating health checks.

`restore_reconcile` is the first exclusive branch after database open. Before
creating timers, authenticating event ingress, starting Socket Mode or a
provider, or invoking generic startup recovery, the process checks this flag.
Restore mode starts no ordinary turn/output, status, summary, notice, reaction,
hourglass, inline-capture, List, Canvas, fork, comparison, capture-delivery,
projection, or periodic worker. The reconcile process itself may authenticate
only the read-only Slack/provider clients needed for the narrowly defined
audit. Its only external mutation is the registered restore-control
cutoff-sentinel operation below,
executed by a checksum-addressed privileged helper under the restore token and
exact bot credential; it cannot post arbitrary text or to an unconfigured
channel. Apart from those journaled retained sentinels it may write only the
reconciliation report/state. A database seeded with one pending row for every
normal side-effect worker must produce zero mutations attributable to those
rows; sentinel tests separately prove exactly one bounded control post per
admission channel and no other external mutation.

Restore reconciliation is schema- and code-driven, not a capture-only list.
`external-effect-registry.ts` is the typed source of truth for every family a
normal process may claim or project externally: ordinary provider execution and
response delivery; turn-status and cumulative-summary projections;
failure/recovery notices and reactions; inline capture, vault, and Slack List
writes/repairs; fork and comparison lifecycles; Canvas writes/refreshes;
capture import/delivery; Monologue post/classification; channel creation,
membership, project scaffolding, channel-ready post, and slash response; and
every periodic retry row. Its generated rows and digest are installed by
migration and copied into the release and backup manifests. A checked-in table
names every concrete Web API mutation (`chat.*`, `reactions.*`, `files.*`,
`conversations.create|join|invite`, Lists, Canvas), response-URL call, provider
operation, vault/project write, and subprocess that can mutate Git or the
filesystem, with exactly one registered family and recovery policy. The release
audit fails on an unassigned call site; this list is not illustrative.

`channel_provision_v1` makes `/new` and `channel_created` converge on one durable
intent keyed by team ID plus concrete Slack channel ID, or by the slash
`trigger_id` until Slack assigns that ID. Before `conversations.create`, the
slash path records requester, requested/canonical name, source channel, request
start, and states `intent -> creating -> channel_bound`. A definite failure may
retry; an ambiguous result or `name_taken` pages `conversations.list` and
`conversations.info` for the exact canonical name, bot/team identity, and a
creation timestamp at or after the intent. Zero remains retryable only after a
definite non-acceptance, one binds its Slack ID, and multiple/mismatched creator
or older channels park for operator choice. The `channel_created` event claims
the same channel-ID row, so it cannot race a second scaffold.

Bot join and requester invite are separate desired-membership rows under that
intent. Each reads complete current membership before mutation, records
`pending -> applying -> present | parked`, treats an already-present member as
success, and on ambiguous API completion rereads membership rather than blindly
repeating. The initial channel announcement is `channel_ready_post_v1`, with
exact immutable text/hash and registered metadata event
`concierge_project_ready_v1 {intent_id,channel_id,scaffold_digest,text_sha256}`;
it uses the same intent-before-post, exact-metadata read-back, one-match bind,
and zero/multiple ambiguity rules as capture delivery. The ephemeral slash
response is a final `slash_response_v1` row keyed by trigger ID and exact body;
it is attempted once only after the channel/scaffold/announcement are terminal.
Because response URLs offer no authoritative search, a lost or ambiguous result
parks and is never resent; the durable channel announcement is the user-visible
recovery surface.

`project_scaffold_v1` is keyed by bound Slack channel ID, canonical code/vault
paths, and scaffold-template digest. Its closed plan enumerates each mkdir,
atomic file content/digest, symlink target, local `git init`, ACL, and workspace-
policy mutation before applying any of them. Each mutation has intent/result;
recovery uses `openat2` beneath the two configured roots, rejects symlink or
inode substitution, and accepts only exact bytes/type/owner/ACL or applies the
still-missing operation. Existing contradictory content parks; it is never
overwritten heuristically. Initial cutover grants `concierge-bot` create/default
ACL on only the managed project roots. New directories are therefore bot-owned;
the bot may grant the provider ACL only on that newly owned exact tree. The
broker's sealed policy accepts a dynamic project path only beneath the managed
root when its inode owner is `concierge-bot`, its channel-ID xattr and scaffold
digest match the durable row, and its provider ACL is exact; legacy root-owned
projects must match the fixed cutover inventory. This permits no arbitrary ACL
or policy extension to a root-owned sibling.

Normal runtime contains no Git remote mutation. Existing project migration
commit/push code moves behind the cutover-only
`project_scaffold_propagation_v1` journal and checksum-addressed privileged
entrypoint; it is unreachable from bot/provider imports and runs only under the
master inhibitor with pre/post branch, upstream, tree, commit, and push result
recorded. Static subprocess/network tests prove normal `/new`, `channel_created`,
startup, and provider flows can at most perform local `git init`. Restore gives
every nonterminal provisioning, membership, scaffold, ready-post, slash-
response, and propagation row an explicit terminal/parked/manual disposition;
none is omitted from the restored-effect audit.

Every normal Concierge-runtime external mutation requires an opaque runtime
capability returned by the one restore-aware
`claimExternalEffect(family, row, owner)` API. A module-private
`WeakMap` binds each frozen capability object to its exact family, row, lease
owner, nonce, and database generation; no constructor or signing secret is
exported. Each Slack/provider/filesystem/List/Canvas/import/scheduled mutation
gateway validates the object identity and binding, rechecks the live owner and
absence of restore/snapshot fences, and consumes or advances it according to
that family's registered lease contract before calling a private lower-level
primitive. A structurally similar object is rejected at runtime, so correctness
does not depend on Bun typechecking TypeScript. Branded types remain developer
ergonomics only.

A closed release executable inventory covers every systemd `Exec*`, timer
target, worker-thread entrypoint, shell/Python/native helper, and subprocess
path. The replacement Monologue poller and seen-projection worker are sealed
TypeScript entrypoints in the same release and capability graph; no retained
Bash/Python poller can reach Slack, the main DB, or the seen file. The fixed C
snapshot helper is privileged control-plane-only and its exact syscall/path
manifest is audited separately. Every external program whose output is parsed
to authorize a durable transition—including Monologue, restic, systemctl, and
the release/deploy control tools—is either copied into the applicable immutable
release or has its absolute realpath, owner/mode, version output, binary SHA-256,
dependency/runtime closure, and parser contract revalidated at each use. The
machine-level backup units execute only the content-addressed `remote-box`
release described above. Any unlisted or mutable executable, or effect-capable
non-TypeScript wrapper, fails sealing and cannot advance state.

For every inventoried TypeScript entrypoint, the release audit parses its
import/call graph and SQL, rejects direct Slack mutation/fetch/provider-spawn/
filesystem-effect calls outside the allowlisted gateways, rejects effect-intent
or lease SQL outside the central state module, and proves that every registered
family has a restore disposition. Focused tests bypass TypeScript with forged
objects and direct JavaScript calls and require runtime refusal. Normal startup compares the
compiled, database, release-manifest, and generation registry digests and fails
closed on any difference. The existing unconditional startup Canvas sync is
removed: Canvas/List repair is represented by registered durable rows, and after
restore no row may be synthesized solely from a nullable restored cache until
the operator has reconciled current Slack inventory for that family.

The offline reconcile transaction tags every row present in the restored image
with the selected generation and gives every nonterminal/retryable row an
explicit `delivered`, `terminal`, `parked_restore`, or `restored_review`
disposition. The central claim API refuses pre-restore rows without an accepted
disposition and refuses quarantined families. It never merely leaves an old row
in a state that ordinary startup recognizes as claimable.

Reconciliation compares immutable delivery snapshots with the retained queue
ledger and scans the full accessible Slack metadata interval from the
generation completion boundary through restore time. App-owned metadata is the
only positive Slack proof. A generation proves state only at its own snapshot;
it cannot prove that Slack/provider effects did not occur afterward. Therefore
every restored effect that was not already terminal or cannot be made terminal
with affirmative external evidence enters `restored_review`, including a
pre-delivery snapshot with zero current Slack matches. Deleted, inaccessible,
zero-match, or missing provider evidence is ambiguity, never automatic retry.
Ordinary provider sessions restored with a provider UUID are set
non-resumable/archived unless the report contains exact provider-specific proof
of their terminal boundary; no pre-generation session is eligible for normal
resume merely because its local turn appears idle. The supported recovery
point objective is the selected generation plus an explicit manual audit of
every post-generation external-effect uncertainty; this release adds no
separate replicated effect journal. An operator may authorize retry
event-by-event only through an audited decision.

Slack evidence can also reveal a metadata-authenticated Pebble or
self-describing HMAC-authenticated Monologue message created after the selected generation for
which neither restored
database contains a row. Reconciliation materializes a permanent orphan
tombstone with the exact external identity, payload hash, timestamp, schema,
and audit evidence; it never reconstructs and reruns the provider turn from the
Slack text. Evidence absence cannot enumerate deleted, inaccessible, or not-yet
posted source inputs, so restore also creates a source quarantine:

- the pre-restore Pebble `route_id` and bearer are permanently disabled. The
  operator must create a new route namespace and bearer, record its activation
  time and a `recordedAt` cutoff after restore acceptance, and reconfigure the
  device. Requests to the old namespace are rejected for manual audit, and the
  new namespace rejects source records at or before the cutoff;
- Monologue remains inhibited while the operator records a new source epoch,
  an upstream inventory/high-water mark, and a creation-time cutoff. Every
  enumerated note at or before that boundary becomes a no-repost tombstone,
  whether or not Slack evidence exists. If the upstream cannot prove complete
  inventory or a trustworthy creation boundary, the old epoch remains disabled
  and only notes provably created after a newly recorded cutoff are eligible.

This may deliberately skip an uncertain old recording; it cannot duplicate an
old Slack post or agent run. No restored source namespace resumes automatically.

Ordinary Slack input gets the same conservative source boundary. While Socket
Mode remains disconnected, the restore control plane creates one visible,
bot-authored top-level cutoff sentinel in every configured admission channel.
The raw restore token never leaves the host. Its non-secret public identity is
the 64-character lowercase hexadecimal
`attempt_digest = SHA-256(tuple-v1("restore-cutoff-attempt-v1", restore_token,
selected_generation_id, selected_catalog_revision))`. The exact UTF-8 text is
`Slack Concierge restore cutoff · do not delete · <first-32-lowerhex-attempt_digest>`;
`text_sha256` hashes those exact bytes. Metadata event
`concierge_restore_cutoff_v1` has exactly five string fields:
`attempt_digest`, `selected_generation_id`, decimal `catalog_revision`,
`channel_id`, and `text_sha256`. A deterministic UUIDv5 over
`tuple-v1("restore-cutoff-client-v1", attempt_digest, channel_id)` is sent as
`client_msg_id` only as a duplicate hint; read-back never depends on it.

Before each post the helper performs `conversations.history(limit=1)` and
persists an immutable `recovery_oldest_exclusive`: the returned current head
timestamp, or the explicit `empty_channel` marker. It never derives this bound
from a later scan. The fixed external journal then creates that channel's closed
entry with the five immutable metadata values, expected app/bot IDs, exact text,
request-start timestamp, client UUID, the lower bound, and phases
`intent -> posting -> bound | searching -> bound | parked`. Slack success
journals the returned Slack-issued timestamp and exact response metadata. An
ambiguous post first performs one new `conversations.history(limit=1)` and
persists that returned timestamp as immutable `recovery_latest_inclusive`; an
empty result when the pre-post state was nonempty, or vice versa, parks. It then
reconciles only the frozen interval `(recovery_oldest_exclusive,
recovery_latest_inclusive]` through `conversations.history` with explicit
`oldest`, `latest`, `inclusive=true`, and `include_all_metadata=true`, persisting
each request cursor, returned next cursor, ordered message digest, and candidate
timestamp before advancing. For a previously empty channel, `oldest` is omitted
and `latest` remains fixed. A positive match requires exact channel, app ID, bot
ID, event type, all five payload fields, and byte-identical text; one binds it,
while zero or multiple after two byte-identical complete interval scans park the
restore and never repost. A definite Slack rejection before acknowledgement may
retry the same generation. An expired cursor restarts from the first page with
the same bounds and must reproduce the complete ordered interval and candidate
digests; any edit, deletion, boundary change, or inconsistent page parks. The
sentinel is retained as restore
evidence and explicitly ignored by both bot authorship and an explicit metadata
event-type rejection in capture/Monologue reconciliation—there is no later
deletion effect and it can never become `concierge_capture_v1` evidence.

That returned sentinel timestamp becomes both `restore_input_cutoff_ts` and the
immutable inclusive upper bound of the old-epoch audit; the lower bound is the
literal persisted Slack epoch `0.000000`, never the oldest row observed during a
page. Reconciliation performs two complete passes with
`conversations.history(oldest="0.000000", latest=<sentinel>, inclusive=true,
include_all_metadata=true)` and calls bounded `conversations.replies` with the
same `latest` for every thread root. It persists the exact ordered root/reply
identity, timestamps, edited/deleted flags, and content/metadata digests. Both
passes must reproduce the same complete set and terminal cursors; an expired
cursor restarts that pass from its immutable bounds. It fails closed on any
edit, deletion between passes, inaccessible, truncated, cursor-inconsistent, or
incomplete page. A reply created before the
sentinel is therefore inside the closed audit even when its root is old; a reply
created after it has a greater Slack-issued timestamp and is outside the old
epoch. Newly configured or inaccessible channels stay disabled.

The restored schema adds terminal claim kind `restored_review`. After normal
Socket dispatch starts, the central pre-routing input-claim transaction compares
every otherwise unclaimed user event with that channel sentinel cutoff. A
timestamp at or before the cutoff is durably classified `restored_review`,
records the complete recovery envelope and selected generation, and queues one
deterministic resend/manual-review notice; it can never reach a provider
automatically. A timestamp proven greater than the cutoff follows ordinary
classification. An existing exact claim remains authoritative. Thus a delayed
or retried pre-restore Socket envelope cannot recreate post-generation provider
work that the restored DB no longer knows, while genuinely newer messages
remain usable. Tests cover roots and replies on both sides of every sentinel,
ambiguous sentinel acknowledgement, old-root/new-reply races, and a missing
channel sentinel.

The report is accepted through one operator-token-conditional transaction that
records its digest and every decision, installs the new source boundaries, and
then advances restore mode to `accepted_pending_projection`. That transaction asserts that the restore
registry has zero pre-generation auto-claimable rows and that there is no
resumable provider session without exact terminal/boundary proof. It then
creates and delivers the mandatory Monologue seen-file repair revision. While
all holds and backup inhibition remain owned by the same restore token, the
orchestrator delegates to the snapshot core, creates the required fresh local
coherent generation, and clears the catalog restore lease as specified above
while retaining the fixed-path restore-admission journal. The restore-only process
exits only after those exact results are durable; the orchestrator starts a
fresh normal process, requires current-invocation health while every hold still
exists, and only then conditionally releases main `restore_effect_hold`, queue
`restore_hold`, bot hold, operations inhibitor, Monologue/backup holds, and edge
in reverse acquisition order using the same restore token. A dead-owner adopter
must replace the owner on every hold before continuing; it cannot release only a
subset. It restores every recorded prior unit/edge state, rechecks normal
health, and retires the fixed journal to audit as the final mutation using the
protocol above. It never
changes a live process from restore mode into general service. Restores outside retained detailed-history
horizons remain held for a broader Slack/provider audit and are not advertised
as automatically replay-safe.

### 3. Post with the bot and bind admission atomically

Trusted capture delivery and dispatch state lives in the main Concierge
database and uses these owner-guarded transitions:

| State | Owner | Allowed transition and proof |
|---|---|---|
| `pending` | none | `-> sending` only when route is enabled, gate is absent, pending limits permit, an external-turn slot is reserved, and the destination-channel capture barrier is installed in the same transaction; disabled route/permanent policy failure `-> parked` |
| `sending` | exact process | Slack success with timestamp, exact app-owned metadata, and no truncation warning persists the timestamp, narrows the barrier to that exact root, and `-> routing` in one transaction while retaining the slot; success with a timestamp but missing/mutated metadata or `message_truncated` warning `-> parked_unknown` with that timestamp and exact-root barrier; definite transient failure before Slack acceptance `-> pending` and removes the barrier; definite permanent failure `-> parked` and removes it; ambiguous result or proven-dead owner `-> send_unknown`, retains the channel barrier, and releases the slot |
| `send_unknown` | none | after delay `-> reconciling` with an exact owner and persisted search boundary/attempt |
| `reconciling` | exact process | one exact app-owned metadata match persists its timestamp, narrows the barrier to that root, and `-> posted`; multiple matches persist exact-root barriers for every match and `-> parked_unknown`; marker-only or zero metadata matches after two paged checks at least 30 seconds apart `-> parked_unknown` with the channel barrier retained; definite transient search error `-> send_unknown`; dead owner `-> send_unknown` |
| `posted` | none | `-> routing` with a newly reserved slot only when gate/limits permit and the exact-root barrier still matches; disabled route or conflicting input provenance `-> parked` |
| `routing` | exact process | atomic input/session/turn bind `-> turn_bound`; conflicting claim/permanent admission failure `-> parked`; proven-dead owner `-> posted` and release slot |
| `turn_bound` | none | startup/live dispatcher `-> turn_starting` with an exact owner while preserving the slot |
| `turn_starting` | exact process | exact provider initial-prompt acknowledgement `-> router_admitted`; definite pre-start failure `-> turn_bound`; ambiguous start or dead owner `-> provider_start_unknown` |
| `router_admitted` | none | terminal capture-delivery state linked to one provider-started turn; its slot remains charged until that turn is terminal |
| `parked`, `parked_unknown`, `provider_start_unknown`, `restored_review` | none | terminal/manual states counted against pending capacity until an audited operator archive, reconcile, or explicit retry transition |

Every owned transition compares event ID, expected state, owner instance, PID,
boot ID, and process start time. A transition that changes zero rows is a lost
lease, not success. Reconciliation persists its lower Slack time boundary,
inclusive upper Slack time boundary, first-zero time, page cursor, attempt, and
owner. Before `chat.postMessage`, the sending owner reads and persists the
channel's current head as `search_oldest_exclusive`, or an explicit empty marker.
After an ambiguous call and before `reconciling`, it reads and permanently fixes
`search_latest_inclusive`. Every retry and cursor restart searches only that
interval. `send_unknown`, `posted`, and
quota-waiting rows do not retain an owner, turn slot, or deployment exclusion.
Every nonterminal state above has the stated startup recovery edge; no other
edge is legal.

Capture root ownership precedes Slack visibility. `pending -> sending` creates
a durable channel-wide reservation because the future Slack timestamp is not
yet known. The Slack-success transaction replaces it with an exact
`channel_id/thread_ts/event_id` reservation before any user event can be
classified normally. `send_unknown` retains the channel-wide reservation until
reconciliation discovers the exact timestamp or an operator disposes the
ambiguity; this can intentionally pause ordinary admission in that channel.
`posted` and every timestamp-bearing parked state retain an exact-root
reservation. The reservation is removed only after an exact session binding is
durable or the operator proves that no Slack root can exist.

Before provider/session routing, every Slack user event checks these
reservations in the same immediate transaction as its input claim. While a
channel-wide reservation exists, or when its `thread_ts` matches an exact
reservation, the event is classified as `capture_barrier_wait`; it cannot fall
through to the channel's shared `single-persistent` session or claim any idle
session. That classification is terminal and atomically creates its own pending
deterministic resend notice immediately; it never waits for the capture outcome.
The notice worker posts in the input's original visible thread and uses the
existing durable lease/retry/park contract. Reservation removal, narrowing,
binding, route disablement, send failure, reconciliation, and operator
disposition therefore cannot strand or reactivate a waiter. The original text
is preserved for audit but is never automatically presented to a provider.
Tests cover an event delivered before the Slack post response, after timestamp
persistence but before binding, every transition that removes or narrows the
reservation, notice delivery crashes, and crashes at both bind boundaries.

At trusted import, the main row receives an immutable delivery snapshot:
destination channel, expected Slack `app_id` and bot ID, route-contract and
render-contract versions, normalized renderer inputs, exact final envelope,
its UTF-8 byte length, full event ID, payload hash, and the first 32 hexadecimal
event-ID characters used as the visible marker. Import recomputes the shared
golden contract and refuses any queue/config disagreement. Later route edits
cannot change an accepted event's destination or rendering.

Slack delivery uses the existing bot token with `mrkdwn=false`,
`unfurl_links=false`, and `unfurl_media=false`. The exact stored text envelope
ends with the visible 128-bit marker, such as
`— Pebble Index · capture 8f31c1e2b3a477a942ea71c5d3c6e901`.
The request also carries documented message metadata with
`event_type="concierge_capture_v1"` and an `event_payload` containing the full
event ID, payload hash, route-contract version, and render-contract version.
`client_msg_id` may be sent as an additional best-effort duplicate hint, but
recovery never relies on that undocumented request field. A nominal Slack
success is accepted only when its response has a timestamp, the exact metadata,
and no `message_truncated` warning; a mutated/truncated success is durably
parked with the returned timestamp so it cannot be resent automatically.

Before cutover, the repository's existing `slack-app-manifest.json` registers
three top-level schemas. `metadata_events.concierge_capture_v1` is a `type=object`
with `additionalProperties=false` and four required `type=string` properties
(`event_id`, `payload_hash`, `route_contract_version`, and
`render_contract_version`).
`metadata_events.concierge_restore_cutoff_v1` is a `type=object` with
`additionalProperties=false` and the five required `type=string` properties
`attempt_digest`, `selected_generation_id`, `catalog_revision`, `channel_id`,
and `text_sha256`.
`metadata_events.concierge_project_ready_v1` is a `type=object` with
`additionalProperties=false` and four required string properties `intent_id`,
`channel_id`, `scaffold_digest`, and `text_sha256`. No schema accepts another's
fields, and every reconciler has negative fixtures for the other event types. The manifest adds
`metadata.message:read` to the bot scope list. Monologue deliberately does not use message metadata: Slack's documented
contract rejects metadata that is not sent as the app, while its retained flow
must remain user-authored. The
manifest is validated, uploaded to app `A0BNG0WHUNQ`, and the existing app is
reinstalled through OAuth v2. The result must contain and validate both the
top-level bot access token and `authed_user.access_token`; the existing Socket
Mode app token and signing secret are preserved from the staged complete config
and revalidated. One root-owned staged `slack.toml` is written atomically only
after `auth.test` proves expected workspace/bot/user identities and exact bot/
user scopes and `apps.connections.open` proves the preserved app token. The
cutover journal pins the manifest/config digests, app/workspace/bot/user
identities, and exact `X-OAuth-Scopes` responses without storing token bytes.
The reinstall is illegal until the journal owns the Monologue inhibitor and bot
gate and proves both old token consumers stopped; afterward no process may start
with the old config, even on pre-data rollback.
Edge acceptance is forbidden until a labeled bot-token capture message carries
its registered schema and can be read back through
`conversations.history?include_all_metadata=true` with the exact payload.
The checksum-addressed restore-control helper must also post one labeled
`concierge_restore_cutoff_v1` schema probe under the cutover token, read it back
with the exact five-field payload/text/app/bot identity, classify its known
timestamp `ignored` before Socket Mode can start, and persist its result in the
cutover journal. The helper cannot vary the event type, text template, fields,
or configured channel.
Monologue receipt migration is separately forbidden until a labeled user-token
message can be read back with the exact expected user ID, text/payload hash,
and valid receipt HMAC described below. Each is removed or retained as an
explicitly labeled test artifact. Schema warning, discarded capture metadata,
missing scope, authorship mismatch, invalid HMAC, or any credential mismatch
fails closed.

Ambiguous reconciliation calls `conversations.history` with
`include_all_metadata=true`, `oldest=<search_oldest_exclusive>`,
`latest=<search_latest_inclusive>`, and `inclusive=true`; the empty-channel
variant omits `oldest`. Cursor expiry restarts at those same immutable bounds
and compares the complete ordered message/candidate digest, not the prior page
layout. Any edit, deletion, bound change, or inconsistent second complete scan
parks. The only positive proof is exactly one
top-level message matching channel, expected `app_id`, bot ID,
`event_type="concierge_capture_v1"`, full metadata event ID/payload hash/
contract versions, and visible suffix. A visible marker without this metadata
is zero proof. The two-check consistency window improves discovery; it never
proves absence. Therefore a marker-only result, zero metadata matches, or
multiple matches parks as `parked_unknown` and never automatically reposts. An
operator may retry only after recording an explicit Slack audit. The manifest
scope set is live-probed for metadata-bearing history before the edge can enter
accepting mode; failure closes the rollout without adding another scope.

Because the Slack post is bot-authored, the ordinary Socket handler ignores its
echo. The delivery worker alone calls `bindExternalCaptureTurn`. That function
has one immediate main-database transaction which:

1. verifies the delivery row is `routing` and owner-guarded;
2. inserts or validates an input claim with `kind='turn'`,
   `origin_kind='external_capture'`, and `origin_id=event_id`;
3. creates a fresh explicit session rooted at the Slack timestamp, regardless
   of the channel's `single-persistent` setting;
4. creates one ownerless `capture_bound` turn and a `capture_reserved` fresh
   session under the configured default provider; neither is yet executable
   through ordinary admission;
5. links the concrete turn ID to both the claim and capture row; and
6. changes the capture row to `turn_bound` and removes the exact-root barrier
   without claiming provider start.

Existence of a `pending`, `ignored`, `draining`, inline-capture, busy, or
cancelled claim is never success. If an identical turn binding already exists,
the transaction validates all links and returns it idempotently. Any conflicting
claim parks the capture rather than silently adopting ordinary routing.

A durable external-turn dispatcher owns `turn_bound`. One `BEGIN IMMEDIATE`
claim verifies the persisted canonical input and all links, changes capture
`turn_bound -> turn_starting`, changes turn `capture_bound -> running` with the
exact process owner, and changes only that session `capture_reserved -> running`.
The ordinary session-acquisition predicate is tightened globally to require
`status = 'idle'` exactly; `capture_reserved`, `running`, `error`, archived, and
every future non-idle state are ineligible. The dispatcher then hands that
valid ordinary running turn to the existing executor through a typed capture-
admission mode; no parallel delivery executor or alternate post-start turn
lifecycle is introduced.
Provider transports must report exactly one admission outcome after teardown:

- `definitely_not_started`: failure was proven before any provider request or
  initial prompt bytes began writing;
- `acknowledged`: Codex emitted the matching `turn/started` identity or Claude
  replayed the exact initial user message, including the provider session/turn
  identity that transport can prove; or
- `start_unknown`: request/prompt writing began but the exact acknowledgement
  was not observed, including timeout, malformed response, process death, or
  database acknowledgement failure.

These are typed transport results, never inferred from error text. Once writing
begins, only exact acknowledgement can avoid `start_unknown`. Capture mode
disables `executeAgentTurn`'s successful-result fallback that ordinarily writes
`provider_started_at`; before acknowledgement, its generic catch path delegates
to the typed admission settlement instead of terminalizing by itself.

Each outcome has one owner-guarded main-database transaction over capture,
turn, session, and the derived slot invariant:

- `definitely_not_started` changes capture `turn_starting -> turn_bound`, turn
  `running -> capture_bound`, clears the exact owner, and unlocks only its exact
  session to `capture_reserved`; `turn_bound` continues to consume the same
  derived slot and ordinary input cannot acquire it;
- exact acknowledgement sets `turn.provider_started_at`, records the proven
  provider identity, and changes capture to `router_admitted`, leaving the turn
  and session in the ordinary `running` path. From that commit onward the
  existing `running -> delivering -> done/error` executor and session-release
  transactions are authoritative, and capture-linked terminalization updates
  the derived slot accounting in the same transaction; and
- `start_unknown` changes capture to `provider_start_unknown`, turn to a new
  terminal/non-relaunchable `capture_start_unknown` status with `ended_at`,
  clears the owner, and moves its reserved session to `error`. Because the child
  is proven torn down before settlement, the active-turn slot is released, but
  the capture continues to count against pending/manual-review capacity.

If acknowledgement is observed but its database transaction cannot be proven,
the transport tears down and settles only as `start_unknown`; it never proceeds
to normal output delivery. Startup recovery validates the allowed capture/turn/
session triples as one invariant: it launches only ownerless
`turn_bound/capture_bound/capture_reserved`, applies ordinary running recovery only to an
already `router_admitted/running/running` triple, and maps every dead or
inconsistent pre-ack owner to the non-relaunchable unknown triple. Focused crash
tests cover every transaction boundary and prove that the ordinary delivery
and session-release predicates each update exactly one row after acknowledgement.

Capture turns use a fixed prebuilt prompt that labels authenticated transcript
content and disables provider/model/reasoning selectors, skills, inline capture,
Slack-link hydration, attachments, and steering. The router remains allowed to
act on spoken directives; the route bearer is therefore an agent-authority
credential, bounded by the trusted quotas above and a maximum of two active
external turns.

Slot accounting is a database invariant, not worker concurrency. One event
counts once while it is `sending`, `routing`, `turn_bound`, or `turn_starting`,
and afterward while its linked turn is nonterminal. The bind transaction
transfers the same reservation to the turn. Every path from an unreserved state
into `routing` reacquires capacity. Turn terminalization/recovery releases the
slot in the same main-database transaction; an interrupted or parked provider
turn is terminal for quota purposes. Main pending capacity counts every capture
except `router_admitted` linked to a terminal turn and explicitly archived
manual states; `send_unknown` and all parked/review states therefore apply
backpressure until resolved.

Terminal work is bounded separately from pending and slot counts. Capture turns
have a 512 KiB maximum persisted provider-output budget; the streaming
accumulator terminates and stores a bounded diagnostic/hash if that limit would
be exceeded. Before import or dispatch, one immediate transaction derives
current unarchived capture bytes from stored byte counts plus 512 KiB for each
active capture turn. It admits work only while there are at most 10,000
unarchived capture events and at most 512 MiB of capture-owned transcript,
envelope, canonical input, provider output, and projection text. At 80% it
alerts; at the hard limit import stops, leaving work in the bounded queue and
eventually returning `503`. Capture authority can therefore degrade availability
but cannot consume the main database without a reviewed bound.

Automatic main compaction is limited to `router_admitted` captures whose linked
ordinary root turn is terminal. Parked, unknown, conflicted, and restore-review
states retain detail until explicit operator disposition. The session must be
`idle`; no turn in it may be running or delivering; no input claim, steering,
response/status/summary/notice/reaction/List/Canvas projection, fork, or
comparison may be pending; and at least 30 days must have elapsed from
`sessions.last_turn_at`, which advances on every accepted visible-thread input,
not merely from the capture root. An owner-guarded transaction then creates or
verifies an immutable main tombstone with event ID, payload hash,
route/contract versions, Slack timestamp, provider terminal outcome, and
archive time. It clears only capture-owned fields of the root turn: transcript,
renderer inputs, exact capture envelope, root canonical replay, root
user/agent/outbound text, root response TL;DR, and already-delivered root
projection bodies. It marks that root `archived_capture` but never archives the
session, its provider UUID, or later turns and never removes later projection
bodies.

The visible thread remains a normal conversational session. An operation whose
requested comparison/fork/replay boundary requires the compacted root fails
with an explicit archived-history error; later turns and future conversation
are otherwise unaffected. The Slack root and small provenance IDs remain.
Main tombstones count toward a hard 60,000-row
capture limit and are never automatically deleted; reaching it fails closed
before queue import. Changing route ID cannot relieve this global limit; main
import remains exhausted until the same independently reviewed bound-expansion
release changes both ledgers consistently. Crash-safe tests prove either full detail or the complete
tombstone exists, never neither, and incremental vacuum is a separate bounded
maintenance step after commit. Backup manifests record whether each database
contains detail or tombstone form so restore never expects compacted replay
material.

### 4. Make routes data, with least-privilege views

`config/capture-routes.toml` remains the source of truth. Deployment renders:

- an ingress view containing paths, adapters, public request credential names,
  body limits, and queue endpoint identity;
- a queue view containing versioned route-contract IDs, immutable identity/
  payload/render versions, exact rendering label/overhead, and trusted
  acceptance/retention quotas, but no destination;
- a bot view containing the same versioned route-contract IDs, allowed Slack
  destination, exact render contract and app-owned metadata contract, trusted
  pending/turn quotas, and no request credentials.

Ingress never receives the Slack channel or any Slack credential. Queue records
never accept a client-supplied destination or rendered message. The broker
stores the trusted route/render versions and accepted byte length; the bot
derives the destination/envelope/metadata from the matching trusted installed
contract and snapshots them immutably on import. Deployment compares both
views' shared contract digest and refuses a missing or in-place-mutated
contract. A removed/disabled route parks pending trusted rows without posting.

The multipart transcript adapter is source-neutral. A new transcript source
requires a route declaration and credential, not another Slack writer. Pebble's
current fields map directly; Monologue can adopt the same contract later using
its stable note ID, but this release changes only its receipt durability, not
its route or authorship.

### 5. Use one durable deployment gate

The main `deployment_drain` row gains an explicit mode:

```text
absent -> draining(live exact owner) -> held(durable) -> adopted(new owner)
                                                    -> released after health
```

- Gate claim is one immediate transaction that refuses while any live provider
  turn or capture `sending`, `routing`, or `turn_starting` owner exists.
- Provider-turn, capture-send, capture-routing, and external-dispatch claims all
  refuse while any gate row exists.
- `draining -> held` is token- and owner-conditional.
- Failure cleanup may delete only a `draining` row still owned by that same live
  process. It can never delete `held` or an ambiguously committed transition.
- Bot startup never auto-clears `held`. It may recover a dead `draining` owner
  only through the same exact dead-process proof used elsewhere.
- `--adopt-held` proves the prior owner dead and atomically installs the new
  owner/token without opening admission.
- Release is token-conditional and occurs only after current-invocation bot,
  Slack, queue, ingress, and capture-worker health succeeds.

Capture worker readiness means schema/config/auth are valid and the worker is
intentionally paused by the held gate; it does not require a delivery claim.

A backward-compatible Monologue receipt prerequisite is deployed and proven
before the capture cutover. It adds a versioned
`monologue_delivery_receipts` table to the main database and makes that table,
not the text seen file, the sole post-migration delivery authority. The seen
file remains a rebuildable projection for compatibility and observability.
Every receipt has an exact process owner where applicable and follows only:

| State | Allowed next state |
|---|---|
| `pending` | owner claim `-> sending` |
| `sending` | exact Slack success `-> posted`; ambiguous/dead owner `-> send_unknown`; definite retryable failure `-> pending`; permanent failure `-> parked_unknown` |
| `send_unknown` | owner claim `-> reconciling` |
| `reconciling` | one exact message `-> posted`; zero/multiple/mutated or permanent evidence failure `-> parked_unknown`; transient/dead owner `-> send_unknown` |
| `posted` | integrated bot claim `-> classifying`; permanent message/provenance failure `-> parked_unknown` |
| `classifying` | exact durable input classification `-> classified`; safe no-claim dead-owner recovery `-> posted`; ambiguous/dead claim or permanent failure `-> parked_unknown` |
| `classified` | terminal delivery authority; may repair the seen projection |
| `legacy_no_repost` | terminal migration/restore authority; may repair the seen projection |
| `parked_unknown` | terminal manual-review authority; never enters the seen projection or retries automatically |

Before changing `pending -> sending`, the poller persists the destination's
current Slack head as `search_oldest_exclusive`, or an explicit empty-channel
marker. An ambiguous/dead send fixes `search_latest_inclusive` from one bounded
head read before entering reconciliation. Every search and cursor restart uses
only that immutable interval and two complete scans must reproduce the same
ordered identity/content set; edits, deletions, or changed bounds park.

Discovery is an explicit durable scan, not a recent-note window. At cycle start
the poller records a UTC `created-before` boundary and begins cursor pagination
with pages of at most 100 (or uses the CLI's equivalent `notes all` contract).
The upstream cursor is opaque: no page ordering, monotonic timestamp, or stable
position is assumed. The scan maintains a durable whole-scan set of stable note
IDs and rejects any ID repeated within a single returned page or in a different
successfully committed page. After fetching a page, it validates the complete
response in memory, then one immediate SQLite transaction inserts or validates
every page receipt/tombstone and whole-scan-set member and advances from the
exact request cursor to the exact returned cursor or terminal exhaustion. The
transaction records a page digest keyed by the request cursor, so refetching the
same cursor after a crash is idempotent only for the identical page; a changed
page or duplicate from another cursor is a hard conflict. A page/API/JSON/
transcript failure commits neither members nor cursor and is never treated as an
empty result. Only explicit cursor exhaustion marks that source scan complete;
notes created after its boundary belong to the next scan. There is no durable
“last seen” source boundary that can advance past a note lacking a receipt.

The new poller has one byte-level `monologue-payload-v1` contract; it does not
inherit Python's version-dependent `str.strip()` behavior. `note_id` is the
strictly decoded upstream JSON string, nonempty and capped at 128 UTF-8 bytes,
with no normalization. `title` must be a JSON string or null; CRLF and bare CR
become LF, then only leading/trailing U+0009, U+000A, and U+0020 are removed.
Null or an empty result becomes the literal ASCII `(untitled)`; the result is
capped at 512 UTF-8 bytes. `recorded_at` must be a strict RFC 3339 string whose
first sixteen ASCII bytes have the exact `YYYY-MM-DDTHH:MM` shape; those sixteen
unchanged bytes become `recorded_label`. Transcript retrieval is the pinned
argument vector `monologue notes get <note_id> --field transcript`; stdout must
be strict UTF-8 within its declared cap, CRLF and bare CR become LF, and the same
three code points alone are trimmed from both ends. An empty transcript,
nonzero exit, stderr contract violation, or malformed field leaves discovery
unadvanced and creates no post intent.

The suffix-free body is exactly the UTF-8 encoding of
`*<title>*  _[recorded <recorded_label>]_\n\n<transcript>\n\n— via monologue`
with the shown two ASCII spaces before `_`, literal LF separators, and U+2014.
`payload_hash` is lowercase hexadecimal
`SHA-256(tuple-v1("monologue-payload-v1", note_id, suffix_free_body))`. After the
suffix below is calculated, `final_text` is exactly
`suffix_free_body || UTF8("\n\n") || suffix`, with no trailing newline. Named
golden vectors include null/empty title, CRLF, leading/trailing ASCII whitespace,
retained non-ASCII whitespace, non-ASCII text, invalid RFC 3339, transcript CLI
newline, suffix-free body hex, tuple hex, payload hash, and final-text hex.
Migration and reconciliation use these same bytes and never reconstruct the
hash from Slack-rendered formatting.

For each discovered new note, the poller first commits its stable note ID,
payload hash, suffix-free body, exact final text/hash, and `pending` intent;
claims it as `sending`; and posts that content followed by its deterministic,
self-describing receipt suffix. Define
`note_identity_bytes = tuple-v1("monologue-note-id-v1", note_id)` and
`note_token` as RFC 4648 URL-safe base64 of those bytes with every `=` padding
character omitted. `payload_hash` is exactly 64 lowercase ASCII hexadecimal
characters from the stored contract above. Define
`mac_input = tuple-v1("monologue-receipt-mac-v1", "m1", note_id,
payload_hash, channel_id, expected_user_id)` in that exact order. `mac` is the
first 16 raw bytes of `HMAC-SHA-256(receipt_key, mac_input)`, rendered as 32
lowercase hexadecimal characters.

The exact suffix bytes are the UTF-8 encoding of
`⟦m1.<note_token>.<payload_hash>.<mac>⟧`, with literal ASCII full stops and no
whitespace, padding, escapes, or trailing newline. The complete suffix is
capped at 320 UTF-8 bytes. Verification base64url-decodes `note_token`, requires
the exact tuple tag and one string field, applies the note-ID bound, and requires
decode/re-encode to reproduce the token byte-for-byte before checking the MAC in
constant time. `bot/test/fixtures/monologue-receipt-v1.json` contains named
ASCII, non-ASCII, empty/maximum-boundary, wrong-order, padded-token, uppercase-
hash, and one-bit-MAC golden vectors with exact tuple hex, token, MAC-input hex,
MAC, suffix UTF-8 hex, and verdict. Poller, verifier, restore reconciler, and an
independent fixture generator all consume the same vectors; no implementation
constructs the MAC from the visible prefix by ad hoc concatenation.
Slack evidence therefore reveals the exact stable note ID and payload hash even
when both replaceable databases are absent, while the MAC authenticates those
fields and destination/user binding.

Before the first probe, the cutover generates the 32-byte key under a journaled
intent, atomically installs it root:root mode 0600 at
`/etc/concierge/monologue-receipt.key`, and records only its digest. Only the
separate non-root `concierge-monologue` poller and a childless verify-only
`concierge-monologue-receipt-verifier.service` receive it through their own
systemd credentials and private namespaces. The verifier exposes one bounded
Unix-socket `verify(version, encoded-note-id, payload-hash, channel, user, mac)`
operation and returns only valid/invalid plus the decoded bounded fields; it has
no sign, post, database, provider, filesystem-write, or arbitrary-MAC method.
The bot classifier/finalizer receives only access to that verify socket, never
the key, and the provider broker receives neither. The key is absent from bot,
provider, ingress, queue, logs, databases, backup manifests, and every other
credential directory. Runtime tests from the real bot/provider identities prove
the key path and verifier process environment/fds inaccessible and prove the
verifier cannot be used as a signing oracle.
Both poller and receipt worker reject an envelope above 39,000 UTF-8 bytes.
Slack success is accepted only with the exact requested text/suffix, returned
timestamp, expected user identity, and no `message_truncated` warning. That
result is committed as `posted`; an ambiguous write becomes `send_unknown`. A
dead or uncertain send reconciles only through exact channel, valid HMAC,
payload hash, expected user identity, exact text/suffix, and the persisted
`(search_oldest_exclusive, search_latest_inclusive]` interval. Zero, multiple,
mutated, truncated, or unauthenticated matches park
for audit and never repost. No Monologue transition depends on unsupported
user-authored Slack metadata or on `client_msg_id`.

`posted` is not delivery completion. The poller never invokes a provider or the
ordinary classification path. In normal post-target operation, the integrated
Concierge process is the sole owner-guarded receipt classifier: the current
`handleUserMessage` core is
extracted behind an in-process service that retains the same provider registry,
Slack client, instance identity, steering map, input-claim transaction, and
deployment gate. Its receipt worker validates the stored Slack message and
claims `classifying`. If Socket Mode already classified that exact message, it
validates the existing non-pending `slack_user_input_claims` row and records
`classified`. If no claim exists, only that integrated worker may reserve the
same durable claim/recovery envelope and invoke ordinary classification. Socket
Mode and the worker therefore race on one unique claim, not on side effects.

A failed, drain-rejected, or otherwise nonterminal claim is not classification
proof. Missing or mutated Slack evidence, conflicting provenance, or a
permanent classification failure changes `posted` or owner-matching
`classifying` to terminal `parked_unknown`; a dead `classifying` owner is
reconciled from the durable input claim—exact terminal classification becomes
`classified`, no claim returns to `posted`, and a dead/ambiguous pending claim
parks. Only `classified` and `legacy_no_repost` contribute to the seen
projection. The authoritative receipt transaction never writes the text file:
in the same commit that reaches either terminal state it advances the desired
revision in the singleton `monologue_seen_projection_state` and leaves that
revision pending. A separate owner-guarded projection worker renders the
complete stable note-ID set for the desired revision into a same-directory
temporary file, fsyncs it, atomically renames it over the compatibility file,
fsyncs the parent directory, then marks that exact revision delivered. A crash
before rename repeats the render; a crash after rename but before the delivered
commit proves the file digest and marks or rerenders the same revision. Startup
always renders or hashes the complete authoritative set and verifies the actual
compatibility-file digest even when desired revision equals delivered revision.
Absence, corruption, or mismatch atomically advances a repair revision and
rerenders it before the poller is enabled. Restore reconciliation
unconditionally advances one new desired repair revision after all restored
receipt dispositions and tombstones are committed; under the restore holds it
must render, fsync/rename, reopen, digest-verify, and mark that exact revision
delivered before Monologue or normal startup can be enabled. An existing
classified receipt therefore repairs a missing or wrong-instant seen file
without posting or classifying again, and no filesystem/database atomicity is
claimed.

Installing that prerequisite is itself journaled and runs with both the poller
and machine backup inhibited. It waits for the current oneshot, reads the
entire current seen file under that inhibition (36 entries at the current
preflight; the authoritative count is re-read during cutover), and persists its
digest, count, migration cutoff, and every stable note ID as an immutable
`legacy_no_repost` receipt/tombstone before the new poller can start. It audits
all available Monologue notes and every `— via monologue` Slack message against
the main input-claim table. An exact match may enrich a legacy tombstone with
Slack/classification evidence; a missing or unclassifiable match remains
no-repost and enters manual review, never `pending`. The seen file is then
rebuilt by that projection worker solely from `classified` and
`legacy_no_repost` rows; its exact revision and digest must be delivered before
the migration phase completes. The journal also audits the last pre-inhibit
timer boundary. Any new
message at that boundary without a receipt/tombstone and durable classification
stops the prerequisite for manual resolution. After the new poller and metadata
schema are active, the driver manually invokes one labeled poll cycle and
requires the unchanged predecessor's normal Socket handler to create an exact
terminal, non-pending ordinary input claim. A checksum-addressed one-shot
`monologue-receipt-finalize-v1` then validates that exact claim, Slack timestamp,
note/payload hash, user identity, exact text, valid receipt HMAC through the
verify-only service, and receipt owner before it may
atomically change only that receipt `posted -> classified` and advance the
pending projection revision. The separately sealed projection worker performs
the fsync/rename/delivered phase. The finalizer cannot reserve or modify an
input claim, invoke
`handleUserMessage`, start a provider, post/reconcile Slack, or finalize a
missing/pending/ambiguous claim; its static and runtime capability allowlist is
sealed into the predecessor-prerequisite manifest. A missed Socket event
therefore fails closed with Monologue inhibited. Crash/dead-owner tests prove
the receipt commit is authoritative and every interrupted projection converges
without a repost or second classification. The integrated fallback worker is
installed, started, and separately proved only
with target Concierge later in cutover. The units' exact prior state is restored
only at final cutover success or successful prerequisite rollback.

The operations database is bootstrapped before any non-restore operation
attempts to claim its inhibitor; restore uses the explicit external-journal
bootstrap path above. The sealed target supplies root-only
`/opt/concierge-control/<release-digest>/concierge-operations-v1` and an exact
`operations-v1.sql` digest. Its only initial schema is
`operations_schema(singleton=1, version=1, schema_digest)`, the singleton
`operation_inhibitor` row described below, `snapshot_operations` keyed by the
operation token, `restore_operations` keyed by a separately typed restore
token, and an append-only `operations_audit` keyed by monotonic sequence. The
migration and CLI reject any unknown table, column, trigger, index, or version.
`snapshot_operations` accepts only active snapshot phases or terminal
`complete`, `failed`, and `restored_generation_source`; normal adoption rejects
every terminal or restore-bound row. A unique partial index permits exactly one
row across all nonterminal snapshot phases, including `retry_pending`; a due
timer adopts/resumes that row and never inserts a competing operation.
`restore_operations` has the equivalent one-nonterminal-row constraint, with
the external-journal token as its only legal restore identity.
`/var/lib/concierge-operations` is pre-created root:root
mode 0700 and `state.db` is root:root mode 0600; the normal bot and public
ingress cannot open either the directory or the CLI. First creation writes a
standalone database in the same directory, verifies schema and
`integrity_check`, sets and verifies `PRAGMA journal_mode=WAL`, closes cleanly,
fsyncs it and the directory, then atomically renames it into place with no
WAL/SHM sidecars. Every later operations connection verifies WAL mode before
its first write and refuses a rollback journal or unknown sidecar. Existing v1
is verify-only. The already-fsynced
master journal records bootstrap intent, artifact/schema digests, whether the
directory/database pre-existed, and the observed result before the first claim.
A crash adopts only an exact matching v1 database; any other partial file is
quarantined and stops. Before forward-only state, rollback removes only a
journal-proven attempt-created, empty, released database and restores the exact
pre-attempt directory state; after any durable operation row exists, it is
forward-repair-only and retained.

Every operation that closes the bot gate—including deploy and the
consistent-backup helper—first claims one root-owned singleton inhibitor lease
in `/var/lib/concierge-operations/state.db`. Restore alone begins under the
external offline journal/catalog singleton defined above because the live
operations DB may be the damaged object; it installs the same token into the
staged operations image before any DB user restarts. The ordinary immediate
claim occurs before
reading prior unit state or changing a mask and records operation token/type,
exact PID/start-time/boot identity, original enabled/active/masked state, and
unit-file hashes. A live competing owner waits or refuses; it never records the
other operation's masks as prior state. A dead-owner adopter keeps the original
snapshot and operation token and resumes its phase; it cannot replace that
snapshot. Only the exact live owner/adopter may restore the original state, and
only after its bot gate is released or its pre-mutation rollback succeeds.

The owner stops the timer, installs persistent `/dev/null` masks for the timer
and future service activation without applying `--now` to an active service,
daemon-reloads, and then waits for the recorded already-running oneshot to
finish normally while the gate is still open. The initial cutover relocates the current real `/etc`
unit definitions to journaled vendor-unit locations so the masks are
unambiguous and reversible. Before closing the bot gate, the owner proves both
units masked/inactive and every receipt nonclaimable: `classified`,
`legacy_no_repost`, or terminal `parked_unknown`. Any `pending`, `sending`,
`send_unknown`, `reconciling`, `posted`, or live/dead unresolved `classifying`
row blocks the gate. The masks and singleton lease survive helper death and
reboot. Backup-vs-deploy, backup-vs-restore, deploy-vs-restore, SIGKILL, and
reboot tests prove that only the final owner restores the one original state.
Every forward-only failure path adopts the existing inhibitor before
holding/adopting the bot gate. The poller is not migrated into the capture queue,
but it can never post or update the derived seen projection while Concierge
refuses admission.

Operations state is restore-critical, not disposable coordination. Its live
DB/WAL/SHM file set is excluded from raw restic input, its standalone image is
the third member of every coherent generation, and restore replaces the
snapshotted backup owner with the exact restore owner before any unit can start.
No script infers original unit state from the currently masked filesystem when
that durable snapshot exists.

Capture queue schema and main-database capture/gate additions are owned by
versioned deployment migrations. Runtime capture modules assert exact schema
versions and never create or alter production tables. This release does not
claim to refactor unrelated existing Concierge runtime DDL. Future migrations
claim/hold the gate, stop every process using the affected database, migrate,
assert versions, then restart current code.

### 6. Publish the readable hostname with reversible edge state

A versioned Cloudflare Worker owns the `capture.tejas.nyc` Custom Domain and
proxies exact `/pebble` and `/health` requests to the existing Caddy origin.
It returns 404 for `/audio`, `/monologue`, and unknown paths, never logs request
bodies or authorization, streams the request, and disables `workers.dev`.

The Worker strips any client-supplied `X-Concierge-Edge-Token` and injects a
root-generated origin credential stored as a Worker secret. Caddy accepts
`/pebble` only when that exact header matches the corresponding root-owned
environment credential; the matched reverse-proxy handle then uses
`header_up -X-Concierge-Edge-Token` so Caddy consumes the credential and never
forwards it upstream. Ingress independently rejects any request where that
header is present, turning a future Caddy regression into a closed failure. A
bearer-only request to the public `sslip.io` origin is rejected before proxying.
`/health` has a non-sensitive edge subcheck, while its ingress-origin subcheck
uses and strips the same origin credential. This makes Worker maintenance mode
authoritative rather than bypassable through the origin URL.

The Worker has two release modes:

- `maintenance`: health is versioned; `/pebble` returns 503 without forwarding;
- `accepting`: `/pebble` forwards to the fixed origin.

The v1 driver requires the currently proven clean edge invariant: no existing
capture Worker script and no exact `capture.tejas.nyc` Custom Domain. Any
pre-existing object refuses cutover for separate review; v1 does not implement
a general edge migration engine. It first creates attempt-owned objects in
`maintenance` before any local mutation and switches the same versioned Worker
to `accepting` only after the new local stack and held-gate bot are healthy.
Pre-forward rollback deletes only the attempt-owned Custom Domain and Worker,
then verifies that the hostname has returned to its prior functional 404 route.
Because Cloudflare does not remove a generated Advanced Certificate when a
Custom Domain is deleted, the journal records any harmless orphan certificate
identifier as a manual cleanup item rather than claiming exact inventory
rollback. Post-forward failure leaves the attempt-owned Worker in maintenance
and repairs forward.

Caddy receives a repository-owned config with exact routes:

- `/audio` -> unchanged legacy service on port 8080;
- authenticated edge `/pebble` and origin-health -> new ingress on port 8082;
- everything else -> 404.

Deployment stages and validates the config, stores a root-only known-good copy,
installs atomically, reloads, and probes all allow/deny paths. Any failure
restores and revalidates the known-good config before continuing rollback.
The probe records both Caddy's allow decision and ingress's observed header set;
an upstream-observed edge token fails deployment.

### 7. Perform the first rollout with a pinned cutover driver

One master cutover attempt and journal owns the prerequisites and capture
cutover. After read-only preflight and sealed-release construction, but before
the Slack manifest upload/reinstall, token replacement, remote-box deploy, unit
inhibition, or any other external mutation, the driver creates and fsyncs that
journal. It first bootstraps operations v1, claims the cutover token, inhibits
and drains the currently installed backup, and only then deploys the inactive
`remote-box` prerequisite. Before any Slack reinstall it then claims the
singleton Monologue
inhibitor and the legacy bot gate, drains and stops both credential consumers,
and proves their processes dead. Only then may it reinstall the app and stage
the complete bot/user/app credential set. A sealed predecessor may restart with
those new credentials only under journal control; Monologue remains masked
except for the one labeled manual proof cycle. The backup remains inhibited
until the three-database-plus-provider-state coherent helper, raw file-set/home/
credential exclusions, and marker are installed and verified. Failure of any prerequisite leaves Pebble edge
objects absent and forbids capture cutover. The receipt prerequisite never
updates the mutable checkout or starts target bot code; it installs only
checksum-addressed migration/finalizer artifacts from the reviewed target.

The current reviewed main commit `3e083d8b53c0af9f7a66fa3afeb630dcb7885946` is not a legal
predecessor input: its `bot/bun.lock` retains `better-sqlite3` after
`package.json` removed it, and the required frozen install fails. The first
implementation milestone is therefore a semantics-preserving preparatory
release whose only runtime-input change is a Bun-1.3.14-regenerated lockfile.
It must pass the full existing suite, the exact copyfile/frozen/production
install from a Git archive, independent implementation review, commit/push, and
normal production health. Its resulting verified Git SHA—not `3e083d8`—is the
only permitted predecessor and the target branches from it. The master cutover
cannot be created until that concrete SHA and its deployed invocation are pinned
in the reviewed release manifest and journal.

Today's `deploy.sh` cannot safely acquire new semantics after its own `git pull`:
the running shell retains old function bodies and would create the old capture
database. This release therefore includes a one-time, versioned
`capture-cutover-v1` driver. The reviewed target and predecessor commits are
explicit arguments. Before mutation, a release builder exports each commit into
a same-filesystem staging directory, installs production dependencies from the
committed `bot/bun.lock` with
`bun install --backend=copyfile --frozen-lockfile --production`, and
uses one explicitly pinned Bun version and distribution SHA-256. It hashes every
tracked runtime file, lockfile, installed dependency file/link target, generated
config/schema artifact, and Bun binary into a content-addressed release
manifest. Before hashing it walks the tree with `lstat`: every regular file in
the runnable release tree must have `st_nlink == 1`; every symlink must be
relative and normalize to a target inside the same release tree; absolute,
escaping, dangling, socket, device, and FIFO entries are rejected. The checked-
in target `bot/bunfig.toml` sets `env = false` and
`[install] auto = "disable"`; the builder installs that same generated,
manifested hardening config in the predecessor artifact. Every runnable systemd
unit invokes the pinned Bun with `--no-install --no-env-file`, clears
`NODE_PATH`, `NODE_OPTIONS`, `BUN_INSTALL`, and ambient Bun config/cache
variables, and supplies only an explicit environment. Its mount namespace makes
every ancestor/global module location inaccessible, including
`/opt/slack-concierge/releases/node_modules`,
`/opt/slack-concierge/node_modules`, `/opt/node_modules`, `/node_modules`, the
mutable checkout's `node_modules`, and `/root/.bun/install`; only the selected
release tree is bind-mounted read-only. A build audit resolves every static
non-built-in import into a Bun metafile, and the bounded no-network smoke runs
under a file-open trace; any JavaScript/TypeScript/package/module path outside
the manifested release fails sealing. Thus a missing dependency cannot fall
back to an ancestor, network auto-install, global cache, or mutable ambient
`.env`. The builder runs unit/config/schema smoke tests from staging, fsyncs it,
makes the tree root-owned/read-only, and atomically renames it to
`/opt/slack-concierge/releases/<git-sha>-<manifest-digest>`. Partial staging is
never executable and a released path is never mutated or reused.

The builder also creates one deterministic content-addressed
`release-<manifest-digest>.tar.zst` containing the full read-only tree, pinned
Bun, dependency tree, hardening config, fixed SQLite snapshot helper and source/
binary digests, and manifest. It fsyncs that package and records its digest/size
in the cutover journal. Each coherent database
generation copies that opaque package plus digest into its own manifest; restic
therefore sees a regular archive rather than excluded internal `node_modules/`
paths. Restore verifies the archive digest, extracts to same-filesystem staging,
reruns every link/path/manifest/import check, and atomically installs the exact
release before starting restore mode. A release is not backup-qualified until a
test restic snapshot has been restored into scratch and run through this proof.

The driver builds and seals both predecessor and target artifacts before its
first service mutation. The installed unit's `ExecStart` references only the
pinned Bun binary and sealed target tree; `WorkingDirectory` and all imports
are proven inside that artifact, and systemd marks it read-only and hides every
ancestor module location. The mutable canonical checkout and untracked
`node_modules` are never runtime inputs. The
unit exports the expected git SHA/release-manifest digest, and functional health
must match both plus the current systemd invocation ID before the gate can open.
The driver refuses an unexpected source SHA, dirty tracked service checkout,
failed frozen install/smoke test, unjournaled capture token, unowned pre-existing
queue, or pre-existing capture Worker/Custom Domain.

Before its first mutation it creates the root-owned, fsynced master journal with
one attempt ID and monotonic phases. The journal records predecessor/target
  SHAs, pre-credential rollback and post-receipt audit-image identities, prior
  Caddy/unit/Monologue/backup state,
attempt-owned Worker deployment and Custom Domain IDs, every created
file/service identity and checksum, predecessor/target release paths and
complete manifests, gate token, and whether the attempt crossed into
forward-only recovery. It also records the prior main Slack manifest digest,
complete-config path/digest/owner/mode (never token bytes), separate staged-
config digest, app/workspace/bot/user identities, exact bot/user scopes,
preserved app-token and signing-secret digests, and capture-app attestation/
evidence digests. The root-owned mode-0600 staged config is the recovery source
for secret bytes and contains the new bot and `authed_user` tokens plus the
preserved app token/signing secret; it is never copied into the journal.
Manifest upload, reinstall authorization, OAuth response capture, bot/user/app
validation, and atomic whole-config replacement each have separate intent and
observed-result phases and a monotonically increasing `oauth_generation`.
Before parsing, validation, or config rendering, the complete OAuth response is
written to a generation-specific root-owned mode-0600 file, fsynced, and its
digest/result phase committed to the journal; only that complete newest
generation may produce the staged config. If a crash leaves an authorization
code consumed but no complete response file, consumers stay stopped and the
operator performs a new human authorization that creates the next generation.
The older generation is durably marked `abandoned_superseded`; its code is
never reused and its exchange is never blindly retried. A crash or
manual-browser interruption with a complete response resumes by live app
identity, manifest digest, staged-config digest, both `auth.test` results, exact
scopes, and `apps.connections.open`, never by repeating an uncertain reinstall
or guessing which user token Monologue should use. Reinstall/config
replacement is forward-repair-only because Slack may revoke old credentials;
rollback never pretends the old secrets can be recovered from digests. Every
other side effect is likewise preceded by intent and followed by observed
result. `resume` adopts only exact journal-owned artifacts; `rollback` restores
only reversible artifacts owned by that attempt. SIGKILL and reboot tests
exercise every phase.

Immediately after step 3 proves every main-database and seen-file writer dead,
and before `credentials_forward_only` or receipt-schema migration, the sealed
fixed SQLite helper creates the attempt's named
`pre-credential-main.rollback.db`. The driver also copies the exact legacy seen
file into the same cutover-rollback directory, records absence explicitly if it
did not exist, and fsyncs both files, their checksums, source schema/user
versions, and the directory into the master journal. It reopens the standalone
main image with SQLite 3.53.4, requires `integrity_check=ok` and no sidecars, and
verifies the seen digest/count. This is the only database image legal for
pre-data-forward rollback; the later post-receipt snapshot is never mislabeled
as the pre-migration recovery point.

Installing that rollback image is a full stopped file-set operation. The driver
again proves every database/seen consumer dead and does not install the helper's
`DELETE`-mode image directly. Before the live move it copies that preserved
image to an attempt-owned transform path and uses
the same pinned SQLite runtime and `wal_transform_intent -> wal_transformed`
protocol as restore: require `journal_mode=WAL` returns `wal`, checkpoint
`TRUNCATE`, close/fsync, require WAL header bytes 18/19 equal `2`, then reopen
only through the percent-encoded `mode=ro&immutable=1` URI for exact schema/user
versions and `integrity_check=ok` without querying that handle's reported
journal mode. The digest/header must remain unchanged and no sidecar may appear.
It then moves the
destination main DB plus any `-wal`/`-shm` sidecars into the attempt-owned
cutover quarantine, installs only that digest-bound WAL-header image with no
sidecars, and fsyncs file and parent.
The preserved rollback source remains immutable. It restores the exact pre-cutover seen projection by
same-directory temp+fsync+rename+parent-fsync. This rollback is legal only
before the data-forward marker, which precedes every post-image user-authored
Slack message and every main-schema mutation; no Slack input claim, provider
turn, or external effect can therefore be erased. A crash resumes from the
journaled transform/file-set phase and can never mix the rollback DB with a later WAL or
a seen file from a different boundary.

Immediately after data becomes forward-only and before the first labeled
user-authored probe, a predecessor-compatible additive migration installs
nullable `origin_kind` and `origin_id` on `slack_user_input_claims` plus a
unique partial index over non-null `(origin_kind, origin_id)`. A cutover probe
uses `origin_kind='cutover_probe'` and an `origin_id` equal to SHA-256 of a
length-framed tuple containing the journal attempt ID, OAuth generation, probe
kind, channel, exact Slack timestamp, user ID, and payload hash. Resume accepts
only an exact row/envelope/provenance match. An existing row at that timestamp
or origin with different provenance is a hard conflict, never success. Capture
origin kinds added later reuse these already-installed columns.

The manual Slack prerequisite is one root-owned, mode-0600 JSON artifact at
`/etc/concierge/capture-slack-app-attestation.json`, with fixed fields:
`schema_version=1`, workspace ID, Slack-admin operator identity, UTC verification
time, outcome (`not_currently_installed` or `uninstalled`), capture app ID when
applicable, complete-current-installed-app inventory evidence reference and
SHA-256, uninstall/revocation evidence when applicable, and the expected old
capture-manifest SHA-256. Its evidence files are also root-owned and mode 0600.
`not_currently_installed` asserts only current absence and must show the complete
workspace installed-app inventory, not search results or historical absence;
`uninstalled` additionally names the exact app ID and revocation result. No
`never_installed` claim is accepted without a separate historical audit source,
which this rollout does not require. The driver accepts only workspace
`T09ESSV143W`, an attestation no more than 24 hours old, the exact predecessor
manifest hash, outcome-consistent fields, and matching evidence bytes. Before
any mutation it copies the artifact/evidence digests and validated fields—not
secrets—into the fsynced journal. Missing, stale, partial-inventory, malformed,
wrong-workspace, or mismatched evidence fails closed.

The cutover sequence is:

1. Build and smoke-test the sealed predecessor/target releases, validate the
   machine-checkable Slack-admin artifact, snapshot prior unit/Caddy/Monologue/
   backup state, prove the edge clean, and create the master journal. This is
   still read-only and requires the deployed preparatory predecessor SHA.
2. Bootstrap and verify operations schema v1 from the sealed target, record its
   exact result in the journal, and only then make the first inhibitor claim.
   Under that token, record the current backup checkout/unit hashes and exact
   timer/service state, stop/mask the timer, mask future service activation
   without stopping an active oneshot, wait for the recorded old MainPID/
   invocation/restic tree to exit normally, and prove the service inactive.
   Only then deploy and verify the immutable pinned inactive `remote-box`
   prerequisite. It does not select raw
   Concierge DBs once the marker exists and hard-fails if the coherent snapshot
   helper is unavailable. Keep both units inhibited for the remainder of
   cutover.
3. Continue under the exact cutover operations token, acquire the singleton
   Monologue inhibition it owns, persistently mask the units, and wait for the
   current oneshot. Claim the predecessor's legacy bot gate, drain
   live handlers/turns, stop and mask Concierge, and prove both bot and
   Monologue credential-consuming processes dead. Create and verify the exact
   pre-credential main/seen rollback set described above. No reinstall may
   begin first.
4. Record a distinct `credentials_forward_only` intent, upload the reviewed
   manifest, reinstall the same app, capture the complete OAuth response,
   validate the returned bot/user tokens plus preserved app token/signing
   secret, atomically install the staged whole config, and install/validate the
   attempt-owned Monologue receipt HMAC credential plus its isolated poller and
   verify-only service. Record data
   `forward_only`, install and verify the predecessor-compatible input-origin
   migration, and only then create any user-authored probe. Direct, labeled,
   journal-owned probes prove exact identities/scopes, `apps.connections.open`,
   bot metadata write-read, and the self-describing user-authored Monologue
   receipt/HMAC/verifier
   contract without starting either consumer or printing secrets. Before any
   Concierge process may restart, the
   driver resolves each user-authored probe to one exact Slack timestamp and
   inserts or verifies an `ignored` `slack_user_input_claims` row with the exact
   channel/thread/user/text/file envelope and probe provenance; the bot-authored
   probe is journaled but is already excluded by bot authorship. Ambiguous post
   acknowledgement is reconciled by exact registered capture metadata or valid
   Monologue receipt through the verify-only service before either claim or
   restart, never treated as absence. An
   unresolved probe stops with
   both consumers inhibited. A lost OAuth response follows the superseding
   generation contract above; no code exchange is retried. From this phase,
   recovery always preserves/repairs the new credentials.
5. Under Monologue inhibition, import the complete seen file as
   `legacy_no_repost`, record its cutoff/digest/count, audit the legacy
   Slack/claim boundary, and install only the additive receipt schema, new
   poller artifact, and narrow finalizer. Start the sealed preparatory
   predecessor with the new complete config under the held gate and prove its
   exact release, Socket connection, and health. Release the legacy gate,
   manually invoke one labeled poll cycle under the inhibitor token, require the
   predecessor to create the exact terminal ordinary input claim, and run the
   one-shot finalizer to reach `classified`, then require the exact pending seen
   projection revision to be delivered. Then
   reacquire the legacy gate, drain, stop, and remask the predecessor. Keep
   Monologue inhibited throughout.
6. Deploy and verify the attempt-owned Worker/Custom Domain in `maintenance`.
   Any ambiguous edge mutation is journaled and reconciled by exact object
   identity before resume or rollback.
7. Create a separately named post-receipt stopped-main image for migration
   audit, never for rollback. Migrate the root gate to held-aware form, add
   capture tables and capture-specific provenance constraints over the already-
   installed origin columns, and install a durable held row owned by the
   cutover process. Until the target unit is atomically installed over the mask,
   a reboot cannot start the old binary against the new schema.
8. With every legacy bot/provider child still proven dead, create the fixed
   non-root identities and queue ledger group; move main/state paths to their
   journaled `/var/lib` authorities; inventory, save, and apply the exact
   project/vault/additional-path ACLs; and pass every real-UID positive/negative
   filesystem probe. Build the closed non-secret provider-state inventory and
   migrate it into the fsynced `concierge-provider` home. Install and load the
   exact journaled AppArmor profile plus sandbox/broker, then require the manual
   fresh Codex/Claude target-identity authentication prerequisite—never copy a
   root auth file—and pass refresh plus no-tool health probes. Run every
   database-referenced journal-owned Codex/Claude continuity proof or persist
   its explicit archived disposition. Only then install queue/ingress/bot/provider/
   Monologue identities, their disjoint credential directories and namespaces, database migrations, the
   sealed SQLite snapshot helper, snapshot/restore CLI, target release units,
   Caddy origin credential, and units. Operations identity/schema already
   exists and is reverified, not first-created here. Preflight and the real
   target UID must also prove unprivileged user/mount/PID namespace creation,
   PID-1 reaping, broker `SO_PEERCRED`, child socket denial, and whole-group kill
   on bot disconnect. A resumed attempt adopts
   matching journaled files; it never blindly regenerates them. Start queue and
   ingress and require local functional health while the edge is maintenance.
9. Stage, validate, install, and probe Caddy, including origin rejection without
   the Worker credential and proof that the credential is stripped before
   ingress, while `/audio` remains live.
10. With data already forward-only, Concierge still stopped, and the gate held,
    post one explicitly labeled user-token self-describing HMAC receipt test and
    persist its exact Monologue receipt as `posted`. Install the target in a
    sealed `cutover-receipt-proof` entrypoint: Socket Mode is not connected,
    Slack event dispatch is impossible, and only the exact integrated receipt
    worker plus its ordinary provider/executor/delivery path is enabled. Release
    the bot gate for that process, require the worker alone to reserve and
    classify the receipt, require an exact provider-start acknowledgement and
    terminal ordinary turn, and require the pending seen revision to be
    delivered. Then reclaim the bot gate, drain/stop proof mode, and start the
    normal target while the gate remains held and Socket event dispatch remains
    disabled. Require current-invocation bot auth, queue/schema, paused-worker
    health, target SHA, and systemd invocation ID. From this phase onward the
    pre-credential rollback image is never restored.
11. Delegate the existing cutover inhibitor and bot-gate tokens to the sealed
    privileged snapshot core; it must not recursively reacquire or release
    either. The core acquires the provider-state, queue, then main-effect fences,
    drains/stops the broker, creates and uploads a fresh coherent generation of
    the three databases plus the complete provider-state/disposition bundle,
    verifies catalog selection and raw main/queue/operations DB/WAL/SHM,
    provider-home, and credential exclusions, rejects every rollback journal or
    unrecognized SQLite sidecar, installs the
    `coherent-capture-required` marker, and returns control with the cutover
    holds intact. A pre-existing stale `ready` is first settled, but success
    still requires a fresh generation from this invocation. Restore the exact
    prior backup timer/service state only after this proof.
12. Enable and prove normal Socket Mode while the held gate still prevents
    admission. Release the held gate, prove the capture dispatcher and ordinary
    workers can claim, deploy the Worker in `accepting` mode, and verify its
    exact external version and origin authentication. Restore the exact prior
    Monologue state only after Socket dispatch and the integrated receipt worker
    are healthy. The journal is already forward-only, so an immediate valid
    `202` is recoverable.
13. Send one labeled synthetic Pebble capture, require one Slack message and an
    exact provider-start acknowledgement, replay it, and require no second
    message or turn. The post-proof snapshot/backup schedule must create and
    upload another fresh generation within the 26-hour RPO.

Before `credentials_forward_only`, rollback may restore the original complete
Slack config. From `credentials_forward_only` until data `forward_only`,
rollback restores the exact pre-credential main/seen rollback set, predecessor
release/unit, Caddy known-good config, prior functional hostname route, and
prior Monologue/backup state but keeps the newly validated Slack config and
proves the sealed predecessor with those credentials plus `/audio` healthy; it
never revives possibly revoked old tokens. An orphan Cloudflare certificate is
journaled for manual cleanup. At or after data `forward_only`, failure handling
first re-inhibits Monologue and backup units, forces the exact Worker deployment
back to maintenance, ensures the root gate is held or adopted, and repairs
forward from the journal. It never
restores stale main state. Accepted queue rows remain durable until delivery or
explicit export/operator resolution.

Future `deploy.sh` invocations use a tiny pre-update launcher that performs no
schema/service mutation, updates through git, and `exec`s the just-pulled script
with an explicit handoff token. The current script builds and smoke-tests a
sealed checksum-addressed release, durably inhibits Monologue, and places the
edge in maintenance when queue/ingress availability will change. It then claims the held-aware gate,
quiesces affected services, migrates, points systemd at the immutable release,
starts, proves release SHA/invocation health, releases, restores the edge, and
restores the exact prior Monologue state.

### 8. Retire only obsolete Pebble artifacts

Repository cleanup is a follow-up commit after live cutover verification, not a
pre-deployment edit. The implementation/cutover commit retains the old manifest
at its attested hash. Only after the journal records the labeled capture proof,
exact provider-start proof, and validated admin-attestation digest may the
follow-up commit:

- delete the unneeded `capture-slack-app-manifest.json` from the repository;
- remove every `/etc/concierge/capture-slack.token` and separate capture-app
  instruction from versioned units/docs;
- replace the old `sslip.io` Pebble setup text with
  `https://capture.tejas.nyc/pebble`;
- leave the live Monologue poller, timer, seen file, and documentation truthful
  about its current separate path;
- update `AGENTS.md`, `REQUIREMENTS.md`, `REQUIREMENTS-EXTRACTED.md`,
  `DESIGN.md`, `IMPLEMENTATION.md`, `STATUS.md`, `systemd/README.md`, and
  `docs/CAPTURE-INGRESS.md` across the implementation and cleanup commits so
  each deployed subsystem state is truthful at its own commit.

Local absence of a token is not proof that a Slack app was never installed.
Because current OAuth scopes cannot inventory workspace installations, the
validated Slack-admin artifact in cutover step 1 is a hard prerequisite. If the
app exists, its app ID and successful uninstall/revoke evidence are captured
before cleanup. If the artifact is missing, stale, or uncertain, cutover stops
and the manifest stays in the repository; no claim that the separate
authorization was retired is made.

## Verification contract

Focused tests must prove:

- public ingress has no persistent write path or Slack/config access, enforces
  auth/body/audio rules, and acknowledges only queue commits; raw tests through
  Caddy prove port 8082's own 16-connection/backlog/header/body/slot/resource
  envelope against slow headers/chunks, fixed/chunked overflow, queue stalls,
  and floods before parser admission;
- direct queue tests prove the pinned Node-compatible server caps connections
  before header parsing, enforces exact backlog/connection/header/body/field/
  process-resource ceilings and one absolute deadline, and handles incomplete-
  header drips, oversized fixed/chunked bodies, compression, malformed strict
  JSON/UTF-8, and connection/body floods with the real enqueue credential;
  real queue and bot UIDs perform enqueue versus lease/import/ack transactions
  through the setgid ledger modes, while ingress/provider/Monologue cannot
  traverse or open any DB/sidecar;
- canonical length-framed identity/payload bytes, stored contract versions,
  complete v1 field/UTF-8/line-ending/exact-trim/default/null normalization with
  no mutable Unicode-data dependency,
  duplicate multipart rejection, golden hashes/renders, and conservative UTF-8
  rendered-length rejection all happen before `202`; duplicate/capacity/
  persisted-token-bucket checks are
  atomic; duplicates survive full capacity; conflicts are first-wins; identical
  and conflicting retries across a delivery-contract upgrade retain the same
  stable event identity and cannot create another row/post/turn;
- retained-ledger compaction honors the 16-day floor and both hard caps, a new
  route cannot evade global exhaustion, and only a reviewed bound change can
  restore new-event capacity; import always claims queue then main-effect lease,
  releases queue on main-fence refusal, and has no reverse path; token-bound
  queue/effect snapshot gates drain already-started work, return retryable `503`
  for acceptance, and produce
  a main/queue/operations generation that cannot lose an event between DBs or
  omit an external effect inside the fence;
  queue detail compacts to an authoritative tombstone only after a proven
  admitted terminal turn; restore starts the exclusive side-effect-free branch
  and never turns generation state or absent external evidence into automatic
  replay; the crash sequence snapshot-pending -> later external effect ->
  evidence unavailable -> live DB loss parks;
- trusted and global quota values are enforced, including two active external
  turns and queueing without a live owner;
- every delivery/dispatch transition in the table is owner-guarded; dead
  `sending` becomes `send_unknown`; reconciliation leases wait and page; only
  exact app-owned metadata is positive proof; marker-only/zero/multiple matches
  park; truncation/mutated-success warnings park with their timestamp;
  `client_msg_id` is never the sole match;
- bot-authored message events cannot enter ordinary routing, while direct bind
  atomically creates external-capture provenance, a fresh session, one claim,
  one `capture_bound` turn, and a `capture_reserved` session; ordinary
  acquisition requires exact `idle`; channel-wide/exact-root barriers prevent
  user events before post response or binding from reaching any provider and
  deliver one deterministic resend notice; startup dispatches bound turns;
  transport tests
  distinguish `definitely_not_started`, exact `acknowledged`, and every
  post-write `start_unknown` case without fallback or error-string inference;
  every outcome atomically settles the capture/turn/session combination, and an
  acknowledged turn proves ordinary delivery/session-release row counts;
- crash injection before/after Slack success, timestamp persistence, session/
  claim/turn binding, queue import, and dequeue leaves either one recoverable
  row or one linked turn—never a false terminal state;
- persisted quota buckets, exact pending/slot counts, gate
  claim/hold/adopt/release, and first-rollout version skew have focused SQLite
  state-transition tests, not shell-string assertions;
- main capture byte/row admission, 512 KiB output limit, 30-day detail
  compaction, 60,000 tombstone cap, fail-closed backpressure, and crash-during-
  compaction preserve an authoritative tombstone; unknown/review states never
  auto-compact; root compaction requires an idle quiet session and no pending
  dependent effect, preserves later turns/session/provider identity, and only
  operations requiring the compacted boundary reject explicitly;
- every mutation gateway runtime-validates an opaque family/row/owner-bound
  external-effect capability; forged objects and direct JavaScript calls fail;
  the static audit rejects direct mutations/claim SQL and startup Canvas writes;
  its exhaustive call-site table covers channel create/join/invite, desired
  membership, slash response, channel-ready metadata post, crash-recoverable
  project scaffold/ACL/local-Git state, and makes remote Git propagation
  unreachable outside its cutover journal;
  the independently audited root-only snapshot control API accepts either its
  own complete inhibitor/bot ownership or a nonexportable same-token delegation,
  never recursively claims or releases a delegator's holds, and refuses every
  unmanifested database table/filesystem path;
  the closed executable inventory covers TypeScript, shell, Python, and native
  entrypoints, rejects an effecting executable outside its matching gateway or
  control manifest, and proves the sealed TypeScript poller/projection replaced
  the legacy Bash/Python effect paths; every durable-transition-driving native
  tool is immutable or re-attested at invocation; real non-root bot, broker,
  Codex, and Claude probes cannot traverse operations/backup/restore/control/
  credential paths, directly or through `/proc/*/{root,cwd,fd}`, or systemd
  sockets, and provider environments contain only the explicit allowlist;
  broker tests require one `Accept=no` listener and the bounded nonblocking
  accept loop, AF_UNIX plus exact bot `SO_PEERCRED`/peer pidfd, reject real
  provider-child and wrong-UID clients, reject client paths/env/flags/session
  substitutions, bind every frame to one durable run/turn, and kill/reap the
  attested complete namespace/process group before dead-bot recovery; the
  rootless launcher proves a distinct PID/mount/user namespace, inner PID-1
  reaping, host-proc absence, and fail-before-exec behavior when unprivileged
  namespace creation is disabled or the exact AppArmor profile is absent;
  journaled filesystem migration/rollback and real target-UID probes cover every
  `/var/lib`, code, vault, additional, ancestor, and managed-root path;
  migration fixtures copy/fsync the exact non-secret
  Codex/Claude config/session/plugin/skill closure, prove independently issued
  target credentials across supported refresh without copying root auth, prove every referenced
  UUID through a journal-owned no-tool/no-write continuity operation under the target UID without mutating the source session, and archive
  each deliberately unprovable UUID with its reset notice;
  compiled/database/release/backup registry digests must match before normal
  startup, and restored Canvas/List families stay quarantined until inventory
  reconciliation;
- Caddy preserves `/audio`, exposes only the intended new paths, strips the
  origin credential with `header_up -X-Concierge-Edge-Token`, and ingress fails
  if it ever observes that header;
- Worker maintenance/accepting modes, clean-edge refusal, origin-auth bypass
  rejection, attempt-owned functional rollback plus orphan-certificate journal,
  every journaled cutover resume/rollback phase, complete bot/user/app Slack
  credential recovery with every old consumer stopped before reinstall,
  operations-v1 bootstrap/recovery before the first inhibitor claim, a stopped
  pre-credential standalone main/seen rollback set, full DB/WAL/SHM quarantine
  with WAL-mode enforcement and rollback-/super-journal/unknown-sidecar refusal,
  with the data-forward boundary before every user-authored probe/main mutation,
  and exact journal-bound probe provenance installed before use,
  copyfile-only frozen-dependency construction from the preparatory predecessor,
  `st_nlink == 1`, contained-symlink, `--no-install`, hidden ancestor modules,
  resolved-import tracing, disabled-auto-install checks, and target-runtime
  proof, persistent singleton-owned Monologue/backup inhibition across
  competing operations, SIGKILL/reboot, and the
  pre-bot-start forward-only boundary work;
- coordinated `remote-box` backup tests prove immutable generation readiness,
  content-addressed backup/restic/exclusion/retry/alert unit execution with no
  mutable-checkout dependency, and normal completion of an already-active
  old-byte backup before prerequisite installation,
  the exact absolute-path catalog schema, separate
  `ready -> uploaded(snapshot_id) -> prune_pending` transitions, three-uploaded/
  one-ready/one-snapshot-workspace/one-restore-quarantine bounds with a fourth
  uploaded directory only during prune, actual verbatim first/retry selection,
  rename-before-catalog orphan adoption/quarantine, and stale-ready settlement
  followed by a fresh same-invocation upload or explicit degraded continuation/
  26-hour-RPO failure; restoring an ordinary successful restic snapshot proves
  exact membership and bounded raw-output digest for the catalog plus every
  ready/uploaded/prune-pending generation using the pinned `restic ls` and
  two-argument `restic dump` argv, validates the JCS digest vectors, restores
  the matching provider-state bundle, and reclassifies its occupied `ready`
  slot to `uploaded(selected_snapshot_id)` before the mandatory fresh generation;
  durable singleton `retry_pending` ownership, five-minute
  `OnCalendar` persistent timer polling, bounded service/restic process lifetime,
  timeout finalization, capped backoff, reboot/dead-owner recovery, and the exact
  durable overdue alert-file/failed-health-unit latch—including a 27-hour-old
  successful state with no retry row—are state-transition
  tested; raw main/queue/operations DB/WAL/SHM exclusions, the
  sealed fixed SQLite 3.53.4 helper with exact archive/source/binary digests and
  four-argument backup initialization under hot WAL, sealed-release packaging,
  real restic extraction, helper failure abort, three complete file-set
  quarantines, same-token stale-owner adoption, copied main-fence replacement
  by `restore_effect_hold`, and offline reverse held-barrier release order;
- the root-owned admin-attestation schema, age/workspace/manifest/evidence
  validation—including complete current inventory rather than historical
  absence—and journal binding all fail closed;
- manifest validation/reinstall only after bot/Monologue quiescence, exact
  bot/user scopes and app-token health,
  exact disjoint capture, restore-cutoff, and project-ready metadata schemas,
  labeled bot write/read proofs for all three with cross-schema rejection,
  labeled user-
  authored self-describing Monologue HMAC proof through the isolated verify-only
  service,
  schema-warning rejection, fsynced OAuth response generations with forward
  reauthorization after a consumed-but-unrecorded code, and durable ignored
  input claims for every user-authored credential/HMAC probe work before any Concierge
  restart or edge acceptance;
- Monologue receipt tests cover intent-before-post, timestamp-before-
  classification, ambiguous post reconciliation, Socket/receipt-worker claim
  races, all guarded parking/dead-owner edges, classification-before-seen,
  database-authoritative pending projection revisions plus crash-safe whole-file
  fsync/rename/delivered repair without repost, unconditional startup/restore
  digest repair even from a restored `delivered` row, exhaustive opaque-cursor
  scans with atomic page-members-plus-cursor commits, idempotent same-cursor
  replay, whole-scan stable-ID uniqueness and failed-page recovery, predecessor
  Socket claim plus narrow-finalizer proof, target integrated fallback proof
  with Socket transport disabled until the receipt worker exclusively
  classifies and the ordinary provider turn reaches an exact terminal result,
  exact `monologue-payload-v1` normalization/body/tuple/hash, tuple-v1 note
  identity, unpadded RFC-4648 base64url, ordered MAC-input, suffix and final-text
  UTF-8 and shared positive/negative golden-vector validation alongside
  payload/HMAC/truncation checks, verifier
  non-oracle behavior, secret denial from bot/providers, gate refusal,
  complete seen-file migration to no-repost tombstones, legacy-boundary audit,
  singleton inhibitor interleavings, and coherent backup;
- restore-mode startup with one seeded row for every normal side-effect worker
  performs zero ordinary external mutation and exactly the journaled bounded
  cutoff-sentinel control posts; acceptance proves zero pre-generation
  auto-claimable effects and no unproven resumable session; the external
  restore journal survives every individual DELETE-to-WAL transform and
  DB/WAL/SHM move/install crash (including pre-data rollback) and
  bootstraps recovery when the live operations DB is missing/corrupt; hot
  rollback-journal injection fails before replacement; dead-owner adoption
  preserves the current attempt's unit snapshot; every generation-era snapshot
  and restore row becomes terminal/non-adoptable; the same-token fresh local
  generation and catalog lease cleanup complete before restic selection or
  backup release, while the fixed O_EXCL admission journal prevents a second
  restore until fresh-process health, every hold release, and every prior unit/
  edge restoration are durable and its final rename is the last mutation; and
  bot-authored per-channel Slack sentinels with journaled intent/result/search
  and immutable oldest/latest intervals for sentinel, capture, Monologue, and
  full root/reply audit scans,
  exact declared metadata identity, plus exhaustive
  root/reply pagination park delayed unclaimed events at/before the closed
  boundary while permitting proven newer events; metadata or authenticated
  receipt orphans
  become tombstones; old Pebble/Monologue namespaces remain quarantined until a
  new audited epoch/cutoff exists; token-conditional acceptance exits and only
  a fresh normal process may resume workers;
- runtime capture code rejects missing/wrong schema rather than creating it;
- complete-tree searches find zero active references to the separate capture
  token/app and old Pebble URL after cleanup.

Run the full Bun suite once after focused tests pass. If it exposes a regression,
fix through focused tests and run the full gate at most once more.

Live proof requires:

1. `/audio`, Concierge, Monologue, queue, ingress, Caddy, and Worker health;
2. no Slack token or host-persistent writable directory in public ingress, and
   only bounded private tmpfs mounts;
3. unauthenticated, audio-bearing, oversized, unknown-path, raw pre-header
   slowloris, and connection-cap failures;
4. direct-origin Pebble request without the Worker credential fails; one labeled
   external Pebble request -> `202` -> one bot-authored inbox message -> one
   fresh default-provider turn with exact provider-start proof;
5. exact replay -> `200` and no second Slack message/turn;
6. one induced queue-capacity response, one snapshot-gate `503`/recovery probe,
   one held-gate pause/recovery probe, and one coherent backup-generation
   validation with classified Monologue receipt state, one bounded ready
   generation, uploaded catalog proof, all three raw DB file-set exclusions,
   immutable backup invocation, bounded timeout, and healthy concrete RPO alert
   target;
7. installed Concierge manifest/app/bot-user-scope/schema/config digests, app-
   token health, bot metadata plus self-describing user-authored HMAC/verifier
   write-read proofs, target-UID continuity proof or explicit archived
   disposition for every pre-cutover provider UUID, AF_UNIX peer-auth and
   disconnect-reap proof, distinct provider PID/mount namespace inodes,
   bot/provider secret-denial and proc-alias probes, one predecessor
   Socket-claimed/finalizer-classified Monologue receipt, and one target-fallback
   receipt whose Slack timestamp precedes its separately delivered seen
   projection revision;
8. validated current-inventory Slack-admin artifact, journal digest, sealed
   release manifest/Bun/dependency/package hashes, a scratch restic restore with
   release-local import trace, target SHA/systemd invocation, and complete-tree
   reference verification before declaring the post-cutover cleanup complete.

## Acceptance criteria

- Pebble can be configured with `https://capture.tejas.nyc/pebble`, its route
  bearer, and transcript-only delivery.
- The public process has no Slack credential, durable filesystem write path,
  destination control, queue database access, or router-state access.
- The existing Concierge bot is the only Slack writer for Pebble captures.
- A capture is complete only when its visible Slack message is atomically linked
  to an external-capture claim, fresh session, concrete turn, and exact provider
  initial-prompt acknowledgement.
- Stable event IDs survive delivery-contract upgrades; retained tombstones make
  retries first-wins. Coherent generations plus exclusive restore review never
  turn historical negative evidence into an automatic external-effect replay;
  restored source namespaces remain disabled until a new audited epoch and
  cutoff make post-restore inputs distinguishable.
- Trusted quotas—not merely ingress checks—bound pending rows and full-power
  external agent turns, and terminal detail/tombstone budgets bound cumulative
  trusted storage.
- New transcript sources are route/config additions, not new Slack writers.
- Existing `/audio` remains unchanged. Monologue keeps its current source,
  user-authored Slack message, and router flow while gaining a durable
  receipt/classification barrier; its seen file is a derived projection, not a
  delivery authority.
- Plan review is GO; implementation review is SHIP; focused and full tests pass;
  commits are pushed; and live verification succeeds before this is called
  deployed.

## Primary references

- Cloudflare Worker Custom Domains:
  https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- Cloudflare Worker rollback:
  https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/
- Caddy configuration and automatic HTTPS:
  https://caddyserver.com/docs/
- Slack `chat.postMessage`:
  https://docs.slack.dev/reference/methods/chat.postMessage/
- Slack message metadata:
  https://docs.slack.dev/messaging/message-metadata/
- Slack OAuth v2 response:
  https://docs.slack.dev/reference/methods/oauth.v2.access/
- SQLite Online Backup API:
  https://www.sqlite.org/backup.html
- SQLite write-ahead log file-set contract:
  https://www.sqlite.org/wal.html
- Bun Node-compatible HTTP server and runtime/module controls:
  https://bun.sh/reference/node/http/Server
  https://bun.sh/docs/runtime/module-resolution
- Restic backup exclusions:
  https://restic.readthedocs.io/en/stable/040_backup.html#excluding-files

## Review record

- Iteration 1 — **NO-GO**. Eight blockers: shared untrusted SQLite ownership,
  no durable router handoff, unbounded bearer authority, lossy Monologue cursor,
  unsafe old-poller cutover, undefined schema ownership, incomplete edge/local
  rollback, and stale documentation/OAuth provenance.
- Iteration 2 — **NO-GO**. Eleven blockers: Socket policy race, weak admission
  completion, unbounded/restore-unsafe spool, ingress-only quotas, incomplete
  delivery transitions, non-durable held gate, lossy Monologue cutover, mutable
  idempotency identity, unsafe self-updating first deployment, incomplete
  rollback, and unverified capture-app installation state.
- Iteration 3 — **NO-GO** after replacing the spool with a narrow trusted queue
  broker and bot-authored direct admission. Retained-ledger/backup restore,
  provider dispatch, quota accounting, Slack ambiguity, rendered length, tmpfs
  bounds, origin auth, resumable cutover, Monologue quiescence, and mandatory
  OAuth verification were still incomplete.
- Iteration 4 — **NO-GO**. The core parser/queue/single-writer architecture was
  retained, but seven contracts still depended on implementer invention:
  immutable identity/render snapshots, metadata-only positive Slack proof,
  typed provider-start outcomes, deployable backup/restore ownership, exact
  target runtime, reboot-safe Monologue inhibition, and machine-checkable
  Slack-admin attestation.
- Iteration 5 — **NO-GO**. Nine remaining blockers: delivery policy leaked into
  source identity; capture admission did not join the ordinary turn/session
  state machine; restore inferred non-delivery from an old snapshot and did not
  suppress generic side-effect workers; terminal main-DB state was unbounded;
  Slack metadata was unregistered; a git worktree omitted Bun dependencies;
  Monologue lacked a durable post/classification handoff; and historical
  `never_installed` was not verifiable.
- Iteration 6 — **NO-GO**. The reviewer accepted the core boundary but found
  eight residual gaps: a pre-bind reply race, an underbounded loopback broker,
  capture-only restore disposition, unenumerable post-generation source input,
  session-unsafe compaction, no guaranteed Monologue classification worker,
  split seen/receipt migration authority, and hardlinked/auto-install-capable
  release artifacts.
- Iteration 7 — **NO-GO**. Thirteen implementability gaps remained: pre-parser
  socket limits, complete v1 normalization, terminal barrier waiters, SQLite
  sidecar restore, mechanically enforced effect enumeration, exhaustive
  Monologue discovery, integrated classification ownership, receipt parking,
  inhibitor serialization, complete Slack credential recovery, failed-restic
  generation bounds, release-local module enforcement, and backup-restorable
  sealed dependencies.
- Iteration 8 — **NO-GO**. Eleven remaining contradictions: the current
  predecessor cannot pass its frozen install; in-flight imports and external
  effects can straddle snapshots; no callable fixed Online Backup implementation
  is sealed; operations state is outside coherent restore; predecessor receipt
  finalization has no legal actor; ready/uploaded generation state is circular;
  identity depends on mutable Unicode data; TypeScript-only effect permits are
  forgeable at runtime; Caddy forwards the origin credential; Slack consumers
  remain live across reinstall; and a new route cannot relieve a global ledger
  cap.
- Iteration 9 — **NO-GO**. Thirteen residual lifecycle gaps: operations state
  was first claimed before bootstrap; queue/main snapshot lock order and
  restore-fence ownership were incomplete; the snapshot core could deadlock on
  its caller's holds and lacked a separately audited privilege boundary; public
  ingress had no pre-parser envelope; the SQLite pin/signature was stale;
  rollback had no pre-credential standalone image; generation paths/orphan and
  prune phases were underspecified; stale-ready upload could falsely satisfy
  freshness; OAuth had a lost-response hole; user-authored probes could leak
  into Socket routing; Monologue assumed page order; and receipt/seen
  atomicity crossed SQLite and the filesystem.
- Iteration 10 — **NO-GO**. Nine remaining ownership gaps: data rollback could
  erase post-image Slack/provider work; probe provenance was used before its
  schema existed; mutable backup code deployed before the live timer drained;
  restore had no journal outside the three replaceable databases; the copied
  generation-era snapshot operation remained adoptable; ordinary Slack retries
  lacked a restore cutoff; the root-running bot could traverse the privileged
  control plane; effect auditing omitted non-TypeScript executables; and the
  26-hour retry promise had no durable owner/timer.
- Iteration 11 — **NO-GO**. Thirteen remaining closure gaps: observed Slack
  history was not a race-free reply-inclusive boundary; restore omitted rollback
  journals and could not bootstrap with a broken operations DB; copied restore
  operations remained adoptable; catalog restore lease could outlive its
  remotely omitted journal; restored seen projection state could disagree with
  the file; active backup drain accidentally stopped the oneshot; critical
  executables remained mutable; backup freshness had no bounded worker or real
  alert target and misused monotonic `Persistent=true`; Monologue page and
  cursor commits were split; its HMAC evidence was not self-describing; the key
  remained reachable by provider children; and root/proc aliases bypassed the
  proposed isolation.
- Iteration 12 — **NO-GO**. Nine remaining boundary gaps: an occupied restored
  `ready` slot deadlocked the mandatory fresh generation; restore admission was
  freed before final hold release; sentinel metadata had no registered durable
  identity; standalone DELETE images were not journal-converted back to WAL;
  the provider broker lacked authenticated admission and child ownership;
  existing provider state was stranded by the UID split; systemd was credited
  with a nonexistent PID-namespace primitive; Monologue receipt bytes remained
  underspecified; and the 26-hour alert had no clock owner without a retry row.
  This verdict followed an iteration that replaced the Slack cutoff with retained
  bot-authored per-channel sentinels plus exhaustive reply pagination; enforcing
  WAL-only canonical DBs and unknown-sidecar refusal; adding external-journal
  restore bootstrap and terminalization of every copied control operation;
  clearing the catalog lease only after a same-token fresh generation; forcing
  seen-file repair after restore/startup; draining old backups without stopping
  them; content-addressing critical executables; adding a bounded calendar retry
  worker and concrete durable health alert; atomically committing Monologue
  pages/cursors; making its receipt self-describing and verify-only; and splitting
  bot/providers into non-root, credential-disjoint, proc-restricted services.
- Iteration 13 — **NO-GO**. Fourteen remaining deployability gaps: the non-root
  bot could not traverse the mode-0700 queue; main/project/vault filesystem
  authority was not migrated; AX41 AppArmor denied the claimed rootless
  launcher; socket activation confused a listener with accepted sockets; closed
  SQLite validation would create WAL/SHM; root provider refresh credentials had
  two writers; Claude continuity was an unregistered real provider turn;
  provider state was outside later coherent generations; restore validated only
  `ready`; restic `dump` syntax was wrong and unbounded; terminal self-digests
  were not computable; Slack scans lacked immutable intervals; Monologue payload
  bytes were undefined; and channel/project/Git effects were absent from the
  registry.
- Iteration 14 — pending review after adding a setgid least-privilege queue
  ledger; journaled main/path ACL migration; an exact AppArmor launcher profile
  and real-UID probe; one `Accept=no` bounded broker accept loop; immutable URI
  SQLite validation; target-issued single-writer provider credentials and
  journaled safe continuity probes; provider bundles under every coherent
  snapshot/restore fence; whole-catalog exact restic enumeration/dump; JCS
  self-digests; immutable Slack recovery/audit intervals; byte-level Monologue
  payload vectors; and registered channel/membership/scaffold/announcement/
  slash/Git effect ownership.
