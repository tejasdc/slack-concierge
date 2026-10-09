# Bounded application logging

The server and its diagnostic workers send application lines through `bot/src/log.ts`.
The module creates one sink per output stream on first use. It writes to the runtime's
nonblocking stream and stops writing after `write()` returns `false`. Ordinary lines
arriving while that stream is blocked are discarded. Error and critical lines use a
reserve of at most 64 lines and 64 KiB per stream; new reserve entries evict the oldest.
The stream itself may retain its normal high-water buffer and the single line that
filled it. The logger adds no timer, thread, synchronous shutdown flush or disk queue.

On `drain`, each sink writes its reserve in order, followed by one
`log_lines_dropped` JSON line with counts by level and the blocked duration in
milliseconds. Dropped content is never included. A further full stream resumes the
same flush on its next `drain`. `logSinkCounters()` gives cumulative dropped counts,
blocked episodes and a current blocked flag for each stream; the metrics owner can
export these without reading the journal. Lines written while healthy retain their
existing serialization, fields and newline.

The exception is the one-shot presentation search reader: its stdout is a JSON result
read by the parent, so it remains a result protocol. The source guard in
`bot/scripts/bounded-logging-acceptance.py` enforces that boundary. Run that standalone
script with Python 3 on the server; it starts the installed Bun runtime with both
outputs connected to paused UNIX stream socketpairs, then checks timer progress,
memory, drop accounting, reserved error delivery, summary order and blocked exit.
It does not use the disabled test suites or production state.
