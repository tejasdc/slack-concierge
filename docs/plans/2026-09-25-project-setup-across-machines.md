# Creating a project, and setting it up on the other machine

Status: approved by Tejas 2026-09-25 (after one rejected design). Designed with the catalog skill
`protocol-design`; the skill's blind test log is in `protocol-design-skill/docs/test-log.md`.

## Service

One way to create a project, the same from any agent or from Tejas's terminal on either machine:
a private GitHub repository under `tejasdc`, the standard layout, and the same project set up on
the other machine — now if it is awake, when it wakes otherwise. An existing project moves to the
other machine only when someone names it. Nothing ever compares or mirrors whole project lists:
the two machines hold different projects on purpose.

## Parts and where they run

| Part | Runs on | Does |
| --- | --- | --- |
| `project` command (in the `command-line-tools` project, linked into `~/.local/bin`) | either machine, any shell | Thin wrapper; calls that machine's `router-actions.sh projects …` |
| `router-actions.sh projects new|share|status` | either machine | Calls the local Concierge owner socket; passes the source pair when an agent has one |
| Concierge owner: creation | the machine where the command ran | Validates the name, writes the layout, creates the private repository, pushes, then records the outgoing setup order (idempotent: a re-run completes a half-finished creation) |
| Concierge peer sender | same machine | Delivers the order over the existing peer link; retries while the peer is away; pulls the outcome |
| Concierge peer receiver: `project.setup` handler | the other machine | Checks, clones with a fixed inert command, reports the outcome |

The peer link is the existing authenticated Tailscale listener (`/sessions/v1/*`, bearer token).
Today it carries durable session requests (kept and resent while the peer is away) and fast-fail
named operations (sign-in, file reads, project lists, resurrection). `project.setup` is the first
*durable named operation*: a typed sibling of the durable session request, reusing its retained
body, retry timer and push-plus-pull outcome.

## Names

A project name is how every agent and Tejas will recognise the project for years. The command
enforces the mechanical part and the instructions carry the rest:
- lowercase words joined by dashes, `^[a-z][a-z0-9]*(-[a-z0-9]+)+$` — at least two words;
- refused when any single word would do: a denylist of vague words used alone or as the whole
  meaning (`commands`, `tools`, `scripts`, `utils`, `misc`, `stuff`, `test`, `project`, `new`,
  `temp`, `app`, `helpers`, `things`, `notes`) — the refusal explains why and suggests saying what
  it is (e.g. `command-line-tools`);
- `--purpose "<one sentence>"` is required; it becomes the AGENTS.md first paragraph and the GitHub
  description, so the name and purpose are read together;
- not an existing local folder, not an existing `tejasdc` repository (the natural lock when both
  machines create the same name at once: GitHub refuses the second).

## `project new <name> --purpose "…" [--here-only]`

On the machine where it runs, in order: validate; create `~/workspace/<name>` from the existing
canonical scaffold (AGENTS.md, CLAUDE.md → AGENTS.md, docs/README.md, notes link into this machine's
vault when its vault root exists, `.gitignore` with `tmp/`); commit; `gh repo create
tejasdc/<name> --private --source … --push` (never a public option); then, in one ledger write,
record the creation and the outgoing order for the other machine unless `--here-only`. A failure
before the push leaves nothing half-registered: the local folder is kept and reported.

## `project share <name> --to <machine>`

For a project that already exists here whose origin is `github.com/tejasdc/<name>`: records the same order. This is
how an existing one-machine project (life-logistics) moves, once, when asked. It pushes nothing and
refuses a project whose local branch is ahead of its origin (so the other machine never gets a stale
copy) — push first.

## The order (message)

| Field | Why |
| --- | --- |
| `orderId` | Deduplication across resends; derived from (target machine, project, operation) so one project has one live order per target |
| `kind: "project.setup"` | Closed vocabulary; the receiver dispatches only known kinds |
| `origin` (peer, session, input, run, originating human — or `terminal` when run by hand) | Provenance and the return address |
| `project` | The folder name and the repository name (`tejasdc/<project>`); validated by the same grammar |

Forbidden slots: no URL, path, branch, owner, repository override, command, script or free text;
unknown fields are refused. The receiver builds `https://github.com/tejasdc/<project>.git` and
`~/workspace/<project>` itself. A project whose origin is named differently or lives under another
owner cannot be shared this way; `project share` refuses it with that reason. The outcome reports
the commit that was cloned.

## Receiver (`project.setup` handler in the receiving Concierge process)

Accepted (duplicate `orderId` → existing record) → checks → action → terminal:
- refused `unknown_kind`, `invalid_name`, `invalid_repository`, `destination_conflict` (folder
  exists with another origin, or not a git checkout);
- `already_present` when `~/workspace/<project>` already has that origin (a hand-made fallback);
- action: `git clone` with an argument list, no shell, into a temporary sibling folder, with hooks,
  submodules, non-https transports, LFS smudge and fsmonitor switched off and prompts disabled;
  the temporary folder is `~/workspace/.project-setup/<orderId>/<project>`, which the project
  scanner never lists; then rename into place and create the notes link if this machine's vault root exists;
- `done` only when the folder satisfies the machine's own project predicate (git dir + AGENTS.md);
- `failed` with a class: `transient` (network, unavailable — a resend re-attempts) or `permanent`
  (authentication, repository missing, not a project — final).
Nothing is overwritten, deleted, built or opened; no agent is started.

## Knowing the peer supports it

Each machine's existing status answer lists the named operations it accepts
(`operations: ["project.setup"]`). The sender checks it before sending; not listed means
`needs_update`. An unknown-route answer is treated the same way as a fallback.

## Crash recovery on the creating side

Creation involves an external step (the GitHub push), so it cannot share one database write with
the order. Instead `project new` is idempotent: re-running it on a folder whose private origin
already exists and is pushed completes the remaining steps and records the missing order. The order
is recorded only after the push succeeded.

## Sender states

`recorded` → `delivered` → `done | already_present | refused | failed`; `needs_update` (the peer
answered with an unknown route: parked, one notice saying the Mac needs updating, rechecked on every wake so it finishes as soon as the update lands);
`cancelled` (local cancel before delivery). While the peer is unreachable the order stays `recorded`
and is resent on the existing peer timer and immediately on any authenticated contact from that
peer. No expiry: a project created Friday should appear Monday. The asking session sees
"waiting for mac" at once; Tejas gets one notice after 24 hours of waiting.

## How it ends and who hears

The receiver pushes its terminal outcome; the sender also pulls on every wake, so a lost push is
never a lost outcome. The outcome returns to the asking session as a normal returned result when an
agent asked. Tejas hears only on refused, permanent failure, needs-update and the 24-hour wait, via
the provider-free notice path. `project status <name>` shows it at any time.

## Security statement

The order grammar cannot carry anything executable; the receiver's code is the guarantee (end-to-
end). Honest limit: the same link already accepts session requests that start agents on the Mac,
and holding its token is already root to both owners. `project.setup` adds nothing a leaked token
cannot already do. Narrowing the existing link is a separate decision for Tejas, not part of this.

## Documentation and instructions touched

- `docs/runbooks/PEER-INSTANCES.md`: the new operation, the real retry cadence, wake on contact.
- `docs/runbooks/ROUTER-ACTIONS.md` and `sessions --help`: `projects` verbs; the false claim that
  every project folder exists on both machines is replaced.
- Global instructions, project layout section: create projects only with `project new`; names must
  say what the project is.
- `command-line-tools` AGENTS.md: the house rules for building a command and its lessons log.
