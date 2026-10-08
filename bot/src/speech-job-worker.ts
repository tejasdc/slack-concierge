import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdirSync,renameSync,writeFileSync} from 'node:fs';
import {statSync} from 'node:fs';
import {join} from 'node:path';
import {NoSpeech,transcribeAudioPath,type AudioTranscript} from './transcription';
import {log} from './log';
import {finishSpeechJob,markSpeechJobStarted,pendingSpeechJobsAsync,removeAbandonedSpeechStaging,speechJobAudio,speechRoot,speechWorkerHeartbeat,type SpeechJob,type SpeechJobResult} from './speech-job-spool';

// No state or session-owner import: the coordinator alone commits transcripts to SQLite.
const stateDir=process.env.CONCIERGE_STATE_DIR;
if(!stateDir)throw new Error('The speech worker needs its state directory.');
const root=speechRoot(stateDir);
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

export async function processSpeechJob(job:SpeechJob,transcribe:(input:{slackFileId:string;title:string;path:string})=>Promise<AudioTranscript>=transcribeAudioPath){
 let result:SpeechJobResult;
 let verified=false;
 try{
  const digest=createHash('sha256');
  for await(const chunk of createReadStream(speechJobAudio(root,job.attachmentId)))digest.update(chunk);
  if(digest.digest('hex')!==job.sha256)throw new Error('Retained audio checksum changed.');
  verified=true;
  await markSpeechJobStarted(root,job.attachmentId);
  const transcript=await transcribe({slackFileId:job.attachmentId,title:job.name,path:speechJobAudio(root,job.attachmentId)});
  if(typeof transcript.text!=='string'||transcript.text.length>200_000||!['parakeet','apple','whisper.cpp'].includes(transcript.source))throw new Error('Invalid transcription result.');
  result={version:1,attachmentId:job.attachmentId,sha256:job.sha256,kind:'words',text:transcript.text,source:transcript.source as 'parakeet'|'apple'|'whisper.cpp',audioMs:transcript.audioMs??null};
 }catch(error){
  result={version:1,attachmentId:job.attachmentId,sha256:job.sha256,kind:error instanceof NoSpeech?'no-speech':'failed',
   ...(error instanceof NoSpeech?{}:{reason:!verified?'retained_audio_invalid':error instanceof Error&&/exited 127|ENOENT/.test(error.message)?'transcriber_missing':'transcriber_failed'})};
  if(!(error instanceof NoSpeech))log('warn','audio_transcription_failed',{attachment_id:job.attachmentId,reason:result.reason});
 }
 await finishSpeechJob(root,result);
 log('info','speech_job_finished',{attachment_id:job.attachmentId,outcome:result.kind});
}

if(import.meta.main){
 mkdirSync(root,{recursive:true,mode:0o700});
 const healthDirectory='/run/concierge-speech';
 if(process.platform==='linux')try{mkdirSync(healthDirectory,{recursive:true,mode:0o755});}catch{}
 let activeSince:number|null=null;
 let healthWarning=false;
 let healthBusy=false;
 const heartbeat=async()=>{
  if(healthBusy)return;
  healthBusy=true;
  try{
   writeFileSync(speechWorkerHeartbeat(root),String(Date.now()),{mode:0o600});
   if(process.platform==='linux'){
    const now=Date.now(),pending=await pendingSpeechJobsAsync(root),oldest=pending[0]?.createdAt??null;
    const summary={schema:1,pid:process.pid,observedAt:now,pending:pending.length,oldestAgeMs:oldest===null?0:Math.max(0,now-oldest),activeAgeMs:activeSince===null?0:Math.max(0,now-activeSince)};
    const temp=join(healthDirectory,'health.tmp');
    writeFileSync(temp,JSON.stringify(summary),{mode:0o644});
    renameSync(temp,join(healthDirectory,'health.json'));
   }
   healthWarning=false;
  }catch(error){if(!healthWarning)log('warn','speech_health_write_failed',{reason:error instanceof Error?error.message:'unknown'});healthWarning=true;}finally{healthBusy=false;}
 };
 heartbeat();setInterval(heartbeat,1_000);
 void removeAbandonedSpeechStaging(root).catch(()=>{});
 setInterval(()=>void removeAbandonedSpeechStaging(root).catch(()=>{}),60*60_000);
 log('info','speech_worker_ready',{});
 const current='/var/lib/slack-concierge-deployment/current/control/application/speech-job-worker.js';
 const startedFile=process.platform==='linux'?(()=>{try{const file=statSync(current);return {device:file.dev,inode:file.ino};}catch{return null;}})():null;
 for(;;){
  const jobs=await pendingSpeechJobsAsync(root);
  if(jobs.length){activeSince=Date.now();await processSpeechJob(jobs[0]!).catch(async error=>{
   log('error','speech_job_worker_failed',{attachment_id:jobs[0]!.attachmentId,reason:error instanceof Error?error.message:'unknown'});
   await pause(2_000);
  });activeSince=null;}
  else {
   // The unit's ExecStart uses the stable current symlink. Finish the current job, then
   // let systemd restart us on the new release without interrupting someone's dictation.
   if(startedFile){
    try{const file=statSync(current);if(file.dev!==startedFile.device||file.ino!==startedFile.inode)process.exit(0);}catch{}
   }
   await pause(500);
  }
 }
}
