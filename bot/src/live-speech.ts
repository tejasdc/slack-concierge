import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "./log";
import { speechEngine } from "./speech-engine";
import { transcribeForPeer } from "./transcription";

/**
 * Words while he talks, for Thinkering in a browser on this Mac. The page sends each two-second
 * piece of its recording here as it is saved, on this Mac's loopback address, and gets the words
 * back the moment he stops. The recording never leaves the Mac to become words.
 *
 * This is the same contract the iPhone app gives the page (`window.thnk.native.speech`: begin,
 * append, finish, cancel, transcribe), so Thinkering treats a Mac with Concierge like a phone with
 * the app. Custody is unchanged: the page still uploads the recording to the owner that holds it,
 * and files these words beside it as a device transcript. Any failure here makes the page fall
 * back to server transcription, so this can only make dictation faster, never lose it.
 *
 * The page is https://thnkr.ing and this is http on 127.0.0.1. Chrome 153 on Tejas's Mac allows
 * that once the site holds Chrome's local-network permission (one prompt), and refuses it
 * without; checked September 21, 2026. Only the configured origins are answered.
 */
const ORIGINS = new Set((process.env.CONCIERGE_SPEECH_ORIGINS || "https://thnkr.ing").split(",").map((origin) => origin.trim()).filter(Boolean));
const IDLE_MS = 10 * 60_000;
const ENGINE = "apple.SpeechTranscriber";
const ENGINE_VERSION = `darwin ${release()}`;

type Recording = { stream: string; started: Promise<void>; decoder: ChildProcessWithoutNullStreams; decoded: Promise<number>; remainder: Buffer; frames: number; touchedAt: number; startedAt: number };
const recordings = new Map<string, Recording>();

class SpeechRefusal extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

// The page's recorder produces WebM/Opus (Chrome) or fragmented MP4 (Safari); ffmpeg decodes
// either as it arrives and hands 16 kHz samples to the engine, which transcribes as they come.
// Registered before the engine answers, so a piece that arrives while it starts waits for it.
async function begin(id: string) {
  const existing = recordings.get(id);
  if (existing) return existing.started;
  const stream = `live-${randomUUID()}`;
  const started = speechEngine.beginStream(stream);
  const decoder = spawn("ffmpeg", ["-loglevel", "error", "-i", "pipe:0", "-ar", "16000", "-ac", "1", "-f", "f32le", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
  const recording: Recording = { stream, started, decoder, decoded: Promise.resolve(0), remainder: Buffer.alloc(0), frames: 0, touchedAt: Date.now(), startedAt: Date.now() };
  decoder.stdout.on("data", (chunk: Buffer) => {
    // The engine takes whole samples; a piece that ends mid-sample carries the rest forward.
    const bytes = Buffer.concat([recording.remainder, chunk]);
    const whole = bytes.length - (bytes.length % 4);
    recording.remainder = bytes.subarray(whole);
    if (!whole) return;
    recording.frames += whole / 4;
    try { speechEngine.appendStream(stream, bytes.subarray(0, whole)); } catch { /* finishing reports the lost stream */ }
  });
  decoder.stderr.resume();
  decoder.stdin.on("error", () => {});
  recording.decoded = new Promise((resolve) => { decoder.on("close", (code) => resolve(code ?? 1)); decoder.on("error", () => resolve(1)); });
  recordings.set(id, recording);
  try { await started; } catch (error) { cancel(id); throw error; }
}

async function append(id: string, audio: Buffer) {
  const recording = recordings.get(id);
  if (!recording) throw new SpeechRefusal("SPEECH_UNKNOWN_RECORDING", 404);
  recording.touchedAt = Date.now();
  await recording.started;
  recording.decoder.stdin.write(audio);
}

async function finish(id: string) {
  const recording = recordings.get(id);
  if (!recording) throw new SpeechRefusal("SPEECH_UNKNOWN_RECORDING", 404);
  recordings.delete(id);
  const stopped = Date.now();
  await recording.started.catch(() => { throw new SpeechRefusal("SPEECH_UNKNOWN_RECORDING", 404); });
  recording.decoder.stdin.end();
  // An undecodable live recording is answered as unknown, so the page hands over the whole file.
  if (await recording.decoded !== 0) { speechEngine.cancelStream(recording.stream); throw new SpeechRefusal("SPEECH_UNKNOWN_RECORDING", 404); }
  const result = await speechEngine.finishStream(recording.stream).catch((error: unknown) => {
    log("warn", "live_transcription_failed", { engine: speechEngine.name, reason: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
    throw new SpeechRefusal("SPEECH_UNKNOWN_RECORDING", 404);
  });
  const text = result.text.trim();
  const durationMs = Math.round(recording.frames / 16);
  log("info", "live_audio_transcribed", { engine: speechEngine.name, audio_ms: durationMs, pieces: result.chunks, after_stop_ms: Date.now() - stopped, engine_finish_ms: result.computeMs, text_chars: text.length });
  return { text, engine: ENGINE, engineVersion: ENGINE_VERSION, durationMs };
}

function cancel(id: string) {
  const recording = recordings.get(id);
  if (!recording) return;
  recordings.delete(id);
  recording.decoder.kill("SIGKILL");
  speechEngine.cancelStream(recording.stream);
}

// A retry, or a recording the page did not follow live, arrives whole and takes the ordinary path.
async function transcribeWhole(audio: Buffer, type: string) {
  const directory = await mkdtemp(join(tmpdir(), "concierge-live-voice-"));
  try {
    const path = join(directory, `recording.${type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm"}`);
    await writeFile(path, audio, { mode: 0o600 });
    const result = await transcribeForPeer({ id: `local-${randomUUID()}`, path });
    return { text: result.text, engine: ENGINE, engineVersion: ENGINE_VERSION, durationMs: result.audioMs ?? 0 };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const recordingId = (value: string | undefined) => {
  if (!value || !/^[\w.:-]{1,128}$/.test(value)) throw new SpeechRefusal("SPEECH_BAD_REQUEST", 400);
  return value;
};

async function handle(request: Request): Promise<Response> {
  const origin = request.headers.get("origin") ?? "";
  if (!ORIGINS.has(origin)) return new Response(null, { status: 403 });
  const cors = { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-allow-private-network": "true", "access-control-max-age": "600", vary: "origin" };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  try {
    if (parts[0] !== "speech" || parts[1] !== "v1") throw new SpeechRefusal("SPEECH_NOT_FOUND", 404);
    let result: unknown;
    if (request.method === "GET" && parts[2] === "status" && parts.length === 3) {
      if (!speechEngine.installed()) throw new SpeechRefusal("SPEECH_UNAVAILABLE", 503);
      result = { version: 1, engine: ENGINE, engineVersion: ENGINE_VERSION };
    } else if (request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { audio?: unknown; type?: unknown };
      const audio = () => { if (typeof body.audio !== "string" || !body.audio) throw new SpeechRefusal("SPEECH_BAD_REQUEST", 400); return Buffer.from(body.audio, "base64"); };
      if (parts[2] === "transcriptions" && parts.length === 3) result = await transcribeWhole(audio(), typeof body.type === "string" ? body.type : "");
      else if (parts[2] === "recordings" && parts.length === 5) {
        const id = recordingId(parts[3]);
        if (parts[4] === "begin") { await begin(id); result = { ok: true }; }
        else if (parts[4] === "append") { await append(id, audio()); result = { ok: true }; }
        else if (parts[4] === "finish") result = await finish(id);
        else if (parts[4] === "cancel") { cancel(id); result = { ok: true }; }
        else throw new SpeechRefusal("SPEECH_NOT_FOUND", 404);
      } else throw new SpeechRefusal("SPEECH_NOT_FOUND", 404);
    } else throw new SpeechRefusal("SPEECH_NOT_FOUND", 404);
    return Response.json(result, { headers: cors });
  } catch (error) {
    const refusal = error instanceof SpeechRefusal ? error : new SpeechRefusal("SPEECH_FAILED", 500);
    return Response.json({ error: refusal.code }, { status: refusal.status, headers: cors });
  }
}

/** Starts the loopback listener on a Mac with Apple's engine; elsewhere there is nothing to serve. */
export function startLiveSpeechListener() {
  const listen = process.env.CONCIERGE_SPEECH_LISTEN ?? (process.platform === "darwin" ? "127.0.0.1:8790" : "");
  if (!listen || speechEngine.name !== "apple") return null;
  const match = listen.match(/^(127\.0\.0\.1|localhost):(\d{2,5})$/);
  if (!match) throw new Error("CONCIERGE_SPEECH_LISTEN must be a loopback host:port; the page on this Mac is its only caller.");
  const server = Bun.serve({ hostname: match[1], port: Number(match[2]), idleTimeout: 60, maxRequestBodySize: 64 * 1024 * 1024, fetch: handle });
  // A page closed mid-recording never finishes; its stream is dropped rather than held forever.
  const sweep = setInterval(() => { for (const [id, recording] of recordings) if (Date.now() - recording.touchedAt > IDLE_MS) cancel(id); }, 60_000);
  sweep.unref?.();
  log("info", "live_speech_listener_online", { hostname: match[1], port: Number(match[2]), origins: [...ORIGINS] });
  return { stop: async () => { clearInterval(sweep); for (const id of [...recordings.keys()]) cancel(id); await server.stop(true); } };
}
