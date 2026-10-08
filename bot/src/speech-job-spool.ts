import {createHash,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,statSync,opendirSync,type Dir} from 'node:fs';
import {mkdir,rename,rm,writeFile,open,opendir,readFile,stat} from 'node:fs/promises';
import {join,dirname} from 'node:path';

// This is transport custody, not a second transcript store. Only the owner writes the
// canonical attachment row; the independent worker writes a result for the owner to commit.
export type SpeechJob={version:1;attachmentId:string;sha256:string;name:string;contentType:string;createdAt:number};
export type SpeechJobResult={version:1;attachmentId:string;sha256:string;kind:'words';text:string;source:'parakeet'|'apple'|'whisper.cpp';audioMs:number|null}
  |{version:1;attachmentId:string;sha256:string;kind:'no-speech'|'failed';reason?:'transcriber_missing'|'transcriber_failed'|'retained_audio_invalid'};
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function syncDirectory(path:string){const file=await open(path,'r');try{await file.sync();}finally{await file.close();}}
async function syncCustody(root:string){await syncDirectory(join(root,'queued'));await syncDirectory(join(root,'finished'));await syncDirectory(root);await syncDirectory(dirname(root));}
function readSmallJson(path:string,maximum:number):unknown{if(statSync(path).size>maximum)throw new Error('Speech custody metadata is too large.');return JSON.parse(readFileSync(path,'utf8'));}
async function durableFile(path:string,value:string|Uint8Array){const file=await open(path,'wx',0o600);try{await file.writeFile(value);await file.sync();}finally{await file.close();}}
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
 if(speechJobExists(root,id)){await syncCustody(root);return false;}
 const staging=join(root,'queued',`.staging-${randomUUID()}`);
 await mkdir(staging,{mode:0o700});
 try{
  const manifest:SpeechJob={version:1,attachmentId:id,sha256:digest,name:input.name.slice(0,2048),contentType:input.contentType.slice(0,256),createdAt:Date.now()};
  await durableFile(join(staging,'audio'),input.bytes);
  await durableFile(join(staging,'manifest.json'),JSON.stringify(manifest));
  await syncDirectory(staging);
  if(speechJobExists(root,id)){await syncCustody(root);return false;}
  try{await rename(staging,queuedJob(root,id));}
  catch(error){
   // Two starts can both finish staging before either publishes. The winning
   // directory is the durable job; the loser simply joins it.
   if((error as NodeJS.ErrnoException).code&&['EEXIST','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code!)&&speechJobExists(root,id)){await syncCustody(root);return false;}
   throw error;
  }
  await syncCustody(root);
  return true;
 }finally{await rm(staging,{recursive:true,force:true});}
}

export function readSpeechJobResult(root:string,id:string):SpeechJobResult|null{
 const file=join(finishedJob(root,id),'result.json');
 if(!existsSync(file))return null;
 const value=readSmallJson(file,1_300_000) as SpeechJobResult;
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
  const manifest=readSmallJson(join(path,'manifest.json'),16_384) as SpeechJob;
  if(manifest.version!==1||manifest.attachmentId!==id||!(/^[a-f0-9]{64}$/.test(manifest.sha256)))
   return {state:'failed' as const,reason:'job_invalid'};
 }catch{return {state:'failed' as const,reason:'job_invalid'};}
 const heartbeat=speechWorkerHeartbeat(root);
 if(now-statSync(path).mtimeMs>10_000&&(!existsSync(heartbeat)||now-statSync(heartbeat).mtimeMs>10_000))
  return {state:'unavailable' as const,reason:'worker_unavailable'};
 const started=join(path,'started.json');
 if(existsSync(started)){
  const value=readSmallJson(started,256) as {at:number};
  return {state:'transcribing' as const,elapsedMs:Math.max(0,now-value.at)};
 }
 return {state:'queued' as const,waitedMs:Math.max(0,now-statSync(path).mtimeMs)};
}
export function pendingSpeechJobs(root:string):SpeechJob[]{
 const directory=join(root,'queued');if(!existsSync(directory))return [];
 return readdirSync(directory).filter(id=>idPattern.test(id)).flatMap(id=>{
  try {const job=readSmallJson(join(directory,id,'manifest.json'),16_384) as SpeechJob;
   return job.version===1&&job.attachmentId===id&&/^[a-f0-9]{64}$/.test(job.sha256)&&typeof job.name==='string'&&Number.isFinite(job.createdAt)?[job]:[];}catch{return [];} }).sort((a,b)=>a.createdAt-b.createdAt);
}
// Worker-only scan: pending custody, never finished history, and no synchronous I/O on its heartbeat.
export async function pendingSpeechJobsAsync(root:string):Promise<SpeechJob[]>{
 const directory=join(root,'queued');
 if(!existsSync(directory))return [];
 const jobs:SpeechJob[]=[];
 for await(const entry of await opendir(directory)){
  if(!entry.isDirectory()||!idPattern.test(entry.name))continue;
  try{const path=join(directory,entry.name,'manifest.json');if((await stat(path)).size>16_384)continue;
   const job=JSON.parse(await readFile(path,'utf8')) as SpeechJob;
   if(job.version===1&&job.attachmentId===entry.name&&/^[a-f0-9]{64}$/.test(job.sha256)&&typeof job.name==='string'&&Number.isFinite(job.createdAt))jobs.push(job);
  }catch{}
 }
 return jobs.sort((a,b)=>a.createdAt-b.createdAt);
}
// One retained iterator per spool gives bounded pages and rotates past an unreadable result.
const finishedReaders=new Map<string,Dir>();
export function finishedSpeechJobIds(root:string,limit:number):string[]{
 const directory=join(root,'finished');
 if(!Number.isInteger(limit)||limit<1||limit>256)throw new Error('Invalid speech reconciliation page.');
 if(!existsSync(directory))return [];
 let reader=finishedReaders.get(root);
 if(!reader){reader=opendirSync(directory,{bufferSize:1});finishedReaders.set(root,reader);}
 const ids:string[]=[];
 try{for(let read=0;read<limit;read++){const entry=reader.readSync();if(!entry){reader.closeSync();finishedReaders.delete(root);break;}if(entry.isDirectory()&&idPattern.test(entry.name))ids.push(entry.name);}}
 catch(error){reader.closeSync();finishedReaders.delete(root);throw error;}
 return ids;
}
export async function markSpeechJobStarted(root:string,id:string){
 const path=queuedJob(root,id),temporary=join(path,`started-${randomUUID()}.json`);
 await writeFile(temporary,JSON.stringify({at:Date.now()}),{mode:0o600});
 await rename(temporary,join(path,'started.json'));
}
export async function finishSpeechJob(root:string,result:SpeechJobResult){
 const id=checked(result.attachmentId),queued=queuedJob(root,id),finished=finishedJob(root,id);
 if(existsSync(finished)){await syncDirectory(join(root,'finished'));return;}
 const temp=join(queued,`result-${randomUUID()}.json`);
 await durableFile(temp,JSON.stringify(result));
 await rename(temp,join(queued,'result.json'));
 await syncDirectory(queued);
 await rename(queued,finished);
 await syncDirectory(join(root,'finished'));
 await syncDirectory(join(root,'queued'));
}
export async function removeFinishedSpeechJob(root:string,id:string){await rm(finishedJob(root,id),{recursive:true,force:true});await syncDirectory(join(root,'finished'));}
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
