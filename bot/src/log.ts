type LogLevel = "debug" | "info" | "warn" | "error" | "critical";
type Counts = Record<LogLevel, number>;
type Output = Pick<NodeJS.WriteStream, "write" | "on">;

const reserveLines = 64;
const reserveBytes = 64 * 1024;
const emptyCounts = (): Counts => ({ debug: 0, info: 0, warn: 0, error: 0, critical: 0 });

class BoundedLogSink {
  private blockedSince: number | null = null;
  private episodes = 0;
  private dropped = emptyCounts();
  private episodeDropped = emptyCounts();
  private reserve: { line: string; bytes: number; level: LogLevel }[] = [];
  private bytes = 0;
  private reportPending = false;

  constructor(private readonly stream: Output) {
    stream.on("drain", () => this.drain());
    // A closed journal socket must not crash the application over telemetry.
    stream.on("error", () => {});
  }

  snapshot() {
    return { dropped: { ...this.dropped }, blockedEpisodes: this.episodes,
      currentlyBlocked: this.blockedSince !== null };
  }

  write(level: LogLevel, line: string) {
    const payload = `${line}\n`;
    if (this.blockedSince === null) {
      if (!this.stream.write(payload)) this.block(true);
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

  private drain() {
    if (this.blockedSince === null) return;
    while (this.reserve.length) {
      const next = this.reserve.shift()!;
      this.bytes -= next.bytes;
      if (!this.stream.write(next.line)) return;
    }
    if (!this.reportPending) { this.blockedSince = null; return; }
    const summary = JSON.stringify({ event: "log_lines_dropped", ...this.episodeDropped,
      blocked_duration_ms: Math.max(0, Date.now() - this.blockedSince) });
    this.blockedSince = null;
    this.episodeDropped = emptyCounts();
    this.reportPending = false;
    if (!this.stream.write(`${summary}\n`)) this.block(false);
  }
}

let stdoutSink: BoundedLogSink | undefined;
let stderrSink: BoundedLogSink | undefined;

function sink(level: LogLevel): BoundedLogSink {
  if (level === "error" || level === "critical") return stderrSink ??= new BoundedLogSink(process.stderr);
  return stdoutSink ??= new BoundedLogSink(process.stdout);
}

export function logSinkCounters() {
  return { stdout: stdoutSink?.snapshot() ?? { dropped: emptyCounts(), blockedEpisodes: 0, currentlyBlocked: false },
    stderr: stderrSink?.snapshot() ?? { dropped: emptyCounts(), blockedEpisodes: 0, currentlyBlocked: false } };
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
