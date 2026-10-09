import { writeFileSync } from "node:fs";
import { log, logSinkCounters } from "../src/log";

const [mode, reportPath] = process.argv.slice(2);
if (!reportPath || (mode !== "pause" && mode !== "exit")) throw new Error("usage: bounded-logging-child.ts pause|exit REPORT");

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
