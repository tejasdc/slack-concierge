import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { log } from "./log";

// The one warm speech engine, a resident child process chosen by platform. Both engines speak
// the same one-request-per-line protocol, so everything above this file is one code path.
//
// Linux (the box): Parakeet TDT 0.6B v3 (`bot/native/parakeet-server.cpp`). Loading the model is
// ~370 ms of a ~620 ms one-second dictation, and starting the program most of the rest; warm, the
// same clip takes ~105 ms, for ~1 GB resident and no idle CPU (the child blocks on stdin),
// measured September 20, 2026. On Tejas's own recordings it fixed base.en errors that changed his
// meaning (a reversed negation, a lost question) at close to base.en's speed. Installed by
// `bot/scripts/install-transcriber.sh`. It loads on the first dictation and is released after ten
// idle minutes (Tejas, September 21, 2026): the iPhone and the Mac now transcribe on the device,
// so the box's engine is a fallback that should not hold a gigabyte around the clock. A dictation
// arriving after a quiet spell pays the ~0.5 s load once.
//
// macOS 26+ (a Mac): Apple's on-device SpeechTranscriber (`bot/native/apple-speech-server.swift`),
// Tejas's choice on September 20, 2026. The model lives in the operating system; the helper holds
// ~21 MB and blocks on stdin, so it too stays resident rather than loading on demand: starting it
// costs ~1.2 s (locale and asset checks), a warm request ~0.1-0.4 s, and a four-minute recording
// took 4 s, measured September 21, 2026 on this Mac. Built by `scripts/install-mac.sh`.
//
// The design is in Thinkering's `docs/plans/2026-09-20-native-voice-capture-transcription.md`.
type EngineName = "parakeet" | "apple";
// idleMs: how long an unused engine stays loaded; null keeps it resident for Concierge's lifetime.
type EngineSpec = { name: EngineName; server: string; files: string[]; args: string[]; idleMs: number | null };
const IDLE_MS = Math.max(60_000, Number(process.env.CONCIERGE_TRANSCRIBER_IDLE_MS) || 10 * 60_000);
const THREADS = String(Math.max(1, Math.min(8, Number(process.env.CONCIERGE_TRANSCRIBER_THREADS ?? process.env.CONCIERGE_WHISPER_THREADS) || 8)));
function platformEngine(): EngineSpec {
  if (process.platform === "darwin") {
    const state = process.env.CONCIERGE_STATE_DIR || `${homedir()}/Library/Application Support/concierge`;
    const server = process.env.CONCIERGE_APPLE_SPEECH_SERVER || `${state}/speech/apple-speech-server`;
    return { name: "apple", server, files: [server], args: [process.env.CONCIERGE_SPEECH_LOCALE || "en-US"], idleMs: null };
  }
  const root = "/root/.local/share/concierge/speech";
  const server = process.env.CONCIERGE_PARAKEET_SERVER || `${root}/parakeet-server`;
  const model = process.env.CONCIERGE_PARAKEET_MODEL || `${root}/models/ggml-parakeet-tdt-0.6b-v3-q8_0.bin`;
  return { name: "parakeet", server, files: [server, model], args: ["-m", model, "-t", THREADS], idleMs: IDLE_MS };
}

export type EngineResult = { text: string; audioMs: number; chunks: number; computeMs: number; warm: boolean };
type Pending = { resolve: (value: EngineResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; warm: boolean };

export class EngineUnavailable extends Error {}

class ResidentEngine {
  constructor(private readonly spec: EngineSpec) {}
  get name(): EngineName { return this.spec.name; }
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private buffer = "";
  private sequence = 0;
  private idle: ReturnType<typeof setTimeout> | null = null;

  get loadsOnDemand(): boolean { return this.spec.idleMs !== null; }

  installed(): boolean {
    return this.spec.files.every((file) => existsSync(file));
  }

  /** Starts the engine if it is not running; resolves once the model is loaded. */
  warm(): Promise<void> {
    if (this.ready) return this.ready;
    if (!this.installed()) return Promise.reject(new EngineUnavailable(`${this.spec.name}_not_installed`));
    const started = Date.now();
    // Raised priority keeps a waiting person ahead of builds and batch agents; nice only warns
    // without the privilege, so this can only help.
    const child = spawn("nice", ["-n", "-10", this.spec.server, ...this.spec.args], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (this.child !== child) return;
        this.buffer += chunk;
        let newline;
        while ((newline = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, newline);
          this.buffer = this.buffer.slice(newline + 1);
          let message: Record<string, unknown>;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.ready === true) {
            settled = true;
            log("info", "transcriber_ready", { engine: this.spec.name, load_ms: Number(message.loadMs) || null, startup_ms: Date.now() - started });
            resolve();
          } else this.settle(message);
        }
      });
      // The engine logs only its own errors; they are not user content, but they stay out of
      // the journal anyway and the exit status is what diagnosis needs.
      child.stderr.resume();
      // A write racing the child's death must not become an unhandled stream error in the
      // bot; the exit handler already fails whatever was waiting.
      child.stdin.on("error", () => {});
      child.on("error", (error) => {
        if (!settled) { settled = true; reject(error); }
        if (this.child === child) this.reset("spawn_failed");
      });
      child.on("exit", (code, signal) => {
        if (!settled) { settled = true; reject(new EngineUnavailable(`${this.spec.name}_exited_${code ?? signal}`)); }
        // A released engine shutting down is not a failure, and a newer one may already be running.
        if (this.child !== child) return;
        log("warn", "transcriber_exited", { engine: this.spec.name, code, signal, pending: this.pending.size });
        this.reset("exited");
      });
    });
    return this.ready;
  }

  async transcribe(pcmPath: string, audioMs: number): Promise<EngineResult> {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    const warm = this.ready !== null;
    await this.warm();
    const child = this.child;
    if (!child) throw new EngineUnavailable(`${this.spec.name}_not_running`);
    const id = `r${++this.sequence}`;
    return new Promise<EngineResult>((resolve, reject) => {
      // Parakeet runs at roughly ten times real time on the box and Apple's engine far faster
      // on a Mac; anything slower than this is a wedged engine, killed so the next request
      // gets a fresh one.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        log("warn", "transcriber_timeout", { engine: this.spec.name, audio_ms: audioMs });
        child.kill("SIGKILL");
        reject(new EngineUnavailable(`${this.spec.name}_timeout`));
      }, 60_000 + audioMs);
      this.pending.set(id, { resolve, reject, timer, warm });
      child.stdin.write(`${id}\t${pcmPath}\n`);
    });
  }

  private settle(message: Record<string, unknown>) {
    const id = typeof message.id === "string" ? message.id : "";
    const waiting = this.pending.get(id);
    if (!waiting) return;
    this.pending.delete(id);
    clearTimeout(waiting.timer);
    if (typeof message.error === "string") waiting.reject(new Error(`${this.spec.name}_${message.error.toLowerCase()}`));
    else waiting.resolve({
      text: typeof message.text === "string" ? message.text : "",
      audioMs: Number(message.audioMs) || 0,
      chunks: Number(message.chunks) || 0,
      computeMs: Number(message.computeMs) || 0,
      warm: waiting.warm,
    });
    this.scheduleRelease();
  }

  private scheduleRelease() {
    if (this.spec.idleMs === null || this.pending.size > 0 || !this.child) return;
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.release(), this.spec.idleMs);
    this.idle.unref?.();
  }

  private release() {
    this.idle = null;
    const child = this.child;
    if (!child || this.pending.size > 0) return;
    // Detach before closing, so a dictation arriving now starts a fresh engine instead of writing
    // to one that is shutting down (which would push it onto the Whisper fallback).
    this.child = null;
    this.ready = null;
    this.buffer = "";
    log("info", "transcriber_released", { engine: this.spec.name, idle_ms: this.spec.idleMs });
    child.stdin.end();
  }

  private reset(reason: string) {
    for (const [, waiting] of this.pending) { clearTimeout(waiting.timer); waiting.reject(new EngineUnavailable(`${this.spec.name}_${reason}`)); }
    this.pending.clear();
    this.child = null;
    this.ready = null;
    this.buffer = "";
  }
}

export const speechEngine = new ResidentEngine(platformEngine());

/**
 * Loads a resident engine at startup so the first dictation after a restart is already warm. An
 * engine that loads on demand (Parakeet on the box) starts with its first dictation instead.
 */
export function warmSpeechEngine(): void {
  if (!speechEngine.installed()) {
    log("warn", "transcriber_fallback", { engine: "whisper.cpp", reason: `${speechEngine.name}_not_installed` });
    return;
  }
  if (speechEngine.loadsOnDemand) {
    log("info", "transcriber_on_demand", { engine: speechEngine.name, idle_ms: IDLE_MS });
    return;
  }
  speechEngine.warm().catch((error: unknown) => log("warn", "transcriber_warm_failed", { engine: speechEngine.name, reason: error instanceof Error ? error.message : "unknown" }));
}
