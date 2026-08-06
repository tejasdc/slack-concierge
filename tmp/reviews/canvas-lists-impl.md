# Canvas + Slack Lists Implementation

## Shipped

- Added additive channel state columns:
  - `channels.canvas_id`
  - `channels.list_id`
  - `channels.list_title_column_id`
  - `channels.list_completed_column_id`
- Added Canvas mirroring from `AGENTS.md` to Slack channel Canvas:
  - Creates a channel Canvas with `conversations.canvases.create`.
  - Updates an existing Canvas with whole-document `canvases.edit` replace.
  - Re-renders after agent turns where `AGENTS.md` changed.
  - Re-renders all known channel Canvases on startup and every 6 hours.
- Added Slack Lists integration:
  - Creates one todo-mode Slack List per channel.
  - Grants channel write access with `slackLists.access.set`.
  - Writes `/todo`, `/note`, message `/todo`, message `/note`, `!todo`, `!note`, and message shortcuts to both markdown and Slack Lists.
  - Reads List rows through `slackLists.items.list` into `notes/list.md`.
  - Injects List context into Codex/Claude prompts.
  - Lets agents request List writes with exact final-response lines:
    - `CONCIERGE_LIST_ADD: <todo text>`
    - `CONCIERGE_LIST_COMPLETE: <Slack List row id>`
- Added missing-scope handling:
  - Logs exact `needed` scopes.
  - Posts an ephemeral admin instruction in the triggering channel when a user is available.
  - Continues markdown writes instead of crashing.
- Added paid-plan/List-disabled handling:
  - Logs `list_paid_plan_failure`.
  - Posts to `#bot-status` when Slack Lists are unavailable due to workspace plan/feature errors.
- Updated `slack-app-manifest.json` with Slack's current scope names:
  - `canvases:read`
  - `canvases:write`
  - `lists:read`
  - `lists:write`

## Verification

- Local tests pass: `bun test`
- Diff whitespace check passes: `git diff --check`
- Added focused tests:
  - `bot/tests/canvas.test.ts`
  - `bot/tests/lists.test.ts`

## API Notes

- Slack's current Canvas API supports create/edit and section lookup, but not a deterministic raw Canvas document read suitable for bidirectional `Canvas -> AGENTS.md` sync. Concierge ships deterministic one-way `AGENTS.md -> Canvas` plus scheduled re-render.
- Slack's current List scopes are `lists:read` and `lists:write`, not `slack_lists:read` or `slack_lists:write`.

## Blocked / Needs Tejas

- Tejas must reinstall the Slack app after applying the manifest scope updates.
- Live AX41 deployment and Slack API verification require network/SSH access to `root@95.217.119.40` and the production Slack tokens at `/root/.config/concierge/slack.toml`.
- After reinstall/deploy, verify:
  - Restart: `systemctl restart concierge-bot`
  - Tail journal and confirm no crash.
  - Post `/todo test-item` as Tejas and verify `slackLists.items.list` returns the new row.
  - Change a channel `AGENTS.md`, complete a turn, and verify `canvases.sections.lookup` finds the updated content.

