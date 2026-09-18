import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { log } from "./log";
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
    transcripts.push(await transcribeAudioPath({slackFileId:downloaded.slackFileId,title:downloaded.title,path:downloaded.path,runCommand:input.runCommand,whisperBinary:input.whisperBinary,whisperModel:input.whisperModel}));
  }
  return transcripts;
}

// Native sessions retain attachment custody in the common owner. They use the
// same local Whisper runtime as Slack input, with a turn-owned staged path.
// One transcription at a time, ahead of builds and agents. whisper.cpp spreads each job over
// every thread it is given, so overlapping jobs on a busy host stall each other's threads. On
// 2026-09-18 a 10-second clip that takes 2s alone took 55s, and a 3-minute one 17s alone took
// 8 minutes, while three recordings and three release builds shared the machine. The lane is also
// what a waiting surface reads to say whether a recording is in line or being transcribed.
type LaneEntry={key:string;enqueuedAt:number;startedAt:number|null};
const lane:LaneEntry[]=[];
let laneTail:Promise<unknown>=Promise.resolve();
export type TranscriptionProgress={state:'queued';ahead:number;waitedMs:number}|{state:'transcribing';elapsedMs:number};
export function transcriptionProgress(key:string,now=Date.now()):TranscriptionProgress|null{
 const index=lane.findIndex(entry=>entry.key===key),entry=lane[index];
 if(!entry)return null;
 return entry.startedAt===null?{state:'queued',ahead:index,waitedMs:now-entry.enqueuedAt}:{state:'transcribing',elapsedMs:now-entry.startedAt};
}
export function transcribeAudioPath(input:{slackFileId:string;title:string;path:string;runCommand?:typeof runCommand;whisperBinary?:string;whisperModel?:string}):Promise<AudioTranscript>{
 const entry:LaneEntry={key:input.slackFileId,enqueuedAt:Date.now(),startedAt:null};
 lane.push(entry);
 const run=laneTail.then(async()=>{
  entry.startedAt=Date.now();
  try{return await transcribeNow(input,entry);}
  finally{lane.splice(lane.indexOf(entry),1);}
 });
 laneTail=run.catch(()=>undefined);
 return run;
}
async function transcribeNow(input:{slackFileId:string;title:string;path:string;runCommand?:typeof runCommand;whisperBinary?:string;whisperModel?:string},entry:LaneEntry):Promise<AudioTranscript>{
 const queuedMs=entry.startedAt!-entry.enqueuedAt;
 const wavPath=join(dirname(input.path),`${input.slackFileId}.wav`),execute=input.runCommand||runCommand;
 const converting=Date.now();
 await execute('ffmpeg',['-y','-loglevel','error','-i',input.path,'-ar','16000','-ac','1','-c:a','pcm_s16le',wavPath]);
 const transcribing=Date.now(),convertMs=transcribing-converting;
 const result=await execute(input.whisperBinary||process.env.CONCIERGE_WHISPER_BINARY||DEFAULT_WHISPER_BINARY,['-m',input.whisperModel||process.env.CONCIERGE_WHISPER_MODEL||DEFAULT_WHISPER_MODEL,'-f',wavPath,'-t',String(Math.max(1,Math.min(8,Number(process.env.CONCIERGE_WHISPER_THREADS)||8))),'-l',process.env.CONCIERGE_WHISPER_LANGUAGE||'en','-nt','-np']);
 const text=result.stdout.replace(/^read_audio_data:.*$/gm,'').trim();
 log('info','audio_transcribed',{attachment_id:input.slackFileId,queued_ms:queuedMs,convert_ms:convertMs,transcribe_ms:Date.now()-transcribing,queued_behind:lane.length-1,text_chars:text.length});
 if(!text)throw new Error(`Transcriber returned no text for ${input.title}`);
 return {slackFileId:input.slackFileId,title:input.title,text,source:'whisper.cpp'};
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
    // Raised priority keeps a waiting person ahead of builds and batch agents. Without the
    // privilege nice warns and still runs the command, so this can only help.
    const child = spawn("nice", ["-n", "-10", command, ...args], { stdio: ["ignore", "pipe", "pipe"] });
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
