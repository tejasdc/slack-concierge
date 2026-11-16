import { execFile } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";

const exec = promisify(execFile);
const stateDir = join(process.env.CONCIERGE_STATE_DIR || "", "speech");
const native = join(stateDir, "process-footprint");
const webAppBundle = "com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792";
const webContentPath = "/com.apple.WebKit.WebContent.xpc/";
const eventRetentionMs = 14 * 24 * 60 * 60_000;
const pre: Sample[] = [];
const events = new Map<string, VoiceEvent>();
let timer: ReturnType<typeof setInterval> | undefined;
let eventTimer: ReturnType<typeof setInterval> | undefined;
let busy = false;
let last: Sample | undefined;
let persistQueue: Promise<void> = Promise.resolve();
let pendingWrites = 0;
let lastPersistError: string | null = null;

type ProcessReading = { pid: number; birthAbstime: number; userNs: number; systemNs: number; physicalBytes: number; path: string };
type Sample = { at: string; elapsedMs: number; helper: ProcessReading | null; engine: ProcessReading | null; launcher: ProcessReading | null; shell: ProcessReading | null; children: ProcessReading[]; error?: string };
type VoiceEvent = { id: string; mode: "dictation" | "canvas_voice" | "think_aloud" | "unknown"; pageSessionId: string | null; beganAt: string; endedAt?: string; cutoffAt?: string; page: { pid: number; birthAbstime: number; evidence: string } | null; attribution: string; attributionDiagnostics?: AttributionDiagnostics; samples: Sample[]; deadline: number; afterUntil?: number };
// Content-free: process IDs, WebKit page-proxy IDs, timestamps, counts and command outcome classes only.
type StageOutcome = { stage: "log_query" | "renderer_launch"; outcome: "ok" | "timeout" | "exit" | "signal" | "output_limit" | "spawn_error" | "unknown_error"; elapsedMs: number; exitCode?: number; signal?: string; errorCode?: string };
type OpenProxy = { pageProxyId: number; pid: number; committedAt: string | null; liveChild: boolean; serviceWorkerPid: boolean };
type CandidateLifecycle = { pid: number; birthAbstime: number; launchedAt: string | null; launchedBeforeLogWindow: boolean | null; openMainFrameProxyIds: number[] };
type AttributionDiagnostics = {
  version: 1; elapsedMs: number; logWindowMs: number; stages: StageOutcome[];
  reason: "no_live_web_app_page" | "log_query_failed" | "no_open_main_frame_proxy" | "multiple_open_main_frame_proxies" | "open_proxy_not_unique_live_child" | "renderer_launch_unknown" | "renderer_older_than_log_window" | "unique" | "observer_error";
  lifecycleLines?: { commits: number; mainFrameCommits: number; closes: number; serviceWorkerLines: number };
  openMainFrameProxies?: OpenProxy[]; candidates?: CandidateLifecycle[]; errorName?: string;
};

async function command(file: string, args: string[], timeout = 1500) {
  const answer = await exec(file, args, { timeout, maxBuffer: 512 * 1024 });
  return answer.stdout;
}

async function reading(pid: number): Promise<ProcessReading | null> {
  try {
    const result = JSON.parse(await command(native, [String(pid)], 700)) as ProcessReading;
    if (result.pid !== pid || !Number.isSafeInteger(result.birthAbstime)) return null;
    return result;
  } catch { return null; }
}

function shellPid(lines: string[]): number | null {
  const matches = lines.flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+\d+\s+(.+)$/);
    return match && match[2].includes("/System/Library/CoreServices/Web App.app/Contents/MacOS/Web App") && match[2].includes(`--bundleidentifier ${webAppBundle}`) ? [Number(match[1])] : [];
  });
  return matches.length === 1 ? matches[0] : null;
}

async function childrenOf(shell: number): Promise<number[]> {
  const output = await command("/bin/launchctl", ["print", `pid/${shell}`], 1300);
  return [...output.matchAll(/^\s*(\d+)\s+-\s+com\.apple\.WebKit\.WebContent\.[\w-]+/gm)].map((match) => Number(match[1])).slice(0, 8);
}

async function sample(): Promise<Sample> {
  const start = performance.now();
  const result: Sample = { at: new Date().toISOString(), elapsedMs: 0, helper: null, engine: null, launcher: null, shell: null, children: [] };
  try {
    const processes = (await command("/bin/ps", ["-axo", "pid=,ppid=,args="], 1500)).split("\n");
    const shell = shellPid(processes);
    result.helper = await reading(process.pid);
    result.launcher = await reading(process.ppid);
    const engine = processes.flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      return match && Number(match[2]) === process.pid && match[3].startsWith(join(stateDir, "apple-speech-server")) ? [Number(match[1])] : [];
    });
    if (engine.length === 1) result.engine = await reading(engine[0]);
    if (shell) {
      result.shell = await reading(shell);
      const children = await childrenOf(shell);
      result.children = (await Promise.all(children.map(reading))).filter((item): item is ProcessReading => !!item && item.path.includes(webContentPath));
    }
  } catch (error) { result.error = error instanceof Error ? error.message.slice(0, 100) : "unknown"; }
  result.elapsedMs = Math.round(performance.now() - start);
  return result;
}

// WebKit's app-owned page-proxy lifecycle is stronger than a WebContent start-time match.
// Missing or truncated unified logs produce unknown, never a guessed page.
const logWindowMs = 30 * 60_000;

function failedStage(stage: StageOutcome["stage"], error: unknown, elapsedMs: number): StageOutcome {
  const failure = (error && typeof error === "object" ? error : {}) as { code?: unknown; killed?: unknown; signal?: unknown };
  const signal = typeof failure.signal === "string" ? failure.signal.slice(0, 16) : undefined;
  if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { stage, outcome: "output_limit", elapsedMs };
  if (failure.killed === true) return { stage, outcome: "timeout", elapsedMs, signal };
  if (typeof failure.code === "number") return { stage, outcome: "exit", elapsedMs, exitCode: failure.code };
  if (signal) return { stage, outcome: "signal", elapsedMs, signal };
  if (typeof failure.code === "string") return { stage, outcome: "spawn_error", elapsedMs, errorCode: failure.code.slice(0, 40) };
  return { stage, outcome: "unknown_error", elapsedMs };
}

async function timedStage(stage: StageOutcome["stage"], file: string, args: string[], timeout: number) {
  const start = performance.now();
  try {
    const stdout = await command(file, args, timeout);
    return { stdout, outcome: { stage, outcome: "ok", elapsedMs: Math.round(performance.now() - start) } as StageOutcome };
  } catch (error) {
    // `ps -p` exits 1 when one listed PID has exited but still prints the others.
    const partial = error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string" ? error.stdout : null;
    return { stdout: partial, outcome: failedStage(stage, error, Math.round(performance.now() - start)) };
  }
}

function localLogTime(line: string) {
  const stamp = line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})/);
  const at = stamp ? new Date(`${stamp[1]}T${stamp[2]}`) : null;
  return at && Number.isFinite(at.valueOf()) ? at.toISOString() : null;
}

// WebKit's app-owned page-proxy lifecycle is stronger than a WebContent start-time match.
// Missing or truncated unified logs produce unknown, never a guessed page. Diagnostics record
// which boundary failed and every open main-frame proxy, so ambiguity stays visible instead of
// being resolved by largest child or start-time coincidence.
async function attribute(shell: ProcessReading | null, candidates: ProcessReading[]) {
  const start = performance.now();
  const stages: StageOutcome[] = [];
  const finish = (attribution: string, reason: AttributionDiagnostics["reason"], extra: Partial<AttributionDiagnostics> = {}, page: VoiceEvent["page"] = null) =>
    ({ page, attribution, diagnostics: { version: 1, elapsedMs: Math.round(performance.now() - start), logWindowMs, stages, reason, ...extra } as AttributionDiagnostics });
  if (!shell || !candidates.length) return finish("no_live_web_app_page", "no_live_web_app_page");

  const query = await timedStage("log_query", "/usr/bin/log", ["show", "--last", "30m", "--info", "--style", "compact", "--predicate", `processID == ${shell.pid} AND (eventMessage CONTAINS "WebPageProxy::didCommitLoadForFrame" OR eventMessage CONTAINS "WebPageProxy::close" OR eventMessage CONTAINS "service worker process without page")`], 3000);
  stages.push(query.outcome);
  const open = new Map<number, { pid: number; committedAt: string | null }>();
  const workers = new Set<number>();
  const lifecycleLines = { commits: 0, mainFrameCommits: 0, closes: 0, serviceWorkerLines: 0 };
  if (query.outcome.outcome === "ok") {
    for (const line of (query.stdout ?? "").split("\n")) {
      const worker = line.match(/\[PID=(\d+)\].*service worker process without page/);
      if (worker) { workers.add(Number(worker[1])); lifecycleLines.serviceWorkerLines++; }
      const match = line.match(/\[pageProxyID=(\d+), webPageID=\d+, PID=(\d+)\] WebPageProxy::(didCommitLoadForFrame|close):?/);
      if (!match) continue;
      if (match[3] === "close") { lifecycleLines.closes++; open.delete(Number(match[1])); continue; }
      lifecycleLines.commits++;
      if (line.includes("isMainFrame=1")) { lifecycleLines.mainFrameCommits++; open.set(Number(match[1]), { pid: Number(match[2]), committedAt: localLogTime(line) }); }
    }
  }

  // One read of every candidate's start time, taken even when the log query failed, shows whether
  // the 30-minute lifecycle window could have contained each renderer's main-frame commit.
  const launch = await timedStage("renderer_launch", "/bin/ps", ["-p", candidates.map((item) => item.pid).join(","), "-o", "pid=,lstart="], 700);
  stages.push(launch.outcome);
  const launchedAt = new Map<number, number>();
  for (const line of (launch.stdout ?? "").split("\n")) {
    const row = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    const at = row ? new Date(row[2]).valueOf() : NaN;
    if (row && Number.isFinite(at)) launchedAt.set(Number(row[1]), at);
  }
  const windowStart = Date.now() - logWindowMs;
  const livePids = new Set(candidates.map((item) => item.pid));
  const openMainFrameProxies: OpenProxy[] = [...open].slice(0, 16).map(([pageProxyId, item]) => ({ pageProxyId, pid: item.pid, committedAt: item.committedAt, liveChild: livePids.has(item.pid), serviceWorkerPid: workers.has(item.pid) }));
  const lifecycle: CandidateLifecycle[] = candidates.map((item) => {
    const at = launchedAt.get(item.pid);
    return { pid: item.pid, birthAbstime: item.birthAbstime, launchedAt: at === undefined ? null : new Date(at).toISOString(), launchedBeforeLogWindow: at === undefined ? null : at < windowStart, openMainFrameProxyIds: [...open].filter(([, proxy]) => proxy.pid === item.pid).map(([id]) => id).slice(0, 8) };
  });
  const evidence = { lifecycleLines, openMainFrameProxies, candidates: lifecycle };
  if (query.outcome.outcome !== "ok") return finish("page_lifecycle_unavailable", "log_query_failed", evidence);

  const active = [...new Set([...open.values()].map((item) => item.pid))];
  const matches = candidates.filter((item) => active.includes(item.pid) && !workers.has(item.pid));
  if (matches.length !== 1 || active.length !== 1) {
    const reason = active.length === 0 ? "no_open_main_frame_proxy" : active.length > 1 ? "multiple_open_main_frame_proxies" : "open_proxy_not_unique_live_child";
    return finish("page_lifecycle_missing_or_ambiguous", reason, evidence);
  }
  const launched = launchedAt.get(matches[0].pid);
  if (launched === undefined) return finish("page_lifecycle_unavailable", "renderer_launch_unknown", evidence);
  if (Date.now() - launched > logWindowMs) return finish("renderer_older_than_log_window", "renderer_older_than_log_window", evidence);
  return finish("unique_webkit_page_proxy", "unique", evidence, { pid: matches[0].pid, birthAbstime: matches[0].birthAbstime, evidence: `Web App ${shell.pid} main-frame commit with no close; unique live child` });
}

async function writeEvent(event: VoiceEvent) {
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, "voice-process-events.json");
  let previous: VoiceEvent[] = [];
  try { previous = JSON.parse(await readFile(path, "utf8")) as VoiceEvent[]; }
  catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  const cutoff = Date.now() - eventRetentionMs;
  const retained = [...previous, event]
    .filter((item) => Date.parse(item.beganAt) >= cutoff)
    .map((item) => ({ ...item, samples: item.samples.slice(-100) }));
  await writeFile(`${path}.tmp`, JSON.stringify(retained), { mode: 0o600 });
  const { rename } = await import("node:fs/promises");
  await rename(`${path}.tmp`, path);
}

function persist(event: VoiceEvent) {
  // A shared temp path and read-modify-write file require one writer, including overlapping finishes.
  pendingWrites++;
  persistQueue = persistQueue.then(() => writeEvent(event)).then(() => {
    lastPersistError = null;
  }).catch((error) => {
    lastPersistError = error instanceof Error ? error.message.slice(0, 100) : "unknown";
  }).finally(() => {
    pendingWrites--;
  });
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const current = await sample();
    last = current;
    pre.push(current);
    if (pre.length > 20) pre.shift();
    const now = Date.now();
    for (const [id, event] of events) {
      event.samples.push(current);
      if (event.samples.length > 100) event.samples.shift();
      if (now < (event.afterUntil ?? event.deadline)) continue;
      events.delete(id);
      if (now >= event.deadline) event.cutoffAt = new Date().toISOString();
      persist(event);
    }
    if (!events.size && eventTimer) { clearInterval(eventTimer); eventTimer = undefined; }
  } finally { busy = false; }
}

export const macVoiceObserver = {
  start() {
    if (process.platform !== "darwin" || timer) return;
    timer = setInterval(() => { void tick(); }, 15_000);
    timer.unref?.();
    void tick();
  },
  async stop() { if (timer) clearInterval(timer); if (eventTimer) clearInterval(eventTimer); timer = undefined; eventTimer = undefined; await persistQueue; },
  begin(id: string, mode: unknown, pageSessionId: unknown) {
    if (events.has(id)) return;
    if (events.size >= 4) return;
    const event: VoiceEvent = {
      id, mode: mode === "dictation" || mode === "canvas_voice" || mode === "think_aloud" ? mode : "unknown",
      pageSessionId: typeof pageSessionId === "string" && /^[\w.:-]{1,128}$/.test(pageSessionId) ? pageSessionId : null,
      beganAt: new Date().toISOString(), page: null, attribution: "pending", samples: pre.slice(), deadline: Date.now() + 120_000,
    };
    events.set(id, event);
    if (!eventTimer) { eventTimer = setInterval(() => { void tick(); }, 2_000); eventTimer.unref?.(); }
    void (async () => {
      const current = await sample();
      event.samples.push(current);
      const answer = await attribute(current.shell, current.children);
      event.page = answer.page;
      event.attribution = answer.attribution;
      event.attributionDiagnostics = answer.diagnostics;
    })().catch((error) => {
      event.attribution = "observer_error";
      event.attributionDiagnostics = { version: 1, elapsedMs: 0, logWindowMs, stages: [], reason: "observer_error", errorName: error instanceof Error ? error.name.slice(0, 40) : "unknown" };
    });
  },
  end(id: string) { const event = events.get(id); if (event) { event.endedAt = new Date().toISOString(); event.afterUntil = Math.min(Date.now() + 30_000, event.deadline); } },
  status() { return { activeEvents: events.size, pendingWrites, ringSamples: pre.length, lastSampleAt: last?.at ?? null, lastSampleElapsedMs: last?.elapsedMs ?? null, lastPageAttribution: [...events.values()].at(-1)?.attribution ?? null, lastAttributionReason: [...events.values()].at(-1)?.attributionDiagnostics?.reason ?? null, lastPersistError }; },
};
