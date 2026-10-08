#!/usr/bin/env bun
/** Mac-local speech outlives Concierge updates and owns its own Apple engine and recordings. */
import { startLiveSpeechListener } from "../src/live-speech";
import { warmSpeechEngine } from "../src/speech-engine";
import { log, errorFields } from "../src/log";

warmSpeechEngine();
const listener = startLiveSpeechListener();
if (!listener) {
  log("error", "live_speech_service_unavailable", { reason: "Apple speech or Mac loopback listener unavailable" });
  process.exit(1);
}

let stopping: Promise<void> | null = null;
const stop = () => stopping ??= listener.stop().catch(error => {
  log("error", "live_speech_service_stop_failed", errorFields(error));
}).then(() => { process.exit(0); });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void stop(); });
