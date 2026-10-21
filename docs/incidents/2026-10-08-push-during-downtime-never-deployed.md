---
failure: Commits pushed while Concierge was down, including a fix for that outage, sat on main with no update coming until someone redelivered the webhook by hand.
date: 2026-10-08
fix_commits: [d7c30d2b]
cause_status: confirmed
---

# A push made while Concierge was down never became an update

## What was seen

On 2026-10-08 two commits, one of them the restart-limit fix (efc3fffa) for the outage that had just stopped
Concierge, sat on main with no update scheduled. The update came only after the GitHub delivery was
redelivered by hand.

## Cause

Confirmed from d7c30d2b. Deployment intent is created only by `acceptGitHubDeploymentPush` when GitHub's push
webhook arrives. GitHub announces a push once; while Concierge is down the webhook gets a 502 and nothing
retries it. Startup scheduled deployment work (`scheduleDeploymentWork("startup")`) but never compared the
deployment source's main with the accepted desired commit.

## Fix

d7c30d2b: `catchUpMissedPush` in `deployment-push.ts` fetches `origin/main` in the deployment-owned source at
startup and accepts its head as a push (`deliveryId: startup-catch-up:<head>`); a main already accepted changes
nothing. `index.ts` runs it before scheduling startup deployment work and logs
`deployment_missed_push_checked` or `deployment_missed_push_check_failed`.

## Acceptance scenario

- **Seed:** deployment desired commit = C1; `origin/main` = C2 (pushed while the owner was down, webhook lost).
- **Action:** start Concierge.
- **Expected:** desired commit becomes C2 and a deployment run is requested for it; restarting again with main
  still C2 creates no second request.
- **Replayable offline:** yes (scratch bare repository as origin and a scratch ledger)
