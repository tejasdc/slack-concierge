import {test,expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {SessionOwner} from '../src/session-owner';
import {db} from '../src/state';
import {NoSpeech} from '../src/transcription';
import {processSpeechJob} from '../src/speech-job-worker';
import {pendingSpeechJobs,speechRoot} from '../src/speech-job-spool';
import {join} from 'node:path';
import {mkdir,writeFile,mkdtemp,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {speechJobAudio,speechJobProgress,finishedSpeechJobIds} from '../src/speech-job-spool';

const owner=()=>new SessionOwner({wake:()=>{},steer:()=>false,stop:async()=>false,available:()=>true},'/tmp');
const root=speechRoot(process.env.CONCIERGE_STATE_DIR!);
function attachment(value:string){
 const audio=Buffer.from(value);
 return owner().upload({clientActionId:randomUUID(),name:'recording.webm',contentType:'audio/webm',base64:audio.toString('base64')}).attachment.id;
}

test('a finished independent job is committed by a new owner and duplicate start rejoins it',async()=>{
 const id=attachment('synthetic audio');
 const first=owner();
 expect((await first.transcribeAttachment(id,{},true)).state).toBe('queued');
 expect((await first.transcribeAttachment(id,{},true)).state).toBe('queued');
 expect(pendingSpeechJobs(root).filter(job=>job.attachmentId===id)).toHaveLength(1);
 const job=pendingSpeechJobs(root).find(job=>job.attachmentId===id)!;
 await processSpeechJob(job,async input=>({slackFileId:input.slackFileId,title:input.title,text:'recognized words',source:'parakeet',audioMs:123}));
 // The first owner can disappear: a fresh owner reads the result artifact and commits it once.
 const recovered=owner();
 expect(recovered.transcriptionState(id)).toEqual({state:'done',text:'recognized words'});
 expect((db.query('SELECT transcript_text,transcript_source FROM session_attachments WHERE id=?').get(id) as any))
  .toMatchObject({transcript_text:'recognized words',transcript_source:'server'});
 expect(await recovered.transcribeAttachment(id,{},false)).toEqual({text:'recognized words'});
});

test('concurrent starts publish one job and both callers retain the same custody ID',async()=>{
 const id=attachment('concurrent synthetic audio');
 const [first,second]=await Promise.all([owner().transcribeAttachment(id,{},true),owner().transcribeAttachment(id,{},true)]);
 expect(first.state).toBe('queued');
 expect(second.state).toBe('queued');
 expect(pendingSpeechJobs(root).filter(job=>job.attachmentId===id)).toHaveLength(1);
});

test('a separate worker process can finish while the owner is reconstructed',async()=>{
 const id=attachment('separate-process synthetic audio');
 const original=owner();
 expect((await original.transcribeAttachment(id,{},true)).state).toBe('queued');
 const child=Bun.spawn([process.execPath,'run',join(import.meta.dir,'fixtures/speech-job-child.ts'),id],{
  env:{...process.env,CONCIERGE_STATE_DIR:process.env.CONCIERGE_STATE_DIR!},stdout:'pipe',stderr:'pipe',
 });
 const exit=await child.exited;
 expect(exit).toBe(0);
 const recovered=owner();
 expect(recovered.transcriptionState(id)).toEqual({state:'done',text:'words from separate worker process'});
 expect((await recovered.transcribeAttachment(id,{},true)).state).toBe('done');
});

test('silence is terminal, and a later device transcript remains authoritative',async()=>{
 const id=attachment('silence');const first=owner();
 await first.transcribeAttachment(id,{},true);
 const job=pendingSpeechJobs(root).find(job=>job.attachmentId===id)!;
 await processSpeechJob(job,async()=>{throw new NoSpeech('silence');});
 expect(owner().transcriptionState(id)).toEqual({state:'no-speech',text:''});
 expect(await owner().transcribeAttachment(id,{},false)).toEqual({text:''});
 const device=await owner().transcribeAttachment(id,{text:'spoken on phone',engine:'apple',engineVersion:'1',durationMs:500});
 expect(device).toEqual({text:'spoken on phone'});
 expect(owner().transcriptionState(id)).toEqual({state:'done',text:'spoken on phone'});
});

test('worker failure is explicit and does not auto-run a duplicate job',async()=>{
 const id=attachment('failure');const first=owner();
 await first.transcribeAttachment(id,{},true);
 const job=pendingSpeechJobs(root).find(job=>job.attachmentId===id)!;
 await processSpeechJob(job,async()=>{throw new Error('engine stopped');});
 expect(owner().transcriptionState(id)).toEqual({state:'failed',reason:'transcriber_failed'});
 expect((await owner().transcribeAttachment(id,{},true)).state).toBe('failed');
 expect(pendingSpeechJobs(root).filter(item=>item.attachmentId===id)).toHaveLength(0);
});

test('HTTP start acknowledges custody before speech and status later returns words',async()=>{
 const id=attachment('route audio'),service=owner();
 const url=`http://127.0.0.1/sessions/v1/attachments/${id}/transcription`;
 const started=await service.handle(new Request(url+'/start',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}));
 expect(started?.status).toBe(202);
 expect((await started!.json()).state).toBe('queued');
 const job=pendingSpeechJobs(root).find(job=>job.attachmentId===id)!;
 await processSpeechJob(job,async input=>({slackFileId:input.slackFileId,title:input.title,text:'route words',source:'parakeet'}));
 const done=await service.handle(new Request(url));
 expect(done?.status).toBe(200);
 expect(await done!.json()).toEqual({state:'done',text:'route words'});
});

test('corrupt oldest audio is terminal and a later recording can finish',async()=>{
 const bad=attachment('original'),good=attachment('later');
 await owner().transcribeAttachment(bad,{},true);
 await owner().transcribeAttachment(good,{},true);
 await writeFile(speechJobAudio(root,bad),'changed bytes');
 let invoked=false;
 await processSpeechJob(pendingSpeechJobs(root).find(job=>job.attachmentId===bad)!,async()=>{invoked=true;throw new Error('must not invoke');});
 expect(invoked).toBe(false);
 expect(owner().transcriptionState(bad)).toEqual({state:'failed',reason:'retained_audio_invalid'});
 expect(pendingSpeechJobs(root).some(job=>job.attachmentId===bad)).toBe(false);
 await processSpeechJob(pendingSpeechJobs(root).find(job=>job.attachmentId===good)!,async input=>({slackFileId:input.slackFileId,title:input.title,text:'later words',source:'parakeet'}));
 expect(owner().transcriptionState(good)).toEqual({state:'done',text:'later words'});
});

test('per-recording progress does not enumerate unrelated queued custody',async()=>{
 const id=attachment('fixed lookup');await owner().transcribeAttachment(id,{},true);
 const unrelated=join(root,'queued',randomUUID());
 await symlink('/nonexistent-speech-test-path',unrelated);
 try{expect(speechJobProgress(root,id).state).toBe('queued');}finally{await rm(unrelated);}
});

test('finished reconciliation pages rotate past unreadable results',async()=>{
 const scratch=await mkdtemp(join(tmpdir(),'speech-reconcile-'));
 try{const ids=Array.from({length:97},()=>randomUUID());
  await Promise.all(ids.map(id=>mkdir(join(scratch,'finished',id),{recursive:true})));
  const found=new Set<string>();
  for(let page=0;page<15;page++){const batch=finishedSpeechJobIds(scratch,8);expect(batch.length).toBeLessThanOrEqual(8);batch.forEach(id=>found.add(id));}
  expect(found.size).toBe(ids.length);
 }finally{await rm(scratch,{recursive:true,force:true});}
});
