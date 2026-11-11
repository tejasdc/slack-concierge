# Speech and session-search embeddings on Cloudflare Workers AI

Status: current, 2026-11-06. In step 4 of the
[off-one-server plan](https://github.com/tejasdc/remote-box/blob/main/docs/plans/2026-11-04-off-one-server-architecture.md),
speech moved to Cloudflare. Session-search embeddings remain on the server until the optional
Cloudflare index is built and its routing quality is checked. The local EmbeddingGemma llama.cpp
process had used about 1.5 cores; moving it remains the goal, not an installed claim.

## Parts and where they run

| Part | Runs on | Does |
| --- | --- | --- |
| `concierge-workers-ai` Worker (`cloudflare/workers-ai`) | Cloudflare, `https://concierge-workers-ai.thnkring.workers.dev` | `POST /v1/transcribe` (16 kHz mono MP3, ≤10 min) → Whisper large-v3-turbo; optional `POST /v1/embed` (≤32 texts, the model's limit) → Qwen3-Embedding-0.6B. Every answer names its model. |
| Shared key | Worker secret `CONCIERGE_KEY`; root-only `/etc/concierge/workers-ai.token` on each Concierge machine that uses it | Bearer key for both calls. A machine without the file (the Mac) keeps its own engines. |
| Speech worker (`concierge-speech-worker.service`) | server | Converts a recording to MP3 pieces with ffmpeg, sends them to the Worker, joins the words. Engine name `workers-ai-whisper`. |
| Meaning index (session search, earlier work, Inbox areas) | Concierge owner, server | Currently embeds locally. When explicitly enabled, builds a Worker-backed file named for its model beside the local index on the ledger disk. The in-memory int8 scan stays local. |

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
  (`meaning-index.cf-qwen-qwen3-embedding-0-6b.db` for the new Cloudflare model), and records its model (`watermarks.model`); a
  file written by another model is cleared, never searched with this model's vectors. While the new
  index is built the local index keeps answering. Every caller takes one index per search, so a
  question and its candidates always share a model. If Workers AI is unreachable after the
  hand-over, meaning search says so and word search still answers.
- **Embeddings switch, two steps:** `/etc/concierge/workers-ai-embeddings.enabled` existing (empty)
  starts building the Workers AI index at the owner's next restart. The first build embeds over 100,000 passages, several times the
  free plan's 10,000-neuron daily allowance that speech shares, so it is created only once the
  account is on Workers Paid. Writing `serve` into the same file lets the built index take over
  (`meaning_index_switched`, within a minute, no restart) once it has read everything including the
  archive; it is written only after the routing comparison below is rerun on the two full indexes
  (top-10 agreement and the score shift at the area-filing and earlier-work thresholds, which were
  tuned on the local 8-bit model's scores), with the result recorded in the Routing comparison
  section. Then the llama.cpp process is stopped for good.
- **Rollback:** remove the switch file *and restart the owner*. Removing it while the Workers AI
  index is serving turns meaning search off until the restart, when the local index resumes from its
  own watermark. Speech rolls back by removing `/etc/concierge/workers-ai.token`; the speech worker
  reads it per process, so restart `concierge-speech-worker.service` too.

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

Embeddings: the Cloudflare model is now Qwen3-Embedding-0.6B, which produces 1,024-dimensional
vectors; the index uses its first 512 dimensions and normalizes them. Qwen documents Matryoshka
dimension support, but this is a different vector space from the local EmbeddingGemma model.
The local index and its scores remain in service. Cloudflare model responses are checked for
the exact model, dimensions, vector count and finite values before they can enter the new index.
Each engine carries its own model's documented prompt format: Qwen gets an instruction on queries
and nothing on documents, EmbeddingGemma keeps its `task:`/`title:` prefixes. Changing a model's
prefixes changes what its vectors mean and requires a fresh index file, as changing the model does.
Qwen on Workers AI accepts at most 32 texts per call; the Worker and the server's batches share that limit.
The first Qwen build and routing comparison are pending; do not create the embedding switch or
write `serve` merely because the Worker deployed. The old Cloudflare index, if present on another
machine, remains a separate, unused derived file and is never read as Qwen vectors.

## Routing comparison

Pending: the server's embedding switch was absent on 2026-11-06, and the complete local index
contained 114,412 passages. Activation requires a paid-plan build and a fresh comparison of
full-index top-10 routing and the area-filing and earlier-work thresholds. The old EmbeddingGemma
comparison does not transfer to Qwen. Cloudflare's replacement named in its deprecation notice,
EmbeddingGemma-2, was not available when this change was made; the available Qwen model keeps the
optional Cloudflare endpoint usable before the November 20 deadline without changing live search.

## Operating

- Deploy the Worker: `wrangler deploy --config cloudflare/workers-ai/wrangler.toml` with
  `/etc/cloudflare-remote-box.env` loaded. Rotate the key by writing a new value to the token file
  and `wrangler secret put CONCIERGE_KEY` with the same value; Concierge rereads it on restart.
- Usage: Cloudflare dashboard → AI → Workers AI. Logs: `audio_transcribed` with
  `engine: workers-ai-whisper`, `transcriber_fallback`, `meaning_index_model_changed`,
  `meaning_index_switched`.
- The Parakeet, whisper.cpp and llama.cpp installs stay on the server as the fallback.
