type LogLevel = "debug" | "info" | "warn" | "error" | "critical";
type Counts = Record<LogLevel, number>;
type Output = Pick<NodeJS.WriteStream, "write" | "on" | "destroyed" | "writableEnded">;

const reserveLines = 64;
const reserveBytes = 64 * 1024;
export const maxLogRecordBytes = 16 * 1024;
const emptyCounts = (): Counts => ({ debug: 0, info: 0, warn: 0, error: 0, critical: 0 });

class BoundedLogSink {
  private blockedSince: number | null = null;
  private episodes = 0;
  private dropped = emptyCounts();
  private truncated = emptyCounts();
  private streamFailures = 0;
  private failed = false;
  private episodeDropped = emptyCounts();
  private reserve: { line: string; bytes: number; level: LogLevel }[] = [];
  private bytes = 0;
  private reportPending = false;

  constructor(private readonly stream: Output) {
    stream.on("drain", () => this.drain());
    // A closed journal socket must not crash the application over telemetry.
    stream.on("error", () => this.fail());
  }

  snapshot() {
    return { dropped: { ...this.dropped }, truncated: { ...this.truncated }, streamFailures: this.streamFailures,
      blockedEpisodes: this.episodes,
      currentlyBlocked: this.blockedSince !== null };
  }

  write(level: LogLevel, line: string) {
    if (this.failed) { this.drop(level); return; }
    // UTF-8 uses at most three bytes per UTF-16 code unit, so short lines skip sizing.
    const originalBytes = (line.length + 1) * 3 > maxLogRecordBytes ? Buffer.byteLength(line) + 1 : 0;
    if (originalBytes > maxLogRecordBytes) {
      this.truncated[level]++;
      let record: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) record = parsed;
      } catch { /* Legacy plain-text diagnostic lines have no structured fields. */ }
      const event = typeof record.event === "string" ? record.event : "unstructured_log_line";
      line = JSON.stringify({ ts: typeof record.ts === "string" ? record.ts.slice(0, 64) : new Date().toISOString(),
        level, event: event.slice(0, 256), truncated: true, originalBytes });
    }
    const payload = `${line}\n`;
    if (this.blockedSince === null) {
      const result = this.writeToStream(payload);
      if (result === "blocked") this.block(true);
      if (result === "failed") this.drop(level);
      return;
    }
    if (level !== "error" && level !== "critical") {
      this.drop(level);
      return;
    }
    const bytes = Buffer.byteLength(payload);
    if (bytes > reserveBytes) { this.drop(level); return; }
    while (this.reserve.length >= reserveLines || this.bytes + bytes > reserveBytes) {
      const oldest = this.reserve.shift()!;
      this.bytes -= oldest.bytes;
      this.drop(oldest.level);
    }
    this.reserve.push({ line: payload, bytes, level });
    this.bytes += bytes;
    this.reportPending = true;
  }

  private block(report: boolean) {
    this.blockedSince = Date.now();
    this.episodes++;
    this.reportPending = report;
  }

  private drop(level: LogLevel) {
    this.dropped[level]++;
    this.episodeDropped[level]++;
    this.reportPending = true;
  }

  private fail() {
    if (this.failed) return;
    this.failed = true;
    this.streamFailures++;
    for (const entry of this.reserve) this.drop(entry.level);
    this.reserve = [];
    this.bytes = 0;
    this.blockedSince = null;
    this.reportPending = false;
  }

  private writeToStream(payload: string): "written" | "blocked" | "failed" {
    if (this.failed) return "failed";
    if (this.stream.destroyed || this.stream.writableEnded) { this.fail(); return "failed"; }
    try {
      const written = this.stream.write(payload);
      if (this.failed) return "failed";
      return written ? "written" : "blocked";
    } catch {
      this.fail();
      return "failed";
    }
  }

  private drain() {
    if (this.blockedSince === null) return;
    while (this.reserve.length) {
      const next = this.reserve.shift()!;
      this.bytes -= next.bytes;
      const result = this.writeToStream(next.line);
      if (result === "failed") { this.drop(next.level); return; }
      if (result === "blocked") return;
    }
    if (!this.reportPending) { this.blockedSince = null; return; }
    const summary = JSON.stringify({ event: "log_lines_dropped", ...this.episodeDropped,
      blocked_duration_ms: Math.max(0, Date.now() - this.blockedSince) });
    this.blockedSince = null;
    this.episodeDropped = emptyCounts();
    this.reportPending = false;
    if (this.writeToStream(`${summary}\n`) === "blocked") this.block(false);
  }
}

let stdoutSink: BoundedLogSink | undefined;
let stderrSink: BoundedLogSink | undefined;

function sink(level: LogLevel): BoundedLogSink {
  if (level === "error" || level === "critical") return stderrSink ??= new BoundedLogSink(process.stderr);
  return stdoutSink ??= new BoundedLogSink(process.stdout);
}

export function logSinkCounters() {
  const empty = () => ({ dropped: emptyCounts(), truncated: emptyCounts(), streamFailures: 0,
    blockedEpisodes: 0, currentlyBlocked: false });
  return { stdout: stdoutSink?.snapshot() ?? empty(), stderr: stderrSink?.snapshot() ?? empty() };
}

/** Preserve existing serialized records, including legacy diagnostic lines. */
export function writeLogLine(level: LogLevel, line: string) { sink(level).write(level, line); }

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  writeLogLine(level, JSON.stringify(line));
}

export function errorFields(err: unknown) {
  if (err instanceof Error) return { error: err.message, stack: err.stack };
  return { error: String(err) };
}
