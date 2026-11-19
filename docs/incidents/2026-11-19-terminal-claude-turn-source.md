---
failure: A Claude Code conversation resumed in the terminal could neither save files nor file reports.
date: 2026-11-19
fix_commits: []
cause_status: confirmed
---

# Terminal Claude Code had no current Concierge turn

## What was seen

The November 19 Essos bug report attachment in capture
`47da213a6b2c7a056480348b91ef3d12135f5ddf69bde3c1a0728514b2fc61de`
describes denied project and scratch writes and an `AGENT_SOURCE_UNKNOWN`
report refusal. The Claude Code transcript records the write refusals at
22:33 and 22:34 UTC and the report refusal at 22:39 UTC.

## Cause

The edit hook recognized the provider conversation but had no running Concierge
turn. A named scratch write also entered the edit budget. The report used the
pair from earlier work and the owner refused that association. The transcript
records a login before the refusals. It does not establish that login caused
them.

## Fix

The local managed prompt hook retains its own command source for the resumed
conversation, with ordinary source checks on the resulting commands. The edit
gate checks terminal repository edits against that process and treats scratch
file saves as outside the edit budget.

The initial repair reserved a running turn for the terminal. A real Claude Code
test returned to its prompt after Escape while the reservation stayed running.
Terminal prompts now provide command source identity without an app execution
lease. An app claim retires the previous terminal source atomically.

## Acceptance scenario

- **Seed:** An idle Concierge Claude Code conversation with a known native UUID.
- **Action:** Resume it by UUID in a terminal and submit a prompt that writes a
  project file, writes a scratch file and files a report.
- **Expected:** Both files are written and the Inbox report attributes the
  current terminal prompt. Escape followed by app work in the same conversation
  lets that work start and retires the prior terminal command source.
- **Replayable offline:** yes, through a disposable owner and process fixture
  for command source admission and a CLI hook check for scratch classification.
