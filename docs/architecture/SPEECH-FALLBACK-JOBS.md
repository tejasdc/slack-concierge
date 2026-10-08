# Server speech fallback lifetime

When a device has no words for a retained recording, the Linux owner stages its verified
audio under its root-only state directory and starts one supervised speech worker. The
worker lives outside the Concierge coordinator's service group, processes one job at a
time, and writes an atomic result artifact. It never opens or writes the canonical
database. The owner alone commits words, no-speech, or failure against the attachment
identity. A coordinator restart therefore drops a waiting HTTP connection but not the
recording or its job; a retry starts or rejoins the same attachment ID. On startup and
every second, the owner reconciles a bounded set of finished artifacts. A worker exit
restarts under systemd and reprocesses an unfinished job; transcription is a pure effect,
so duplicate compute cannot duplicate a message or overwrite retained device words.

The browser starts fallback with `POST /attachments/:id/transcription/start`. An accepted
start returns a state immediately. `GET /attachments/:id/transcription` returns queued,
transcribing, done with words, no-speech, failed, or unavailable. The browser reconnects
and polls the same ID; existing clients can still use the old waiting POST. The device
transcript POST remains authoritative when it wins the canonical write. A failed worker
or transcriber leaves the audio in custody and reports a typed failure; it does not retry
forever or silently call the job finished.

The worker is a release bundle started as `concierge-speech-worker.service` with
`systemd-run`. Its command names the stable current release link. After a release changes,
it finishes its current job, exits at idle, and systemd restarts it from the new bundle.
The existing speech engine's ten-minute idle unload still applies. There is one worker
and one engine per host, not a model process for each recording. Inspect the worker unit,
`speech_worker_ready`, `speech_job_finished`, and `audio_transcribed` for live diagnosis.
The spool contains private audio and words, mode 0700/0600. The canonical retained audio
is the recovery source if a staging artifact is lost. Abandoned partial staging is removed
after an hour; successful artifacts are removed after commit, and terminal no-speech/failure
is recorded in the ledger.

Isolated verification: `CONCIERGE_TEST_AUTHORIZATION=native-attribution-5eaa0768 bun test
tests/speech-job-recovery.test.ts` from `bot/`. It proves duplicate and concurrent start, a
result from a separate worker process read by a new owner, terminal silence/failure,
device precedence, and the HTTP start/status
contract. It does not prove installed systemd survival or real Parakeet speed; those need
the marked live check after activation.

On the server, a fresh outside monitor owns sustained degradation notices and repair
investigation. The in-process freeze notice yields while that monitor is active, avoiding
two incidents for one stall. On the Mac, where the outside monitor does not run, the local
notice stays in place. Both machines keep the underlying lag and request logs.
