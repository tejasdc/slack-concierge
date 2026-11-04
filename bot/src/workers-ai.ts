import { existsSync, readFileSync } from "node:fs";

/**
 * Concierge's speech-to-text and embedding models on Cloudflare Workers AI, reached through the
 * concierge-workers-ai Worker (cloudflare/workers-ai). Moving them there takes Parakeet's and
 * EmbeddingGemma's processor time off the agent server (step 4 of
 * remote-box docs/plans/2026-11-04-off-one-server-architecture.md); the comparison on his own recordings and
 * routing requests that justified the switch is in docs/architecture/WORKERS-AI.md.
 *
 * Configured when the shared key file exists. Each machine opts in by holding the key; a Mac
 * without it keeps its on-device engines.
 */
const KEY_FILE = process.env.CONCIERGE_WORKERS_AI_KEY_FILE || "/etc/concierge/workers-ai.token";
const BASE_URL = (process.env.CONCIERGE_WORKERS_AI_URL || "https://concierge-workers-ai.thnkring.workers.dev").replace(/\/$/, "");
export const WORKERS_AI_EMBEDDING_MODEL = "@cf/google/embeddinggemma-300m";
export const WORKERS_AI_SPEECH_MODEL = "@cf/openai/whisper-large-v3-turbo";

let cachedKey: string | null | undefined;
function key(): string | null {
  if (cachedKey !== undefined) return cachedKey;
  cachedKey = existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() || null : null;
  return cachedKey;
}
export function workersAiConfigured(): boolean {
  return key() !== null;
}
/**
 * Embeddings move only once this file exists. Rebuilding the session index re-embeds about 100,000
 * passages, several times the free plan's 10,000-neuron daily allowance, which speech shares; on the
 * free plan the rebuild would leave recordings to fall back to the server engine every day. Created
 * once the Cloudflare account is on Workers Paid (docs/architecture/WORKERS-AI.md).
 */
const EMBEDDINGS_SWITCH = process.env.CONCIERGE_WORKERS_AI_EMBEDDINGS_FILE || "/etc/concierge/workers-ai-embeddings.enabled";
export function workersAiEmbeddingsEnabled(): boolean {
  return workersAiConfigured() && existsSync(EMBEDDINGS_SWITCH);
}
/**
 * Building and serving are separate steps. An empty switch file builds the Workers AI index beside the
 * local one; writing `serve` into it, after the full-index routing comparison passes, lets the built
 * index take over searches (read about once a minute, so no restart is needed).
 */
export function workersAiEmbeddingsServe(): boolean {
  if (!workersAiEmbeddingsEnabled()) return false;
  try { return readFileSync(EMBEDDINGS_SWITCH, "utf8").trim() === "serve"; } catch { return false; }
}

export class WorkersAiError extends Error {}

async function call(path: string, body: BodyInit, contentType: string, timeoutMs: number): Promise<any> {
  const secret = key();
  if (!secret) throw new WorkersAiError("Workers AI key is not installed on this machine");
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": contentType },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new WorkersAiError(`Workers AI unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch {}
  if (!response.ok) throw new WorkersAiError(`Workers AI answered ${response.status}: ${String(parsed?.error ?? text).slice(0, 300)}`);
  return parsed;
}

/** Words in one piece of 16 kHz mono MP3 (at most ten minutes). Empty text means no speech. */
export async function transcribeWithWorkersAi(mp3: Uint8Array, audioMs: number): Promise<string> {
  // Measured 2026-11-04: 1-4 s for short clips, 22-40 s for nine minutes. The bound leaves room
  // for a slow moment without ever leaving a recording waiting as long as the server engine did.
  const answer = await call("/v1/transcribe", mp3, "audio/mpeg", 30_000 + audioMs / 4);
  if (answer?.model !== WORKERS_AI_SPEECH_MODEL || typeof answer.text !== "string") throw new WorkersAiError("Workers AI transcription answer was malformed");
  return answer.text;
}

/** One vector per text, in order, from the one embedding model the caller's index was built with. */
export async function embedWithWorkersAi(texts: string[], timeoutMs: number): Promise<number[][]> {
  const answer = await call("/v1/embed", JSON.stringify({ texts }), "application/json", timeoutMs);
  // Vectors from another model would silently corrupt an index built from this one.
  if (answer?.model !== WORKERS_AI_EMBEDDING_MODEL) throw new WorkersAiError(`Workers AI answered with model ${String(answer?.model)}`);
  if (!Array.isArray(answer.vectors) || answer.vectors.length !== texts.length) throw new WorkersAiError("Workers AI embedding answer was malformed");
  return answer.vectors;
}
