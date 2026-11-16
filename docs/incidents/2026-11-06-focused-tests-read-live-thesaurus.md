---
failure: Focused Concierge tests read Tejas's live thesaurus while building stub provider prompts.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Focused tests read the live thesaurus

## What was seen

An agent running the focused session controls suite with a scratch ledger found real
thesaurus entries and the live capability socket path in its captured provider prompt.
The agent report is retained as capture
`57254621953084ff2c5cdc3d58ae821e651fdbf74d99abb6f0d0118c412ef13c`.

## Cause

The execution host fetched thesaurus context before calling the provider. The test
replaced the provider but did not replace that earlier lookup, which uses Concierge's
configured Thinkering capability entrance.

## Fix

Native-turn focused tests pass a fixed context source to the execution host. The
production host retains the existing Thinkering lookup. The tests' scratch ledger
continues to isolate stored Concierge state.

That fix depended on each test remembering the fixed context. On 2026-11-10 the shared
test preload also took Thinkering away from every test process: the capability socket
variable points at a scratch path nothing listens on, and the network entrance variables
are removed. A test that omits the fixed context now fails closed to the "could not be
read" line instead of reading his live thesaurus, to-dos or captures.

## Acceptance scenario

- **Seed:** Run the native session controls suite with a scratch ledger and a real
  Thinkering capability entrance available to the process.
- **Action:** Dispatch a test turn to its stub provider.
- **Expected:** The captured prompt contains the fixed fixture context and no
  thesaurus content fetched from Thinkering; the test process makes no thesaurus
  request to the live capability entrance.
- **Replayable offline:** yes, with a request recorder standing in for the capability
  entrance and the test suite authorization enabled.
