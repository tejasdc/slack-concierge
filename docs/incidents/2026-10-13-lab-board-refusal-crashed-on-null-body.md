---
failure: A lab board command refused by thnkr.ing crashed with "null is not an object" instead of saying why it was refused.
date: 2026-10-13
fix_commits: [30986a76]
cause_status: confirmed
---

# A lab board refusal crashed and hid its real status

## What was seen

During a live check on 2026-10-13, a `sessions board …` command that thnkr.ing's lab record refused failed
with "null is not an object" instead of the refusal's status. The agent could not tell what had been refused
or why.

## Cause

`lab()` in `bot/src/commons-board-service.ts` (since e3fcfa49, 2026-10-08) parsed the response with
`response.json().catch(() => ({}))` and then read `answer.code`, `answer.reason` and so on to build the
`BoardError`. That fallback covers a body that is not JSON, but a body that is the JSON literal `null` parses
successfully to `null`, so reading `answer.code` threw a TypeError inside the error path, replacing the
refusal with an unrelated crash.

## Fix

30986a76: the parsed body falls back to `{}` for both a parse failure and `null`
(`(await response.json().catch(() => null)) ?? {}`), and a refusal with no explanation names the HTTP status
and the route (`the lab record refused this (HTTP <status> from <method> /api/lab<path>)`).

## Acceptance scenario

- **Seed:** A stub lab route that answers 403 with body `null`, and another that answers 409 with an empty
  body.
- **Action:** Run a board write against each.
- **Expected:** Each fails with a `BoardError` naming its status (403 / 409), the method and the route; no
  TypeError.
- **Replayable offline:** yes (stub HTTP server standing in for thnkr.ing's lab route)
