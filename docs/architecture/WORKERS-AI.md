# Speech and session-search embeddings on Cloudflare Workers AI

Status: current, 2026-11-04. Step 4 of the
[off-one-server plan](https://github.com/tejasdc/remote-box/blob/main/docs/plans/2026-11-04-off-one-server-architecture.md): the two models that
ran on the agent server (Parakeet speech-to-text, about 2 cores per recording, and the
EmbeddingGemma llama.cpp process behind session search, about 1.5 cores) move to Cloudflare, so
neither competes with agents for the AX41's processors.

## Parts and where they run

| Part | Runs on | Does |
| --- | --- | --- |
| `concierge-workers-ai` Worker (`cloudflare/workers-ai`) | Cloudflare, `https://concierge-workers-ai.thnkring.workers.dev` | `POST /v1/transcribe` (16 kHz mono MP3, ≤10 min) → Whisper large-v3-turbo; `POST /v1/embed` (≤100 texts) → EmbeddingGemma-300m. Every answer names its model. |
| Shared key | Worker secret `CONCIERGE_KEY`; root-only `/etc/concierge/workers-ai.token` on each Concierge machine that uses it | Bearer key for both calls. A machine without the file (the Mac) keeps its own engines. |
| Speech worker (`concierge-speech-worker.service`) | server | Converts a recording to MP3 pieces with ffmpeg, sends them to the Worker, joins the words. Engine name `workers-ai-whisper`. |
| Meaning index (session search, earlier work, Inbox areas) | Concierge owner, server | Embeds through the Worker into a file named for the model, beside the local index on the ledger disk. The in-memory int8 scan stays local (49 MB for ~96,000 passages, ~20 ms a search). |

**Why a Worker and not the REST API.** The one Cloudflare token (`remote-box-workers-deploy`) can
deploy Workers but is refused by the Workers AI and Vectorize APIs. A Worker's AI binding needs no
token permission, so the Worker works with today's token; the cost is one small deployable and one
shared key. Adding the Workers AI permission to the token would remove the Worker but needs Tejas's
dashboard, and the Worker is also where a future Cloudflare-hosted control plane would call the
models from.

**Why not Vectorize.** The plan named Vectorize for the vectors. The processor cost was computing
embeddings, not searching them: the local scan of the whole index is about 20 ms and 49 MB. Vectorize
would add a network round trip to every search, cap results per query (the index keeps the best
passage per session over all passages), and a second store to keep in step with title changes and
the archive. It earns its place when the index outgrows the app server's memory (tens of millions of
passages), not at 96,000.

## Fallback and the never-mix rule

- **Speech:** Workers AI first; any refusal, timeout or network failure is logged as
  `transcriber_fallback` with `from: workers-ai-whisper` and the recording goes to Parakeet, then
  whisper.cpp, exactly as before. An empty answer from the cloud is confirmed by Parakeet before a
  recording is recorded as silent, because Whisper's voice-activity filter can drop quiet speech.
  Recordings longer than ten minutes go in ten-minute pieces; a word cut at a boundary can be garbled.
- **Embeddings:** each model's index lives in its own file, named for the model
  (`meaning-index.cf-google-embeddinggemma-300m.db`), and records its model (`watermarks.model`); a
  file written by another model is cleared, never searched with this model's vectors. While the new
  index is built the local index keeps answering. Every caller takes one index per search, so a
  question and its candidates always share a model. If Workers AI is unreachable after the
  hand-over, meaning search says so and word search still answers.
- **Embeddings switch, two steps:** `/etc/concierge/workers-ai-embeddings.enabled` existing (empty)
  starts building the Workers AI index. The first build embeds ~96,000 passages, several times the
  free plan's 10,000-neuron daily allowance that speech shares, so it is created only once the
  account is on Workers Paid. Writing `serve` into the same file lets the built index take over
  (`meaning_index_switched`, within a minute, no restart) once it has read everything including the
  archive; it is written only after the routing comparison below is rerun on the two full indexes
  (top-10 agreement and the score shift at the area-filing and earlier-work thresholds, which were
  tuned on the local 8-bit model's scores). Then the llama.cpp process is stopped for good.

## Measured before switching (2026-11-04)

Speech, 40 recordings from 2026-10-28 to 2026-11-04 (30 the server had transcribed with Parakeet,
10 the iPhone had transcribed on device). No human reference exists, so engines are compared with
each other (word error rate between two transcripts) and the disagreements were read by hand.

| | Whisper large-v3-turbo (Workers AI) | Deepgram Nova-3 (Workers AI) | Parakeet (server, same day) |
| --- | --- | --- | --- |
| 9-minute recording | 22-40 s | 1.2-1.6 s | 6-18 min (host under agent load) |
| 10-30 s recording | 1-2 s | 0.3-0.6 s | 53 s for 11 s; 78 s for 27 s |
| Words differing from Parakeet's text (duration-weighted) | 10.9% | 11.3% | — |
| Words differing from each other | 9.2% | | |
| Price | $0.00051 / audio minute | about 10× Whisper | server processors |

Read by hand: on one recording Parakeet dropped the last 40% of his sentence ("…Chief." where both
cloud engines heard "Please redesign with the highest tier of diligence…"); on two silent clips
Parakeet invented "tamb tamb tamb…" where both cloud engines returned nothing; Whisper heard
"B2 tourist visa" where Parakeet wrote "B22 risk visa" / "Beto tourist visa" and Nova "call the
Lyft". Whisper sometimes omits punctuation. Whisper was chosen: best on his vocabulary at a tenth of
Nova's price, and 30 s for nine minutes is far inside what a recording can wait. Busiest day of
server speech in the last two weeks was 111 minutes, about half the free daily allowance.

Embeddings: Workers AI hosts the same EmbeddingGemma-300m model the server runs (as an 8-bit
llama.cpp build). Routing comparison: pending, see [below](#routing-comparison).

## Routing comparison

Pending: the Workers AI half runs after the free allowance resets at 00:00 UTC on 2026-11-05.

## Operating

- Deploy the Worker: `wrangler deploy --config cloudflare/workers-ai/wrangler.toml` with
  `/etc/cloudflare-remote-box.env` loaded. Rotate the key by writing a new value to the token file
  and `wrangler secret put CONCIERGE_KEY` with the same value; Concierge rereads it on restart.
- Usage: Cloudflare dashboard → AI → Workers AI. Logs: `audio_transcribed` with
  `engine: workers-ai-whisper`, `transcriber_fallback`, `meaning_index_model_changed`,
  `meaning_index_switched`.
- The Parakeet, whisper.cpp and llama.cpp installs stay on the server as the fallback.
