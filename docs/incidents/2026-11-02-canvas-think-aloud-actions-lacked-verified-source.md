---
failure: Canvas think-aloud told Codex how to act without giving it the verified identity required by the Canvas action doors.
date: 2026-11-02
fix_commits: []
cause_status: confirmed
---

# Think-aloud could hear the user but could not safely act on the Canvas

## What was seen

The continuing Codex session received the spoken thought and instructions for organizing it, but its documented Canvas commands omitted the accepted speech input and run identity. The Canvas action doors therefore refused the proposal or page action. Delegating through the browser was not a safe fallback because that path sends as Tejas.

## Cause

The session owner supplied the board and action routes beside the exact speech transcript, but the generated commands did not carry the verified source header those routes require. This especially affected Mac Codex sessions, whose server-side process ancestry cannot identify the originating Mac session after the command crosses SSH.

## Fix

Every Canvas proposal and page-action command supplied to think-aloud now carries the accepted speech input and run as its verified agent source. The Canvas resolves that pair to the continuing Codex session before acting. Agent-authored words still enter as proposals with the exact spoken source, and asking or starting another agent remains on Concierge's agent request path rather than the browser's human send path.

## Acceptance scenario

- **Seed:** An isolated Canvas, one continuing Codex session, and an accepted speech input whose exact words are `Organize this thought on the canvas.`
- **Action:** Use the supplied command to create one Canvas idea, then repeat with a different source input while keeping the same verified turn.
- **Expected:** The first idea appears as a pending Codex proposal attributed to the continuing session and cites the accepted speech input. The substituted source is refused and creates no idea. A request to start another session through the Canvas page is refused in favor of Concierge's agent request path.
- **Replayable offline:** yes
