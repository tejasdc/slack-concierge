# Bounded application logging

The server and its diagnostic workers send application lines through `bot/src/log.ts`.
The module creates one sink per output stream on first use. It writes to the runtime's
nonblocking stream and stops writing after `write()` returns `false`. Ordinary lines
arriving while that stream is blocked are discarded. Error and critical lines use a
reserve of at most 64 lines and 64 KiB per stream; new reserve entries evict the oldest.
The stream itself may retain its normal high-water buffer and the single line that
filled it. The logger adds no timer, thread, synchronous shutdown flush or disk queue.
Each record, including its newline, is capped at 16 KiB before any stream write.
Larger records become complete JSON markers with their timestamp, level, event,
`truncated: true` and `originalBytes`; the per-level truncation counters expose the
loss. The cap is about five times the largest JSON record in the October 8–9 server
journal sample (3,326 bytes across 147,542 records), which was an owner lag record
with an in-flight list. It also leaves room for ordinary error stacks while holding
one healthy write at a quarter of the 64 KiB error reserve.

Every stream write checks for an ended or destroyed stream and catches synchronous
errors. An error listener absorbs asynchronous stream errors. Either failure stops
further writes to that stream, drops queued records, and increments the stream failure
counter; later attempted records increment their level's drop count. Logging never
reports sink failure back to the failed sink.

On `drain`, each sink writes its reserve in order, followed by one
`log_lines_dropped` JSON line with counts by level and the blocked duration in
milliseconds. Dropped content is never included. A further full stream resumes the
same flush on its next `drain`. `logSinkCounters()` gives cumulative dropped and
truncated counts, stream failures, blocked episodes and a current blocked flag for
each stream; the metrics owner can
export these without reading the journal. Lines written while healthy retain their
existing serialization, fields and newline.

The exception is the one-shot presentation search reader: its stdout is a JSON result
read by the parent, so it remains a result protocol. The source guard in
`bot/scripts/bounded-logging-acceptance.py` enforces that boundary in both the
package build and deployment candidate build. Run the full standalone acceptance
script with Python 3 on the server; it starts the installed Bun runtime with both
outputs connected to paused UNIX stream socketpairs, then checks timer progress,
memory, drop accounting, reserved error delivery, summary order, oversized records,
closed streams and blocked exit.
It does not use the disabled test suites or production state.

## Mac launchd retention

The same application sink runs on the Mac, but launchd writes its output to regular
files rather than the server's retained journal. The sink's memory/backpressure bound
does not bound those files. The existing fifteen-minute automatic update job now runs
`scripts/mac-disk-maintenance.py` before deciding whether an update is due or work is
busy. It rotates only the seven named Concierge launchd output files at 32 MiB,
preserving the inode and append descriptors through copytruncate. No process restarts
or macOS permission prompts are required.

The first oversized generation is compressed in full as `<name>.0.gz` and retained as
incident evidence (including the November 10–12 freeze diagnostics). Subsequent
generations retain at most the newest 32 MiB, compressed under immutable numeric
time identifiers; only the newest three ordinary generations are kept.
Thus the ordinary retained history is at most 192 MiB uncompressed per file after a
pass (three 32 MiB tails plus up to 32 MiB compression-time appends each), plus the
separately counted, fixed first evidence generation. The active file
continues growing between passes; this is periodic retention, not an instantaneous
writer cap. Rotation snapshots have a fixed length and compression streams in 1 MiB
chunks. Up to 32 MiB appended during compression is preserved in the same gzip archive;
faster growth refuses truncation. Archive failures leave the source intact. Like
standard copytruncate, a write between the final snapshot and truncation can be lost;
these diagnostics are not the durable session or request record.

Existing generations expire only after replacement compression, fsync and truncation
succeed. A known failure before publication retries without aging history. A retained
per-log rotation marker after publication holds further rotation and records one
repair notice; the repair agent reconciles whether truncation happened before clearing
that marker. Ambiguous publication never silently repeats or expires another archive.

Archives remain in the same log directory and use numbered names so the existing
log observer can follow file shrinkage. A generation lasts at least an updater
interval, longer than the observer's five-minute interval. The exact limits, receipts,
rollback and disposable acceptance are in
[Mac disk maintenance](../runbooks/MAC-DISK-MAINTENANCE.md).
