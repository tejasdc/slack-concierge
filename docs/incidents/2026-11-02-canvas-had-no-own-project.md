---
failure: A Canvas voice session used a temporary product project because its Canvas had no durable project of its own.
date: 2026-11-02
fix_commits: []
cause_status: confirmed
---

# A Canvas had no project of its own

## What was seen

The Curiosity Engine Canvas listened successfully, but its session appeared inside the temporary
Thinkering project. Starting think-aloud could also stop at a project chooser instead of using a
project that belonged to the Canvas.

## Cause

Canvas creation saved only a workspace board. Project selection happened later in the browser,
so another creation path or a lost browser request could leave the board without a project. The
project service also had no durable board-to-project identity or standing Canvas placement policy.

## Fix

Concierge owns one durable project binding per Canvas board. It applies the workspace organizer's
retained Canvas policy, creates the local writing project before reporting it usable, and continues
private GitHub and Mac setup durably. The board ID supplies retry identity, so a renamed Canvas or a
replayed request cannot create a second project. Existing projects bind only by an explicit exact
name and optional folder.

## Acceptance scenario

- **Seed:** Install the organizer-approved Canvas policy; create an unnamed Canvas board with no binding.
- **Action:** Ensure the Canvas project twice, then repeat with a different display title.
- **Expected:** Every request returns the same board-bound project; its local server path is ready before remote setup completes, and no project chooser or duplicate project appears.
- **Replayable offline:** yes (the isolated owner fixture uses the same board identity, naming, pending, ready, and conflict contract without creating a GitHub repository).
