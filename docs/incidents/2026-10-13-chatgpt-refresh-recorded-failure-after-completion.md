---
failure: The daily ChatGPT history refresh was recorded as failed although it finished, because its answer arrived after the gateway had stopped waiting.
date: 2026-10-13
fix_commits: [aeb4e8ed]
cause_status: confirmed
---

# A completed daily ChatGPT refresh was recorded as a failure

## What was seen

On 2026-10-13 the daily 10:30 UTC ChatGPT transcript refresh took 267 s while ChatGPT was rate-limiting the
browser. The refresh timer (remote-box `scripts/thinkering-history-refresh.py`) received a 503 at 10:32:00 and
recorded a failure. The owner's handler finished the pass at 10:34:27 and answered 200 to nobody. remote-box's
companion commit says the same happened on 2026-10-10.

## Cause

The foreground gateway in front of the owner gives commands a 120 s deadline and answers 503 when it passes.
`POST /sessions/v1/sources/refresh` in `bot/src/session-owner.ts` holds its response for the whole pass, whose
length depends on ChatGPT's rate limiting and has no bound. The owner kept no record of the pass, so a caller
cut off at the deadline had no way to learn the outcome. Re-POSTing was not an option: after the pass settles
a second POST starts a new crawl, the immediate retry the contract forbids.

## Fix

aeb4e8ed: the owner remembers, in memory only, the most recent refresh pass it started (`sourceRefreshPass`).
A POST while a pass is pending joins it instead of starting another capability call, and the pass settles its
remembered outcome whether or not any caller is still attached. New `GET /sessions/v1/sources/refresh` returns
`{pass: null | {startedAt, settledAt, refresh, error}}` from that memory and never starts a pass; it is a named
live-owner control read (`native-read-routes.ts`, `owner-get-policy.ts`). Raising deadlines was rejected
because no number bounds rate limiting. Contract, surface fixture and SESSION-OWNER.md were updated.
remote-box cf75494 (outside this repository) makes the timer read that GET after a non-200 POST and report the
settled result.

## Acceptance scenario

- **Seed:** An owner behind a gateway with a 120 s command deadline (or a shortened one), and a stub ChatGPT
  refresh capability that answers after a longer delay with one `Refresh` item.
- **Action:** POST the refresh; after the gateway answers 503, POST again before the pass ends, then read
  `GET /sessions/v1/sources/refresh` until `settledAt` is set.
- **Expected:** The capability is called once; the second POST joins the pending pass; the GET shows
  `settledAt: null` while running, then the `Refresh[]` result with `error: null`. A failing stub records its
  owner error code in `error`.
- **Replayable offline:** yes (stub refresh capability and a shortened gateway deadline)
