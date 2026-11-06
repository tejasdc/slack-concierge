import { execFile } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";

const exec = promisify(execFile);
const stateDir = join(process.env.CONCIERGE_STATE_DIR || "", "speech");
const native = join(stateDir, "process-footprint");
const webAppBundle = "com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792";
const webContentPath = "/com.apple.WebKit.WebContent.xpc/";
const pre: Sample[] = [];
const events = new Map<string, VoiceEvent>();
let timer: ReturnType<typeof setInterval> | undefined;
let eventTimer: ReturnType<typeof setInterval> | undefined;
let busy = false;
let last: Sample | undefined;

type ProcessReading = { pid: number; birthAbstime: number; userNs: number; systemNs: number; physicalBytes: number; path: string };
type Sample = { at: string; elapsedMs: number; helper: ProcessReading | null; engine: ProcessReading | null; launcher: ProcessReading | null; shell: ProcessReading | null; children: ProcessReading[]; error?: string };
type VoiceEvent = { id: string; mode: "dictation" | "canvas_voice" | "think_aloud" | "unknown"; pageSessionId: string | null; beganAt: string; endedAt?: string; page: { pid: number; birthAbstime: number; evidence: string } | null; attribution: string; samples: Sample[]; deadline: number; afterUntil?: number };

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
async function attribute(shell: ProcessReading | null, candidates: ProcessReading[]) {
  if (!shell || !candidates.length) return { page: null, attribution: "no_live_web_app_page" };
  try {
    const lines = (await command("/usr/bin/log", ["show", "--last", "30m", "--info", "--style", "compact", "--predicate", `processID == ${shell.pid} AND (eventMessage CONTAINS "WebPageProxy::didCommitLoadForFrame" OR eventMessage CONTAINS "WebPageProxy::close" OR eventMessage CONTAINS "service worker process without page")`], 3000)).split("\n");
    const open = new Map<string, number>();
    const workers = new Set<number>();
    for (const line of lines) {
      const worker = line.match(/\[PID=(\d+)\].*service worker process without page/);
      if (worker) workers.add(Number(worker[1]));
      const match = line.match(/\[pageProxyID=(\d+), webPageID=\d+, PID=(\d+)\] WebPageProxy::(didCommitLoadForFrame|close):?/);
      if (!match) continue;
      if (match[3] === "close") open.delete(match[1]);
      else if (line.includes("isMainFrame=1")) open.set(match[1], Number(match[2]));
    }
    const active = [...new Set(open.values())];
    const matches = candidates.filter((item) => active.includes(item.pid) && !workers.has(item.pid));
    if (matches.length !== 1 || active.length !== 1) return { page: null, attribution: "page_lifecycle_missing_or_ambiguous" };
    const launched = new Date((await command("/bin/ps", ["-p", String(matches[0].pid), "-o", "lstart="], 700)).trim());
    if (!Number.isFinite(launched.valueOf()) || Date.now() - launched.valueOf() > 30 * 60_000) return { page: null, attribution: "renderer_older_than_log_window" };
    return { page: { pid: matches[0].pid, birthAbstime: matches[0].birthAbstime, evidence: `Web App ${shell.pid} main-frame commit with no close; unique live child` }, attribution: "unique_webkit_page_proxy" };
  } catch { return { page: null, attribution: "page_lifecycle_unavailable" }; }
}

async function persist(event: VoiceEvent) {
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, "voice-process-events.json");
  let previous: VoiceEvent[] = [];
  try { previous = JSON.parse(await readFile(path, "utf8")) as VoiceEvent[]; } catch { /* no prior evidence */ }
  const retained = [...previous.slice(-3), event].map((item) => ({ ...item, samples: item.samples.slice(-100) }));
  await writeFile(`${path}.tmp`, JSON.stringify(retained), { mode: 0o600 });
  const { rename } = await import("node:fs/promises");
  await rename(`${path}.tmp`, path);
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
      event.endedAt ??= new Date().toISOString();
      void persist(event).catch(() => {});
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
  stop() { if (timer) clearInterval(timer); if (eventTimer) clearInterval(eventTimer); timer = undefined; eventTimer = undefined; },
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
    })().catch(() => { event.attribution = "observer_error"; });
  },
  end(id: string) { const event = events.get(id); if (event) event.afterUntil = Math.min(Date.now() + 30_000, event.deadline); },
  status() { return { activeEvents: events.size, ringSamples: pre.length, lastSampleAt: last?.at ?? null, lastSampleElapsedMs: last?.elapsedMs ?? null, lastPageAttribution: [...events.values()].at(-1)?.attribution ?? null }; },
};
