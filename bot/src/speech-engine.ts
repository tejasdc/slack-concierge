import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { log } from "./log";

// The one warm speech engine: Parakeet TDT 0.6B v3, loaded once by a resident child process
// (`bot/native/parakeet-server.cpp`) and kept for Concierge's lifetime.
//
// Why resident: loading the model is ~370 ms of a ~620 ms one-second dictation, and starting
// the program most of the rest. Warm, the same clip takes ~105 ms. The price is ~1 GB of
// resident memory and no idle CPU (the child blocks on stdin), measured September 20, 2026.
// Why Parakeet: on Tejas's own recordings it fixed base.en errors that changed his meaning
// (a reversed negation, a lost question) at close to base.en's speed.
//
// Installed by `bot/scripts/install-transcriber.sh`; the design is in Thinkering's
// `docs/plans/2026-09-20-native-voice-capture-transcription.md`.
const SPEECH_ROOT = "/root/.local/share/concierge/speech";
const SERVER = process.env.CONCIERGE_PARAKEET_SERVER || `${SPEECH_ROOT}/parakeet-server`;
const MODEL = process.env.CONCIERGE_PARAKEET_MODEL || `${SPEECH_ROOT}/models/ggml-parakeet-tdt-0.6b-v3-q8_0.bin`;
const THREADS = String(Math.max(1, Math.min(8, Number(process.env.CONCIERGE_TRANSCRIBER_THREADS ?? process.env.CONCIERGE_WHISPER_THREADS) || 8)));

export type EngineResult = { text: string; audioMs: number; chunks: number; computeMs: number; warm: boolean };
type Pending = { resolve: (value: EngineResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; warm: boolean };

export class EngineUnavailable extends Error {}

class ResidentParakeet {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private buffer = "";
  private sequence = 0;

  installed(): boolean {
    return existsSync(SERVER) && existsSync(MODEL);
  }

  /** Starts the engine if it is not running; resolves once the model is loaded. */
  warm(): Promise<void> {
    if (this.ready) return this.ready;
    if (!this.installed()) return Promise.reject(new EngineUnavailable("parakeet_not_installed"));
    const started = Date.now();
    // Raised priority keeps a waiting person ahead of builds and batch agents; nice only warns
    // without the privilege, so this can only help.
    const child = spawn("nice", ["-n", "-10", SERVER, "-m", MODEL, "-t", THREADS], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        this.buffer += chunk;
        let newline;
        while ((newline = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, newline);
          this.buffer = this.buffer.slice(newline + 1);
          let message: Record<string, unknown>;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.ready === true) {
            settled = true;
            log("info", "transcriber_ready", { engine: "parakeet", load_ms: Number(message.loadMs) || null, startup_ms: Date.now() - started });
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
      child.on("error", (error) => { if (!settled) { settled = true; reject(error); } this.reset("spawn_failed"); });
      child.on("exit", (code, signal) => {
        if (!settled) { settled = true; reject(new EngineUnavailable(`parakeet_exited_${code ?? signal}`)); }
        log("warn", "transcriber_exited", { engine: "parakeet", code, signal, pending: this.pending.size });
        this.reset("exited");
      });
    });
    return this.ready;
  }

  async transcribe(pcmPath: string, audioMs: number): Promise<EngineResult> {
    const warm = this.ready !== null;
    await this.warm();
    const child = this.child;
    if (!child) throw new EngineUnavailable("parakeet_not_running");
    const id = `r${++this.sequence}`;
    return new Promise<EngineResult>((resolve, reject) => {
      // Parakeet runs at roughly ten times real time on this host; anything far slower is a
      // wedged engine, which is killed so the next request gets a fresh one.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        log("warn", "transcriber_timeout", { engine: "parakeet", audio_ms: audioMs });
        child.kill("SIGKILL");
        reject(new EngineUnavailable("parakeet_timeout"));
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
    if (typeof message.error === "string") waiting.reject(new Error(`parakeet_${message.error.toLowerCase()}`));
    else waiting.resolve({
      text: typeof message.text === "string" ? message.text : "",
      audioMs: Number(message.audioMs) || 0,
      chunks: Number(message.chunks) || 0,
      computeMs: Number(message.computeMs) || 0,
      warm: waiting.warm,
    });
  }

  private reset(reason: string) {
    for (const [, waiting] of this.pending) { clearTimeout(waiting.timer); waiting.reject(new EngineUnavailable(`parakeet_${reason}`)); }
    this.pending.clear();
    this.child = null;
    this.ready = null;
    this.buffer = "";
  }
}

export const speechEngine = new ResidentParakeet();

/** Loads the model at startup so the first dictation after a restart is already warm. */
export function warmSpeechEngine(): void {
  if (!speechEngine.installed()) {
    log("warn", "transcriber_fallback", { engine: "whisper.cpp", reason: "parakeet_not_installed" });
    return;
  }
  speechEngine.warm().catch((error: unknown) => log("warn", "transcriber_warm_failed", { engine: "parakeet", reason: error instanceof Error ? error.message : "unknown" }));
}
