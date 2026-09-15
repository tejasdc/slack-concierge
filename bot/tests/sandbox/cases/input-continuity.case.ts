import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import { LiveTypedTurnAdapter, LiveTypedTurnError, slackUserCallerFromConfig } from "../adapters/live-typed-turn";
import { BunAgentBrowserCommandRunner, type SandboxBrowser } from "../support/browser";
import type { SandboxEvidenceWriter } from "../support/evidence";
import { routerSearchResponseTarget } from "./router-search.case";

async function until<T>(read: () => T | null, label: string, timeout = 120_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await Bun.sleep(200);
  }
  throw new Error(`Timed out: ${label}`);
}

export async function runInputContinuityCase(options: {
  lane: LaneFixtureIdentities; workspaceDomain: string; runId: string; stateRoot: string; configPath: string;
  adapter: LiveTypedTurnAdapter; browser: SandboxBrowser; evidence: SandboxEvidenceWriter;
}) {
  const { lane, evidence } = options;
  let adapter = options.adapter;
  const source = adapter.runSourceEvidence();
  const databasePath = adapter.routerSearchContext().state_database;
  const read = (sql: string, ...params: any[]) => {
    adapter.runSourceEvidence();
    const db = new Database(databasePath, { readonly: true });
    try { return db.query(sql).get(...params) as any; } finally { db.close(); }
  };
  const slack = slackUserCallerFromConfig(options.configPath);
  const browser = new BunAgentBrowserCommandRunner();
  const command = async (...args: string[]) => {
    adapter.runSourceEvidence();
    const result = await browser.run([...args, "--session", lane.browser.namespace, "--profile", lane.browser.profile_path, "--json"]);
    if (result.exitCode) throw new Error(`Browser command failed: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    if (!parsed.success) throw new Error(`Browser command failed: ${parsed.error}`);
    return parsed.data;
  };
  const stop = async (turnId: number, label: string) => {
    const row = read("SELECT id, session_id, status, progress_stream_ts FROM turns WHERE id=?", turnId);
    if (row.status !== "running" || !row.progress_stream_ts) throw new Error("Stop requires the exact running case turn");
    await command("open", `https://app.slack.com/client/${lane.browser.client_workspace_id}/${lane.dm_channel_id}`);
    let snapshot = await command("snapshot", "-i");
    const home = Object.entries(snapshot.refs as Record<string, any>).filter(([, ref]) => ref.role === "tab" && ref.name === "Home").at(-1);
    if (!home) throw new Error("The claimed app has no Home tab");
    await command("click", `@${home[0]}`);
    let stopRef: string | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      snapshot = await command("snapshot", "-i");
      const stops = Object.entries(snapshot.refs as Record<string, any>).filter(([, ref]) => ref.role === "button" && ref.name === "Stop");
      if (stops.length === 1) { stopRef = stops[0]![0]; break; }
      if (stops.length > 1) throw new Error("Ambiguous Stop targets in the claimed app Home");
      await Bun.sleep(500);
    }
    if (!stopRef || read("SELECT COUNT(*) AS n FROM turns WHERE status='running'").n !== 1) throw new Error("Home did not expose the single owned running turn");
    evidence.writeJson(`${label}-before-stop.json`, { turnId, snapshot });
    await command("screenshot", evidence.path(`${label}-before-stop.png`));
    await command("click", `@${stopRef}`);
    const stopped = await until(() => {
      const row = read("SELECT id, status, stop_requested_at, provider_input_acknowledged_at FROM turns WHERE id=?", turnId);
      return row.stop_requested_at ? row : null;
    }, "real App Home Stop event");
    evidence.writeJson(`${label}-stop.json`, { stopped, snapshot: await command("snapshot", "-i") });
    return stopped;
  };
  const marker = `AUDIO_CONTINUITY_${randomUUID().replaceAll("-", "")}`;
  const transcript = `Remember ${marker}. Reply with that exact marker and the words audio restored. Do not use tools.`;
  writeFileSync(evidence.path("continuity-transcript.txt"), transcript, { mode: 0o600 });
  const root = await adapter.postUserMessage({ lane, channel_id: lane.channels.core.id, client_message_id: randomUUID(),
    text: `@cx [sandbox:${options.runId}:input-continuity] Reply exactly TL;DR: ready for audio. Do not use tools.` });
  const initial = await adapter.waitForRouterSearchTurn(root);
  if (!read("SELECT provider_input_acknowledged_at AS ack FROM turns WHERE id=?", initial.turn_id).ack) throw new Error("Real Codex initial receipt was not observed");

  const wav = Buffer.alloc(44 + 3200);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(3200, 40);
  const reservation = await slack("files.getUploadURLExternal", { filename: `${marker}.wav`, length: wav.length });
  if (typeof reservation.file_id !== "string" || !/^F[A-Z0-9]+$/.test(reservation.file_id)) throw new Error("Slack did not reserve an exact audio file identity");
  evidence.writeJson("continuity-audio-reserved.json", { file_id: reservation.file_id, root, marker });
  const uploadUrl = new URL(String(reservation.upload_url));
  if (uploadUrl.protocol !== "https:" || uploadUrl.hostname !== "files.slack.com") throw new Error("Unexpected Slack upload origin");
  const upload = await fetch(uploadUrl, { method: "POST", body: wav, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!upload.ok) throw new Error("Audio upload failed; do not repeat an ambiguous publication");
  const completed = await slack("files.completeUploadExternal", { files: [{ id: reservation.file_id, title: `${marker}.wav` }], channel_id: root.channel_id, thread_ts: root.thread_ts });
  evidence.writeJson("continuity-audio-completed.json", { file_id: reservation.file_id, root, completed });
  await until(() => existsSync(evidence.path("continuity-transcriber-ready")) ? true : null, "audio transcription gate");
  const audio = await until(() => read("SELECT * FROM turns WHERE session_id=? AND id>? AND status='running'", initial.session_id, initial.turn_id), "audio turn");
  if (audio.user_text || audio.replay_text || audio.provider_admission_intended_at) throw new Error("Audio fixture did not reach the empty-text pre-transcription boundary");
  await stop(audio.id, "audio");
  writeFileSync(evidence.path("continuity-transcriber-release"), "release", { mode: 0o600 });
  const cancelled = await until(() => {
    const row = read("SELECT * FROM turns WHERE id=?", audio.id);
    return row.status === "cancelled" ? row : null;
  }, "audio Stop completion");
  if (!cancelled.replay_text.includes(transcript) || cancelled.provider_turn_id || cancelled.provider_input_acknowledged_at || cancelled.provider_admission_intended_at) throw new Error("Stopped audio was submitted or its exact transcript was lost");

  await adapter.waitForRunSettled();
  const reload = Bun.spawn(["bash", join(import.meta.dir, "../../../scripts/sandbox-lane-control.sh"), "reload", "--lane", lane.lane_id.replace("lane-", ""), "--run-id", options.runId], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([reload.exited, new Response(reload.stdout).text(), new Response(reload.stderr).text()]);
  if (code) throw new Error(`Sandbox restart failed: ${stderr}`);
  const receipt = JSON.parse(stdout);
  evidence.writeJson("continuity-restart.json", { code, status: receipt.status, run_id: receipt.run_id, generation: receipt.generation, source: receipt.source });
  adapter = await until(() => {
    try { return new LiveTypedTurnAdapter({ lane, workspaceDomain: options.workspaceDomain, runId: options.runId, stateRoot: options.stateRoot, configPath: options.configPath }); }
    catch (error) {
      if (error instanceof LiveTypedTurnError && error.code === "run_identity_mismatch") return null;
      throw error;
    }
  }, "matching candidate restart readiness");
  const resumedInput = await adapter.postUserMessage({ lane, channel_id: root.channel_id, thread_ts: root.thread_ts, client_message_id: randomUUID(), text: "Resume the stopped audio request from its saved transcript. Do not use tools." });
  const resumed = await adapter.waitForRouterSearchTurn(resumedInput);
  const preserved = read("SELECT replay_text, input_context_received_by_turn_id FROM turns WHERE id=?", audio.id);
  if (resumed.provider_session_uuid !== initial.provider_session_uuid || !resumed.outbound_text.includes(marker)
      || !resumed.outbound_text.includes("Continuity notice:") || preserved.replay_text !== cancelled.replay_text
      || preserved.input_context_received_by_turn_id !== resumed.turn_id) throw new Error("Restart/resume did not preserve exact audio and native session continuity");

  const acknowledgedInput = await adapter.postUserMessage({ lane, channel_id: root.channel_id, thread_ts: root.thread_ts, client_message_id: randomUUID(),
    text: `Remember ACK_${marker}. Use a shell tool to sleep for 90 seconds, then reply TL;DR: awake. This is an interrupt acceptance test.` });
  const acknowledged = await until(() => {
    const row = read("SELECT id, provider_input_acknowledged_at, provider_turn_id FROM turns WHERE session_id=? AND slack_user_msg_ts=?", initial.session_id, acknowledgedInput.message_ts);
    return row?.provider_input_acknowledged_at && row.provider_turn_id ? row : null;
  }, "acknowledged native input");
  await stop(acknowledged.id, "acknowledged");
  await until(() => read("SELECT status FROM turns WHERE id=?", acknowledged.id).status === "cancelled" ? true : null, "acknowledged Stop completion");
  const finalInput = await adapter.postUserMessage({ lane, channel_id: root.channel_id, thread_ts: root.thread_ts, client_message_id: randomUUID(),
    text: "Do not resume the sleep. Recall the ACK_ marker from the immediately preceding input and reply with it. Do not use tools." });
  const final = await adapter.waitForRouterSearchTurn(finalInput);
  await adapter.waitForRunSettled();
  if (!final.outbound_text.includes(`ACK_${marker}`) || final.outbound_text.includes("Continuity notice:")
      || read("SELECT input_context_received_by_turn_id AS carrier FROM turns WHERE id=?", acknowledged.id).carrier !== null) throw new Error("Acknowledged input was reinserted or its native history was lost");
  const transferSource = await adapter.postUserMessage({ lane, channel_id: lane.dm_channel_id,
    client_message_id: randomUUID(), text: "@cx Reply exactly TL;DR: Stopped-input transfer fixture ready. Do not use tools." });
  await adapter.waitForRouterSearchTurn(transferSource);
  const transferAction = `stopped-transfer-${marker}`;
  let continuationRejection = "";
  try {
    await adapter.submitRoutedRequest({ source: { channel_id: transferSource.channel_id, message_ts: transferSource.message_ts },
      action_id: transferAction, destination: { channel_id: root.channel_id, root_ts: root.thread_ts },
      provider: "cc", defer: false, depends_on: [], task: "Continue this stopped conversation on Claude." });
  } catch (error) { continuationRejection = String(error); }
  if (!continuationRejection.includes("source contains stopped input") || !continuationRejection.includes("explicit continuation brief")
      || read("SELECT COUNT(*) AS n FROM routed_requests WHERE source_channel=? AND source_message_ts=? AND action_id=?",
        transferSource.channel_id, transferSource.message_ts, transferAction).n !== 0) throw new Error("Provider transfer silently omitted stopped history or published despite its continuity gap");
  await adapter.waitForRunSettled();
  const request = { lane_id: lane.lane_id, workspace_domain: options.workspaceDomain,
    browser_namespace: lane.browser.namespace, browser_profile_path: lane.browser.profile_path,
    phase: "terminal" as const, ...routerSearchResponseTarget(resumedInput, resumed.response_message_ts, marker), required_text: [marker, "Continuity notice:"],
    assertions: ["The stopped audio is restored after a service restart, with an explicit continuity notice"],
  };
  const browserEvidence = evidence.verifyScreenshot(await options.browser.capture(request, evidence));
  const result = { case_id: "input-continuity", status: "passed", run_id: options.runId, lane_id: lane.lane_id,
    source, final_source: adapter.runSourceEvidence(), root, initial, audio_turn_id: audio.id, audio_file_id: reservation.file_id,
    transcript, replay_sha256: createHash("sha256").update(preserved.replay_text).digest("hex"), resumedInput, resumed,
    acknowledgedInput, acknowledged, finalInput, final, transferSource, continuationRejection, browser: browserEvidence, unsettled: 0 };
  evidence.writeJson("input-continuity.json", result);
  return result;
}
