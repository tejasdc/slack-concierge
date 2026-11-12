---
failure: An automatic Codex account switch repeatedly failed because the packaged runner could not find its App Server bridge.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# The runner could not prove the Codex account switch

## What was seen

After the external-reset refusal was retired at 17:50 UTC, the server owner attempted to move Codex from the exhausted active account to the saved account with room. The live ledger had no running Codex turn. Three guarded attempts logged `Codex bridge is unavailable`; each left the Inbox queued and the account unchanged. The first installed release had its bridge file inside the sealed artifact.

## Cause

The bridge locator assumed every executable sat two directories under the release root, as the owner's application bundle and history worker do. The installed runner executable sits under `control/bot/scripts`, three parent steps below the release root. The locator missed that release's manifest and looked for a source-side bridge beside the bundled runner, where no such file exists. Account activation needed the bridge to prove the new daemon login, so it refused before claiming success.

## Fix

The locator walks a bounded four candidate directories upward from its executable to find the sealed release manifest. It still requires the declared bridge inside that exact release. Candidate validation and the isolated sealed-artifact check now exercise the runner's actual executable path as well as the history worker path. The existing guarded account move, identity proof, rollback and queue release remain responsible for activation.

## Acceptance scenario

- **Seed:** Prepare a sealed Concierge artifact with its runner executable and App Server bridge. The saved Codex account has room, the active account is exhausted, and no Codex turn is running.
- **Action:** Resolve the bridge from the runner executable path, then let the automatic guarded switch try the saved account.
- **Expected:** The candidate check refuses an artifact whose runner cannot find the bridge; the installed switch reaches and proves the new App Server account; the existing Inbox queue advances without re-accepting inputs.
- **Replayable offline:** path resolution and candidate refusal are replayable in an isolated sealed artifact; account proof and Inbox flow require the installed system.
