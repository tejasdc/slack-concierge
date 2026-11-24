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
type CaptureTransition = { pageProxyId: number; pid: number; from: number; to: number; at: string | null };
type CapturingPage = { pageProxyId: number; pid: number; state: number; startObserved: boolean; closedAfter: boolean; liveChild: boolean; serviceWorkerPid: boolean };
type CandidateProcess = { pid: number; birthAbstime: number; launchedAt: string | null };
// Version 1 (2026-11-16 morning) read 30 minutes of main-frame commit/close history; records
// written with it keep their own fields. Version 2 reads WebKit's per-recording capture state.
type AttributionDiagnostics = {
  version: 2; elapsedMs: number; logWindowMs: number; stages: StageOutcome[];
  reason: "no_live_web_app_page" | "log_query_failed" | "concurrent_listener_recording" | "no_capturing_page" | "multiple_capturing_pages" | "capture_start_not_observed" | "capturing_page_closed" | "capturing_page_not_live_child" | "unique" | "observer_error";
  lines?: { captureStates: number; closes: number; serviceWorkerLines: number };
  captureTransitions?: CaptureTransition[]; capturingPages?: CapturingPage[]; candidates?: CandidateProcess[];
  concurrentRecordings?: number; queriedAfterBeginMs?: number; errorName?: string;
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

// `log show` decodes every persisted entry in its time range before applying the predicate, so its
// cost follows the whole system's log volume (measured on the Mac 2026-11-16: about 0.8 s fixed,
// 1.9 s for 30 minutes, 3.4 s for two hours), and this chatty app's WebKit lines were retained for
// only about six hours. Page-load history for a long-lived renderer is therefore unrecoverable at
// any cost. WebKit instead reports each page's capture state when the page opens the microphone
// for a recording, so the two minutes before `begin` contain this recording's own evidence.
// The window is anchored to `begin`, so the read returns the same evidence whenever it runs; it
// runs once the recording has ended, so it never competes with the recording it attributes. Its
// time limit only bounds a stuck reader: a fixed 3 s limit at `begin` threw away evidence that a
// later read of the same window found (2026-11-24, events 894995bc and 8661c107, under memory
// pressure), because normal cost (0.9-2.9 s) sits right at it.
const logWindowMs = 2 * 60_000;
const stuckReaderLimitMs = 15_000;
const activeAudioCapture = 2048; // WebKit MediaProducerMediaState::HasActiveAudioCaptureDevice

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

// A page is named only when WebKit's own capture-state report leaves exactly one Web App page proxy
// capturing, that report shows it starting active microphone capture inside the window, the page
// was not closed afterwards, its renderer is a live child of the Web App, and the listener has no
// other recording that could own a different capturing page. Anything else stays unknown; a page
// is never chosen by size, renderer start time or nearness of timestamps. The one platform limit:
// a Web App page holding the microphone, outside any listener recording, since before the window.
const logTime = (ms: number) => `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")}+0000`;

async function attribute(shell: ProcessReading | null, candidates: ProcessReading[], concurrentRecordings: number, beganAt: string) {
  const start = performance.now();
  const stages: StageOutcome[] = [];
  const began = Date.parse(beganAt);
  const finish = (attribution: string, reason: AttributionDiagnostics["reason"], extra: Partial<AttributionDiagnostics> = {}, page: VoiceEvent["page"] = null) =>
    ({ page, attribution, diagnostics: { version: 2, elapsedMs: Math.round(performance.now() - start), logWindowMs, stages, reason, concurrentRecordings, ...extra } as AttributionDiagnostics });
  if (!shell || !candidates.length) return finish("no_live_web_app_page", "no_live_web_app_page");

  // `log show` accepts whole seconds; lines after `begin` are dropped below, so the state read is
  // the state at `begin` however late the read runs.
  const queriedAfterBeginMs = Date.now() - began;
  const query = await timedStage("log_query", "/usr/bin/log", ["show", "--start", logTime(Math.floor((began - logWindowMs) / 1000) * 1000), "--end", logTime(Math.ceil(began / 1000) * 1000), "--style", "compact", "--predicate", `processID == ${shell.pid} AND subsystem == "com.apple.WebKit" AND (eventMessage CONTAINS "WebPageProxy::updateReportedMediaCaptureState" OR eventMessage CONTAINS "WebPageProxy::close" OR eventMessage CONTAINS "service worker process without page")`], stuckReaderLimitMs);
  stages.push(query.outcome);
  const transitions: CaptureTransition[] = [];
  const closedAt = new Map<number, number>();
  const workers = new Set<number>();
  const lines = { captureStates: 0, closes: 0, serviceWorkerLines: 0 };
  if (query.outcome.outcome === "ok") {
    for (const line of (query.stdout ?? "").split("\n")) {
      const worker = line.match(/\[PID=(\d+)\].*service worker process without page/);
      if (worker) { workers.add(Number(worker[1])); lines.serviceWorkerLines++; }
      const at = localLogTime(line);
      if (at && Date.parse(at) > began) continue;
      const capture = line.match(/\[pageProxyID=(\d+), webPageID=\d+, PID=(\d+)\] WebPageProxy::updateReportedMediaCaptureState: from (\d+) to (\d+)/);
      if (capture) { lines.captureStates++; transitions.push({ pageProxyId: Number(capture[1]), pid: Number(capture[2]), from: Number(capture[3]), to: Number(capture[4]), at }); continue; }
      const close = line.match(/\[pageProxyID=(\d+), webPageID=\d+, PID=\d+\] WebPageProxy::close/);
      if (close) { lines.closes++; closedAt.set(Number(close[1]), transitions.length); }
    }
  }

  // One start-time read of every candidate, kept as context; it is not used to choose a page.
  const launch = await timedStage("renderer_launch", "/bin/ps", ["-p", candidates.map((item) => item.pid).join(","), "-o", "pid=,lstart="], 700);
  stages.push(launch.outcome);
  const launchedAt = new Map<number, string>();
  for (const line of (launch.stdout ?? "").split("\n")) {
    const row = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    const at = row ? new Date(row[2]) : null;
    if (row && at && Number.isFinite(at.valueOf())) launchedAt.set(Number(row[1]), at.toISOString());
  }
  const livePids = new Set(candidates.map((item) => item.pid));
  const latest = new Map<number, { pid: number; state: number; startObserved: boolean; index: number }>();
  transitions.forEach((item, index) => {
    const startObserved = (latest.get(item.pageProxyId)?.startObserved ?? false) || ((item.from & activeAudioCapture) === 0 && (item.to & activeAudioCapture) !== 0);
    latest.set(item.pageProxyId, { pid: item.pid, state: item.to, startObserved, index });
  });
  const capturingPages: CapturingPage[] = [...latest].filter(([, item]) => item.state !== 0).slice(0, 16).map(([pageProxyId, item]) => ({
    pageProxyId, pid: item.pid, state: item.state, startObserved: item.startObserved,
    closedAfter: (closedAt.get(pageProxyId) ?? -1) > item.index, liveChild: livePids.has(item.pid), serviceWorkerPid: workers.has(item.pid),
  }));
  const evidence: Partial<AttributionDiagnostics> = {
    lines, captureTransitions: transitions.slice(-16), capturingPages, queriedAfterBeginMs,
    candidates: candidates.map((item) => ({ pid: item.pid, birthAbstime: item.birthAbstime, launchedAt: launchedAt.get(item.pid) ?? null })),
  };
  if (query.outcome.outcome !== "ok") return finish("page_lifecycle_unavailable", "log_query_failed", evidence);
  if (concurrentRecordings > 0) return finish("page_lifecycle_missing_or_ambiguous", "concurrent_listener_recording", evidence);
  if (!capturingPages.length) return finish("page_lifecycle_missing_or_ambiguous", "no_capturing_page", evidence);
  if (capturingPages.length > 1) return finish("page_lifecycle_missing_or_ambiguous", "multiple_capturing_pages", evidence);
  const [page] = capturingPages;
  if (!page.startObserved || (page.state & activeAudioCapture) === 0) return finish("page_lifecycle_missing_or_ambiguous", "capture_start_not_observed", evidence);
  if (page.closedAfter) return finish("page_lifecycle_missing_or_ambiguous", "capturing_page_closed", evidence);
  const renderer = candidates.find((item) => item.pid === page.pid);
  if (!renderer || page.serviceWorkerPid) return finish("page_lifecycle_missing_or_ambiguous", "capturing_page_not_live_child", evidence);
  return finish("unique_webkit_capture_page", "unique", evidence, { pid: renderer.pid, birthAbstime: renderer.birthAbstime, evidence: `Web App ${shell.pid} page proxy ${page.pageProxyId} reported starting active microphone capture; only capturing page; live child; no other listener recording` });
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

// The process snapshot is taken at `begin`; the log read waits until the recording ends (or its
// observation limit), so the saved record always carries a settled attribution.
const attributionWork = new WeakMap<VoiceEvent, { snapshot: Promise<Sample>; concurrentRecordings: number; settled?: Promise<void> }>();

function settleAttribution(event: VoiceEvent) {
  const work = attributionWork.get(event);
  if (!work) return Promise.resolve();
  work.settled ??= work.snapshot
    .then((current) => attribute(current.shell, current.children, work.concurrentRecordings, event.beganAt))
    .then((answer) => {
      event.page = answer.page;
      event.attribution = answer.attribution;
      event.attributionDiagnostics = answer.diagnostics;
    })
    .catch((error) => {
      event.attribution = "observer_error";
      event.attributionDiagnostics = { version: 2, elapsedMs: 0, logWindowMs, stages: [], reason: "observer_error", concurrentRecordings: work.concurrentRecordings, errorName: error instanceof Error ? error.name.slice(0, 40) : "unknown" };
    });
  return work.settled;
}

function persist(event: VoiceEvent) {
  // A shared temp path and read-modify-write file require one writer, including overlapping finishes.
  pendingWrites++;
  const settled = settleAttribution(event);
  persistQueue = persistQueue.then(() => settled).then(() => writeEvent(event)).then(() => {
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
  // otherRecordings counts the listener's other active recordings at begin; a caller that cannot
  // say leaves page identity unprovable, because another recording may own another capturing page.
  begin(id: string, mode: unknown, pageSessionId: unknown, otherRecordings?: number) {
    const concurrentRecordings = Number.isSafeInteger(otherRecordings) && otherRecordings! >= 0 ? otherRecordings! : 1;
    if (events.has(id)) return;
    if (events.size >= 4) return;
    const event: VoiceEvent = {
      id, mode: mode === "dictation" || mode === "canvas_voice" || mode === "think_aloud" ? mode : "unknown",
      pageSessionId: typeof pageSessionId === "string" && /^[\w.:-]{1,128}$/.test(pageSessionId) ? pageSessionId : null,
      beganAt: new Date().toISOString(), page: null, attribution: "pending", samples: pre.slice(), deadline: Date.now() + 120_000,
    };
    events.set(id, event);
    if (!eventTimer) { eventTimer = setInterval(() => { void tick(); }, 2_000); eventTimer.unref?.(); }
    const snapshot = sample().then((current) => { event.samples.push(current); return current; });
    attributionWork.set(event, { snapshot, concurrentRecordings });
  },
  end(id: string) {
    const event = events.get(id);
    if (!event) return;
    event.endedAt = new Date().toISOString();
    event.afterUntil = Math.min(Date.now() + 30_000, event.deadline);
    void settleAttribution(event);
  },
  status() { return { activeEvents: events.size, pendingWrites, ringSamples: pre.length, lastSampleAt: last?.at ?? null, lastSampleElapsedMs: last?.elapsedMs ?? null, lastPageAttribution: [...events.values()].at(-1)?.attribution ?? null, lastAttributionReason: [...events.values()].at(-1)?.attributionDiagnostics?.reason ?? null, lastPersistError }; },
};
