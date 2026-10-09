import { writeFileSync } from "node:fs";
import { log, logSinkCounters, maxLogRecordBytes } from "../src/log";

const [mode, reportPath] = process.argv.slice(2);
if (!reportPath || !["pause", "exit", "oversized", "closed", "throw"].includes(mode))
  throw new Error("usage: bounded-logging-child.ts pause|exit|oversized|closed|throw REPORT");

if (mode === "oversized") {
  log("info", "logging_acceptance_normal", { message: "é" });
  log("error", "logging_acceptance_oversized", { message: "💡".repeat(maxLogRecordBytes) });
  writeFileSync(reportPath, JSON.stringify({ counters: logSinkCounters(), cap: maxLogRecordBytes }));
  process.exit(0);
}

if (mode === "closed") {
  log("info", "logging_acceptance_open");
  log("error", "logging_acceptance_open");
  writeFileSync(`${reportPath}.ready`, "ready");
  setTimeout(() => {
    log("info", "logging_acceptance_closed_stdout");
    log("error", "logging_acceptance_closed_stderr");
    setTimeout(() => {
      log("info", "logging_acceptance_closed_again");
      log("error", "logging_acceptance_closed_again");
      writeFileSync(reportPath, JSON.stringify({ counters: logSinkCounters() }));
      process.exit(0);
    }, 50);
  }, 100);
} else if (mode === "throw") {
  log("info", "logging_acceptance_open");
  log("error", "logging_acceptance_open");
  const stdoutWrite = process.stdout.write;
  const originalWrite = process.stderr.write;
  (process.stdout as any).write = () => { throw Object.assign(new Error("broken pipe"), { code: "EPIPE" }); };
  (process.stderr as any).write = () => { throw Object.assign(new Error("stream destroyed"), { code: "ERR_STREAM_DESTROYED" }); };
  log("info", "logging_acceptance_throwing_stdout");
  log("error", "logging_acceptance_throwing_stderr");
  (process.stdout as any).write = stdoutWrite;
  (process.stderr as any).write = originalWrite;
  process.stdout.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
  process.stderr.emit("error", Object.assign(new Error("stream destroyed"), { code: "ERR_STREAM_DESTROYED" }));
  writeFileSync(reportPath, JSON.stringify({ counters: logSinkCounters() }));
  setTimeout(() => process.exit(0), 20);
} else {

const started = Date.now();
const initialRss = process.memoryUsage().rss;
let maxRss = initialRss;
let ticks = 0;
let ticksAtPause = 0;
const filler = "x".repeat(360);

const timer = setInterval(() => {
  ticks++;
  maxRss = Math.max(maxRss, process.memoryUsage().rss);
  for (let i = 0; i < 20; i++) log("info", "logging_acceptance_ordinary", { filler, tick: ticks, line: i });
  if (mode === "pause" && ticks <= 100) {
    for (let i = 0; i < 10; i++) log("error", "logging_acceptance_fill", { filler, tick: ticks, line: i });
  }
  if (mode === "pause" && ticks === 220) log("error", "logging_acceptance_reserved", { marker: "reserved-error" });
}, 10);

if (mode === "pause") setTimeout(() => { ticksAtPause = ticks; }, 3000);

setTimeout(() => {
  clearInterval(timer);
  writeFileSync(reportPath, JSON.stringify({ ticks, ticksAtPause, elapsedMs: Date.now() - started,
    rssGrowth: maxRss - initialRss, counters: logSinkCounters() }));
  process.exit(0);
}, mode === "pause" ? 3900 : 500);
}
