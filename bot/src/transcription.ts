import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import type { DownloadedSlackFile, SlackMessageFile } from "./attachments";

const DEFAULT_WHISPER_BINARY = "/root/.local/share/concierge/whisper.cpp/build/bin/whisper-cli";
const DEFAULT_WHISPER_MODEL = "/root/.local/share/concierge/whisper-models/ggml-base.en.bin";

export interface AudioTranscript {
  slackFileId: string;
  title: string;
  text: string;
  source: "slack" | "whisper.cpp";
}

export function isAudioFile(file: SlackMessageFile) {
  return file.media_display_type === "audio" || file.mimetype?.startsWith("audio/") === true;
}

export function slackTranscript(transcription: unknown): string | null {
  if (!transcription || typeof transcription !== "object") return null;
  const value = transcription as Record<string, unknown>;
  if (typeof value.text === "string" && value.text.trim()) return value.text.trim();
  if (!Array.isArray(value.lines)) return null;
  const text = value.lines.flatMap((line) => {
    if (!line || typeof line !== "object") return [];
    const record = line as Record<string, unknown>;
    for (const field of [record.text, record.contents]) {
      if (typeof field === "string" && field.trim()) return [field.trim()];
    }
    return [];
  }).join(" ").trim();
  return text || null;
}

export async function transcribeAudioAttachments(input: {
  slackFiles: SlackMessageFile[];
  downloadedFiles: DownloadedSlackFile[];
  runCommand?: typeof runCommand;
  whisperBinary?: string;
  whisperModel?: string;
}): Promise<AudioTranscript[]> {
  const downloadedById = new Map(input.downloadedFiles.map((file) => [file.slackFileId, file]));
  const transcripts: AudioTranscript[] = [];
  for (const slackFile of input.slackFiles.filter(isAudioFile)) {
    const downloaded = slackFile.id ? downloadedById.get(slackFile.id) : undefined;
    if (!downloaded) throw new Error(`Downloaded audio is missing for Slack file ${slackFile.id || "unknown"}`);
    const provided = slackTranscript(slackFile.transcription);
    if (provided) {
      transcripts.push({ slackFileId: downloaded.slackFileId, title: downloaded.title, text: provided, source: "slack" });
      continue;
    }
    const wavPath = join(dirname(downloaded.path), `${downloaded.slackFileId}.wav`);
    const execute = input.runCommand || runCommand;
    await execute("ffmpeg", ["-y", "-loglevel", "error", "-i", downloaded.path, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath]);
    const result = await execute(input.whisperBinary || process.env.CONCIERGE_WHISPER_BINARY || DEFAULT_WHISPER_BINARY, [
      "-m", input.whisperModel || process.env.CONCIERGE_WHISPER_MODEL || DEFAULT_WHISPER_MODEL,
      "-f", wavPath,
      "-t", String(Math.max(1, Math.min(8, Number(process.env.CONCIERGE_WHISPER_THREADS) || 8))),
      "-l", process.env.CONCIERGE_WHISPER_LANGUAGE || "en",
      "-nt", "-np",
    ]);
    const text = result.stdout.replace(/^read_audio_data:.*$/gm, "").trim();
    if (!text) throw new Error(`Transcriber returned no text for ${downloaded.title}`);
    transcripts.push({ slackFileId: downloaded.slackFileId, title: downloaded.title, text, source: "whisper.cpp" });
  }
  return transcripts;
}

export function transcriptionPrompt(transcripts: AudioTranscript[]) {
  if (transcripts.length === 0) return "";
  return [
    "Audio clip transcription(s):",
    ...transcripts.map((transcript, index) => `${index + 1}. ${transcript.title} (source=${transcript.source})\n${transcript.text}`),
    "",
    "Treat each transcription as the user's spoken message. It may contain speech-recognition errors; use the audio file only when clarification is necessary.",
  ].join("\n");
}

function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(0, 800) || stdout.slice(0, 800) || "no output"}`));
    });
  });
}
