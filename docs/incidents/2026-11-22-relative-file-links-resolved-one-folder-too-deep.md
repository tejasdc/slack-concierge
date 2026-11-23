---
failure: Five relative file links an agent wrote in a Markdown document all resolved one folder too deep and none opened.
date: 2026-11-22
fix_commits: []
cause_status: confirmed
---

# Relative file links resolved from the document's folder

## What was seen

Tejas, by voice, Nov 22: none of five links in the Blygger agent's brainstorm document opened.
The agent wrote `docs/research/2026-11-22-engelbart-kay-blygger.md` inside
`/root/workspace/blygger-client/docs/2026-11-22-hackathon-brainstorm.md`: correct from the project
root, which is how agents write paths. The reader joined it to the document's folder, gave
`.../docs/docs/research/...` and called the file missing.

## Cause

The file read only took absolute paths, so the browser composed the path itself, using one rule
(the document's folder). Nothing on the machine holding the files decided between that and the
project root, and the door check only looked at absolute paths, so no warning was ever given.

## Fix

The file read takes the document a reference was written in (`from`) and resolves it on the
machine holding the file: document folder first, project root second, both existing is
FILE_AMBIGUOUS, neither is a refusal naming both. The door check judges relative references with
a folder through the same resolution, from the posting session's folder.

## Acceptance scenario

**Seed:** a project holding `docs/doc.md` and `docs/research/x.md`.

**Action:** read `docs/research/x.md` with `from` set to `docs/doc.md`; read `missing/y.md` the
same way; post text naming `docs/research/gone.md` from a session in that project.

**Expected:** the first opens the project-root file (before: missing); the second is refused,
naming both paths tried; the post goes and the posting agent is told.
