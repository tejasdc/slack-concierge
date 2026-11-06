import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log } from "./log";
import { speechEngine } from "./speech-engine";
import { transcribeWithWorkersAi, workersAiConfigured } from "./workers-ai";
import type { DownloadedSlackFile, SlackMessageFile } from "./attachments";

// Legacy fallback, used only when the resident engine is not installed or fails a request.
// Remove with the rest of whisper.cpp once Parakeet has run clean in production (Thinkering
// notes/TODOS.md, "Retire whisper.cpp").
const DEFAULT_WHISPER_BINARY = "/root/.local/share/concierge/whisper.cpp/build/bin/whisper-cli";
const DEFAULT_WHISPER_MODEL = "/root/.local/share/concierge/whisper-models/ggml-base.en.bin";

export interface AudioTranscript {
  slackFileId: string;
  title: string;
  text: string;
  /** Which engine produced the text; `local` marks a transcript retained before engines were recorded. */
  source: "slack" | "workers-ai-whisper" | SpeechEngineName | "whisper.cpp" | "local";
  audioMs?: number;
}
/** One Workers AI request carries at most this much audio; a longer recording is sent in pieces of this length. */
const CLOUD_PIECE_SECONDS = 600;
export type SpeechEngineName = "parakeet" | "apple";


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
// same local speech engine as Slack input, with a turn-owned staged path.
// One transcription at a time, ahead of builds and agents. A speech engine spreads each job over
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
export function transcribeAudioPath(input:TranscribeInput):Promise<AudioTranscript>{
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
type TranscribeInput={slackFileId:string;title:string;path:string;runCommand?:typeof runCommand;whisperBinary?:string;whisperModel?:string};
/** The transcriber heard no words. Silence is an answer, never a transcription failure. */
export class NoSpeech extends Error {}

/**
 * Words for a recording attached to a session message, made as the turn starts. A recording
 * never stops the message reaching its agent: silence adds no words, and a transcriber that
 * fails leaves a note so the agent knows the attached file was not heard. thnkr.ing's Send
 * while recording attaches the recording itself and relies on this (Tejas, 2026-09-16:
 * "sometimes I do want to just send my voice recording right away").
 */
export async function attachedRecordingWords(input:TranscribeInput):Promise<{transcript:AudioTranscript|null;note:string|null}>{
 try{return {transcript:await transcribeAudioPath(input),note:null};}
 catch(error){
  if(error instanceof NoSpeech)return {transcript:null,note:null};
  log('warn','attached_recording_untranscribed',{attachment_id:input.slackFileId,reason:error instanceof Error?error.message.slice(0,300):'unknown'});
  return {transcript:null,note:`The attached recording ${JSON.stringify(input.title)} could not be turned into words before this turn; its audio file is attached above.`};
 }
}

/** A whole recording the Mac's browser hands over (live-speech.ts). Silence is an empty answer, not a failure. */
export async function transcribeWholeRecording(input:{id:string;path:string}):Promise<{text:string;audioMs:number|null}>{
 try{const result=await transcribeAudioPath({slackFileId:input.id,title:'recording',path:input.path});return {text:result.text,audioMs:result.audioMs??null};}
 catch(error){if(error instanceof NoSpeech)return {text:'',audioMs:null};throw error;}
}
async function transcribeNow(input:TranscribeInput,entry:LaneEntry):Promise<AudioTranscript>{
 const queuedMs=entry.startedAt!-entry.enqueuedAt;
 // A caller that supplies its own command runner or Whisper paths has asked for Whisper.
 const explicitWhisper=Boolean(input.runCommand||input.whisperBinary||input.whisperModel);
 // Workers AI first, so a recording takes no processor time from the agents on this machine; the
 // local engines below are its fallback when Cloudflare cannot be reached or refuses.
 let cloudHeardNothing:NoSpeech|null=null;
 if(!explicitWhisper&&workersAiConfigured()){
  try{return await transcribeWithCloud(input,queuedMs);}
  catch(error){
   // "No words" from the cloud is confirmed by the local engine before he is told a recording was
   // silent: Whisper's voice-activity filter can drop quiet speech, and silent clips are short.
   if(error instanceof NoSpeech&&!speechEngine.installed())throw error;
   if(error instanceof NoSpeech)cloudHeardNothing=error;
   log(error instanceof NoSpeech?'info':'warn','transcriber_fallback',{engine:speechEngine.installed()?speechEngine.name:'whisper.cpp',from:'workers-ai-whisper',attachment_id:input.slackFileId,reason:error instanceof NoSpeech?'no_speech_confirming':error instanceof Error?error.message.slice(0,300):'unknown'});
  }
 }
 if(!explicitWhisper&&speechEngine.installed()){
  try{return await transcribeWithEngine(input,queuedMs);}
  catch(error){
   // Silence is an answer, not an engine failure; Whisper would only invent words from it.
   if(error instanceof NoSpeech)throw error;
   // The cloud already heard silence and only the confirmation failed: silence stands, rather than
   // letting whisper.cpp invent words from it.
   if(cloudHeardNothing)throw cloudHeardNothing;
   // A Mac has no Whisper; the engine's own failure says more than "not installed" would.
   if(!existsSync(process.env.CONCIERGE_WHISPER_BINARY||DEFAULT_WHISPER_BINARY))throw error;
   // The recording is not lost and the person is not failed: the retained audio goes through
   // the legacy engine instead, and the fallback is logged so it cannot pass as normal.
   log('warn','transcriber_fallback',{engine:'whisper.cpp',attachment_id:input.slackFileId,reason:error instanceof Error?error.message:'unknown'});
  }
 }
 return transcribeWithWhisper(input,queuedMs);
}


async function transcribeWithCloud(input:TranscribeInput,queuedMs:number):Promise<AudioTranscript>{
 const pieceDir=await mkdtemp(join(dirname(input.path),`${input.slackFileId}-cloud-`));
 try{
  const converting=Date.now();
  // 16 kHz mono MP3 is what the model hears anyway and a quarter of the upload of WAV.
  await runCommand('ffmpeg',['-y','-loglevel','error','-i',input.path,'-map','0:a:0','-vn','-ar','16000','-ac','1','-b:a','48k','-f','segment','-segment_time',String(CLOUD_PIECE_SECONDS),'-reset_timestamps','1',join(pieceDir,'%04d.mp3')]);
  const pieces=(await readdir(pieceDir)).filter(name=>name.endsWith('.mp3')).sort();
  const transcribing=Date.now(),convertMs=transcribing-converting;
  const texts:string[]=[];let audioMs=0;
  for(const piece of pieces){
   const path=join(pieceDir,piece);
   const pieceMs=Math.round(Number((await runCommand('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',path])).stdout.trim())*1000)||CLOUD_PIECE_SECONDS*1000;
   audioMs+=pieceMs;
   texts.push((await transcribeWithWorkersAi(await readFile(path),pieceMs)).trim());
  }
  const text=texts.filter(Boolean).join(' ');
  log('info','audio_transcribed',{engine:'workers-ai-whisper',attachment_id:input.slackFileId,audio_ms:audioMs,queued_ms:queuedMs,convert_ms:convertMs,transcribe_ms:Date.now()-transcribing,pieces:pieces.length,queued_behind:lane.length-1,text_chars:text.length});
  if(!text)throw new NoSpeech(`Transcriber returned no text for ${input.title}`);
  return {slackFileId:input.slackFileId,title:input.title,text,source:'workers-ai-whisper',audioMs};
 }finally{await rm(pieceDir,{recursive:true,force:true});}
}

async function transcribeWithEngine(input:TranscribeInput,queuedMs:number):Promise<AudioTranscript>{
 const pcmPath=join(dirname(input.path),`${input.slackFileId}.f32`);
 const converting=Date.now();
 await runCommand('ffmpeg',['-y','-loglevel','error','-i',input.path,'-ar','16000','-ac','1','-f','f32le',pcmPath]);
 const transcribing=Date.now(),convertMs=transcribing-converting;
 const audioMs=Math.round((await stat(pcmPath)).size/4/16);
 const result=await speechEngine.transcribe(pcmPath,audioMs);
 const text=result.text.trim();
 log('info','audio_transcribed',{engine:speechEngine.name,attachment_id:input.slackFileId,audio_ms:result.audioMs||audioMs,queued_ms:queuedMs,convert_ms:convertMs,transcribe_ms:Date.now()-transcribing,compute_ms:result.computeMs,chunks:result.chunks,warm:result.warm,queued_behind:lane.length-1,text_chars:text.length});
 if(!text)throw new NoSpeech(`Transcriber returned no text for ${input.title}`);
 return {slackFileId:input.slackFileId,title:input.title,text,source:speechEngine.name,audioMs:result.audioMs||audioMs};
}

async function transcribeWithWhisper(input:TranscribeInput,queuedMs:number):Promise<AudioTranscript>{
 const wavPath=join(dirname(input.path),`${input.slackFileId}.wav`),execute=input.runCommand||runCommand;
 const converting=Date.now();
 await execute('ffmpeg',['-y','-loglevel','error','-i',input.path,'-ar','16000','-ac','1','-c:a','pcm_s16le',wavPath]);
 const transcribing=Date.now(),convertMs=transcribing-converting;
 const result=await execute(input.whisperBinary||process.env.CONCIERGE_WHISPER_BINARY||DEFAULT_WHISPER_BINARY,['-m',input.whisperModel||process.env.CONCIERGE_WHISPER_MODEL||DEFAULT_WHISPER_MODEL,'-f',wavPath,'-t',String(Math.max(1,Math.min(8,Number(process.env.CONCIERGE_WHISPER_THREADS)||8))),'-l',process.env.CONCIERGE_WHISPER_LANGUAGE||'en','-nt','-np']);
 const text=result.stdout.replace(/^read_audio_data:.*$/gm,'').trim();
 log('info','audio_transcribed',{engine:'whisper.cpp',attachment_id:input.slackFileId,queued_ms:queuedMs,convert_ms:convertMs,transcribe_ms:Date.now()-transcribing,queued_behind:lane.length-1,text_chars:text.length});
 if(!text)throw new NoSpeech(`Transcriber returned no text for ${input.title}`);
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
