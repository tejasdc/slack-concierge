/**
 * The Claude history snapshot format. A snapshot written by an older format is rebuilt once
 * when next read, while still serving its rows. Format 2 keeps the conversation before each
 * compaction (report 60b1809c, 2026-10-29); format 1 snapshots of compacted conversations
 * list only what followed the latest compaction.
 */
export const CLAUDE_HISTORY_FORMAT = 2;
