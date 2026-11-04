/**
 * Concierge's models on Cloudflare Workers AI. Two calls, both behind one shared key:
 *
 *   POST /v1/transcribe   body: 16 kHz mono MP3 (one piece of at most ten minutes)
 *                         → {model, text}
 *   POST /v1/embed        body: {"texts": string[]} (at most 100)
 *                         → {model, dimensions, vectors}
 *
 * The answer names the exact model so a caller can refuse to mix vectors from two models.
 * Measured on Tejas's recordings and routing requests on 2026-11-04 (docs/architecture/WORKERS-AI.md).
 */
interface Env {
  AI: Ai;
  CONCIERGE_KEY: string;
}

const SPEECH_MODEL = "@cf/openai/whisper-large-v3-turbo";
const EMBEDDING_MODEL = "@cf/google/embeddinggemma-300m";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_TEXTS = 100;
const MAX_TEXT_CHARS = 4_000;

function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function sameKey(given: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([given, expected].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))));
  return crypto.subtle.timingSafeEqual(a!, b!);
}

const answer = (status: number, body: unknown) => Response.json(body, { status });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.CONCIERGE_KEY) return answer(503, { error: "key not configured" });
    const given = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!(await sameKey(given, env.CONCIERGE_KEY))) return answer(401, { error: "unauthorized" });
    if (request.method !== "POST") return answer(405, { error: "POST only" });
    const path = new URL(request.url).pathname;
    try {
      if (path === "/v1/transcribe") {
        const audio = await request.arrayBuffer();
        if (!audio.byteLength || audio.byteLength > MAX_AUDIO_BYTES) return answer(413, { error: "audio must be 1 byte to 25 MB" });
        const result = await env.AI.run(SPEECH_MODEL, { audio: base64(audio), language: "en", vad_filter: true });
        // A missing text field is a model failure, not silence; the caller falls back on 502.
        if (typeof result?.text !== "string") return answer(502, { error: "speech model answered without text" });
        return answer(200, { model: SPEECH_MODEL, text: result.text.trim() });
      }
      if (path === "/v1/embed") {
        const body = (await request.json().catch(() => null)) as { texts?: unknown } | null;
        const texts = body?.texts;
        if (!Array.isArray(texts) || !texts.length || texts.length > MAX_TEXTS || !texts.every((text) => typeof text === "string" && text.length <= MAX_TEXT_CHARS))
          return answer(400, { error: `texts must be 1-${MAX_TEXTS} strings of at most ${MAX_TEXT_CHARS} characters` });
        const result = (await env.AI.run(EMBEDDING_MODEL, { text: texts as string[] })) as { data: number[][]; shape: number[] };
        return answer(200, { model: EMBEDDING_MODEL, dimensions: result.shape?.[1] ?? result.data[0]?.length ?? 0, vectors: result.data });
      }
      return answer(404, { error: "unknown path" });
    } catch (error) {
      // Workers AI capacity and model errors are retryable from the caller's side; the caller falls back.
      return answer(502, { error: error instanceof Error ? error.message : String(error) });
    }
  },
};
