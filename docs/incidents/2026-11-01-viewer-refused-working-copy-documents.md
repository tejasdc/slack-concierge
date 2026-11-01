---
failure: The file viewer refused a Markdown design document an agent asked him to read, because it sat in the agent's .wt working copy
date: 2026-11-01
fix_commits: []
cause_status: confirmed
---

# "This kind of file does not open here" on an agent's design document

## What was seen

In-app bug report from Tejas (Mac, 2026-11-01 4:44 PM ET, capture
07dd9f6a721a2aaaf89a49a9b1537376bb4c09ce0c1e90b79a017b8f15fb860e). The phone agent linked
`/root/workspace/thinkering/.wt/phone-restart-nov1/docs/plans/2026-11-01-workspace-without-whole-history.md`
for him to read before it builds; the viewer showed "This kind of file does not open here …
neither are hidden files such as .env".

## Cause

`isSensitiveWorkspacePath` refused any path with a part starting with a dot. `.wt/<task>` (made by
`wt`) and `.worktrees/<task>` are where agents keep their working copies, so every document an
agent wrote in its own working copy was refused as a hidden file.

## Fix

`.wt` and `.worktrees` pass as directory parts only. Every other dot part (`.env`, `.git`, `.ssh`)
and the folder itself as a listed entry in the Files browser stay refused, as do the sensitive names.

## Acceptance scenario

- **Seed:** a Markdown file at `<workspace>/<project>/.wt/<task>/docs/plan.md` and a `.env` beside it.
- **Action:** `GET /sessions/v1/files?path=<that plan.md>`, then the same for the `.env`.
- **Expected:** the plan opens as `markdown`; the `.env` answers 415 `FILE_TYPE_UNSUPPORTED`.
- **Replayable offline:** yes
