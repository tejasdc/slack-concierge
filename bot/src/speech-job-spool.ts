import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,renameSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

// This is transport custody, not a second transcript store. Only the owner writes the
// canonical attachment row; the independent worker writes a result for the owner to commit.
export type SpeechJob={version:1;attachmentId:string;sha256:string;name:string;contentType:string;createdAt:number};
export type SpeechJobResult={version:1;attachmentId:string;sha256:string;kind:'words';text:string;source:'parakeet'|'apple'|'whisper.cpp';audioMs:number|null}
  |{version:1;attachmentId:string;sha256:string;kind:'no-speech'|'failed';reason?:'transcriber_missing'|'transcriber_failed'};
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function checked(id:string){if(!idPattern.test(id))throw new Error('Invalid attachment custody ID.');return id;}
export function speechRoot(stateDir:string){return join(stateDir,'speech-jobs');}
export function speechWorkerHeartbeat(root:string){return join(root,'worker-heartbeat');}
export function queuedJob(root:string,id:string){return join(root,'queued',checked(id));}
export function finishedJob(root:string,id:string){return join(root,'finished',checked(id));}
export function speechJobPaths(root:string,id:string){return {queued:queuedJob(root,id),finished:finishedJob(root,id)};}
export function speechJobExists(root:string,id:string){const paths=speechJobPaths(root,id);return existsSync(paths.queued)||existsSync(paths.finished);}

export async function stageSpeechJob(root:string,input:{attachmentId:string;sha256:string;name:string;contentType:string;bytes:Uint8Array}){
 const id=checked(input.attachmentId),digest=createHash('sha256').update(input.bytes).digest('hex');
 if(digest!==input.sha256)throw new Error('Retained audio failed verification.');
 await mkdir(join(root,'queued'),{recursive:true,mode:0o700});
 await mkdir(join(root,'finished'),{recursive:true,mode:0o700});
 if(speechJobExists(root,id))return false;
 const staging=join(root,'queued',`.staging-${randomUUID()}`);
 await mkdir(staging,{mode:0o700});
 try{
  const manifest:SpeechJob={version:1,attachmentId:id,sha256:digest,name:input.name,contentType:input.contentType,createdAt:Date.now()};
  await writeFile(join(staging,'audio'),input.bytes,{mode:0o600});
  await writeFile(join(staging,'manifest.json'),JSON.stringify(manifest),{mode:0o600});
  if(speechJobExists(root,id))return false;
  try{await rename(staging,queuedJob(root,id));}
  catch(error){
   // Two starts can both finish staging before either publishes. The winning
   // directory is the durable job; the loser simply joins it.
   if((error as NodeJS.ErrnoException).code&&['EEXIST','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code!)&&speechJobExists(root,id))return false;
   throw error;
  }
  return true;
 }finally{await rm(staging,{recursive:true,force:true});}
}

export function readSpeechJobResult(root:string,id:string):SpeechJobResult|null{
 const file=join(finishedJob(root,id),'result.json');
 if(!existsSync(file))return null;
 const value=JSON.parse(readFileSync(file,'utf8')) as SpeechJobResult;
 if(value.version!==1||value.attachmentId!==id||!['words','no-speech','failed'].includes(value.kind))throw new Error('Speech job result is invalid.');
 if(!/^[a-f0-9]{64}$/.test(value.sha256)||value.kind==='words'&&(typeof value.text!=='string'||value.text.length>200_000||!['parakeet','apple','whisper.cpp'].includes(value.source)))
  throw new Error('Speech job result is invalid.');
 return value;
}
export function speechJobProgress(root:string,id:string,now=Date.now()){
 const complete=readSpeechJobResult(root,id);
 if(complete)return complete.kind==='failed'?{state:'failed' as const,reason:complete.reason??'transcriber_failed'}:{state:'ready' as const};
 const path=queuedJob(root,id);
 if(!existsSync(path))return {state:'idle' as const};
 try{
  const manifest=JSON.parse(readFileSync(join(path,'manifest.json'),'utf8')) as SpeechJob;
  if(manifest.version!==1||manifest.attachmentId!==id||!(/^[a-f0-9]{64}$/.test(manifest.sha256)))
   return {state:'failed' as const,reason:'job_invalid'};
 }catch{return {state:'failed' as const,reason:'job_invalid'};}
 const heartbeat=speechWorkerHeartbeat(root);
 if(now-statSync(path).mtimeMs>10_000&&(!existsSync(heartbeat)||now-statSync(heartbeat).mtimeMs>10_000))
  return {state:'unavailable' as const,reason:'worker_unavailable'};
 const started=join(path,'started.json');
 if(existsSync(started)){
  const value=JSON.parse(readFileSync(started,'utf8')) as {at:number};
  return {state:'transcribing' as const,elapsedMs:Math.max(0,now-value.at)};
 }
 const names=readdirSync(join(root,'queued')).filter(name=>idPattern.test(name)).sort((a,b)=>statSync(join(root,'queued',a)).mtimeMs-statSync(join(root,'queued',b)).mtimeMs);
 return {state:'queued' as const,ahead:Math.max(0,names.indexOf(id)),waitedMs:Math.max(0,now-statSync(path).mtimeMs)};
}
export function pendingSpeechJobs(root:string):SpeechJob[]{
 const directory=join(root,'queued');if(!existsSync(directory))return [];
 return readdirSync(directory).filter(id=>idPattern.test(id)).flatMap(id=>{
  try {const job=JSON.parse(readFileSync(join(directory,id,'manifest.json'),'utf8')) as SpeechJob;
   return job.version===1&&job.attachmentId===id?[job]:[];}catch{return [];} }).sort((a,b)=>a.createdAt-b.createdAt);
}
export function finishedSpeechJobIds(root:string,limit:number):string[]{
 const directory=join(root,'finished');if(!existsSync(directory))return [];
 return readdirSync(directory).filter(id=>idPattern.test(id)).slice(0,limit);
}
export async function markSpeechJobStarted(root:string,id:string){
 await writeFile(join(queuedJob(root,id),'started.json'),JSON.stringify({at:Date.now()}),{mode:0o600});
}
export async function finishSpeechJob(root:string,result:SpeechJobResult){
 const id=checked(result.attachmentId),queued=queuedJob(root,id),finished=finishedJob(root,id);
 if(existsSync(finished))return;
 const temp=join(queued,`result-${randomUUID()}.json`);
 await writeFile(temp,JSON.stringify(result),{mode:0o600});
 await rename(temp,join(queued,'result.json'));
 await rename(queued,finished);
}
export async function removeFinishedSpeechJob(root:string,id:string){await rm(finishedJob(root,id),{recursive:true,force:true});}
export async function removeAbandonedSpeechStaging(root:string,now=Date.now()){
 const directory=join(root,'queued');if(!existsSync(directory))return 0;
 let removed=0;
 for(const name of readdirSync(directory)){
  if(!/^\.staging-[0-9a-f-]{36}$/i.test(name))continue;
  const path=join(directory,name);
  if(now-statSync(path).mtimeMs<60*60_000)continue;
  await rm(path,{recursive:true,force:true});removed++;
 }
 return removed;
}
export function speechJobAudio(root:string,id:string){return join(queuedJob(root,id),'audio');}
