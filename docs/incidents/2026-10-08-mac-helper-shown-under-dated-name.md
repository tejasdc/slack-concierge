---
failure: Tejas's Mac permission prompt and Settings list showed the agent helper under an old copy's dated file name instead of thnkr.ing.
date: 2026-10-08
fix_commits: [1aef5fbe]
cause_status: confirmed
---

# The Mac helper appeared as "thnkr.ing-20261008T063145-49797"

## What was seen

On 2026-10-08 Tejas's Accessibility permission prompt and the macOS Settings list named the agent-host app
"thnkr.ing-20261008T063145-49797.app" rather than thnkr.ing.

## Cause

Confirmed from 1aef5fbe. `scripts/build-mac-agent-host.sh` moves an earlier build aside rather than deleting it,
because running agents (execution hosts) still use it. It renamed the old bundle with a timestamp, and macOS names
an app by its file name, so a process still running from the moved copy asked for permissions under that name.
The moved copy also stayed registered with Launch Services, so it showed in app lists, and old copies were never
removed.

## Fix

1aef5fbe: an old build moves into a dated folder but keeps its own name inside it, is unregistered from Launch
Services so only the copy under `app/` is listed, and every install removes moved copies no running process uses.

## Acceptance scenario

- **Seed:** a Mac with the agent host installed and an agent still running from it.
- **Action:** rebuild the helper, then trigger a permission prompt from the still-running agent; later, after
  that agent exits, install again.
- **Expected:** the prompt names thnkr.ing; Launch Services lists only the current copy; the old copy is
  deleted at the next install once unused.
- **Replayable offline:** no (needs macOS Launch Services and TCC)
