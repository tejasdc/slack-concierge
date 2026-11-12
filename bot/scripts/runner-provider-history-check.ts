import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,stat,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {serveProviderHistoryCall} from '../src/runner-provider-history';

const root=await mkdtemp(join(tmpdir(),'provider-history-check-'));
const home=join(root,'claude-home'),secondHome=join(root,'claude-home-second'),state=join(root,'runner-state'),cwd='/workspace/example';
const sessionUuid='0192a345-6789-7abc-8def-0123456789ab';
const account='tejas@example.test';
const resolveHome=(provider:string,label:string)=>provider==='claude-code'&&label===account?home:null;
const resolveHomes=(provider:string)=>provider==='claude-code'?[{account,home},{account:'other@example.test',home:secondHome}]:[];
const call=(method:string,params:any)=>serveProviderHistoryCall(method,params,resolveHome as any,state,resolveHomes as any);
try{
  const source=join(home,'projects',cwd.replace(/[^a-zA-Z0-9]/g,'-'),`${sessionUuid}.jsonl`);
  await mkdir(join(source,'..'),{recursive:true});
  await mkdir(secondHome,{recursive:true});await symlink(join(home,'projects'),join(secondHome,'projects'));
  const transcript=Buffer.from(`${JSON.stringify({type:'user',uuid:'source-1',message:{role:'user',content:'preserve this exact source'}})}\n`);
  await Bun.write(source,transcript);
  const metadata=await call('provider-history.claude.transcript.stat',{account,sessionUuid,cwd}) as any;
  if(metadata.size!==transcript.length||!metadata.sourceIdentity)throw new Error('stat did not identify exact transcript');
  const chunk=await call('provider-history.claude.transcript.read',{account,sessionUuid,cwd,offset:0,maxBytes:64,sourceIdentity:metadata.sourceIdentity,snapshotSize:metadata.size}) as any;
  if(Buffer.from(chunk.bytes,'base64').length!==64||chunk.eof)throw new Error('bounded transcript read failed');
  let changed=false;
  try{await call('provider-history.claude.transcript.read',{account,sessionUuid,cwd,offset:0,maxBytes:64,sourceIdentity:'0'.repeat(64),snapshotSize:metadata.size});}catch(error){changed=(error as Error).message==='PROVIDER_TRANSCRIPT_CHANGED';}
  if(!changed)throw new Error('changed source identity was accepted');

  const restoreId=randomUUID(),restoreUuid='0192a345-6789-7abc-8def-112233445566';
  const restored=Buffer.from(`${JSON.stringify({type:'user',uuid:'archive-1',sessionId:restoreUuid,message:{role:'user',content:'archived exact material'}})}\n`);
  const sha256=createHash('sha256').update(restored).digest('hex');
  let result=await call('provider-history.restore.begin',{restoreId,provider:'claude-code',account,nativeId:restoreUuid,cwd,name:`${restoreUuid}.jsonl`,size:restored.length,sha256}) as any;
  if(result.state!=='ready'||result.nextOffset!==0)throw new Error('restore did not begin');
  const half=Math.floor(restored.length/2);
  for(const [offset,bytes] of [[0,restored.subarray(0,half)],[half,restored.subarray(half)]] as [number,Buffer][]){
    const base64=bytes.toString('base64');
    const wrote=await call('provider-history.restore.chunk',{restoreId,offset,base64}) as any;
    if(wrote.nextOffset!==offset+bytes.length)throw new Error('restore chunk offset mismatch');
    const replay=await call('provider-history.restore.chunk',{restoreId,offset,base64}) as any;
    if(replay.nextOffset!==offset+bytes.length)throw new Error('idempotent replay failed');
  }
  result=await call('provider-history.restore.finish',{restoreId}) as any;
  const destination=join(home,'projects',cwd.replace(/[^a-zA-Z0-9]/g,'-'),`${restoreUuid}.jsonl`);
  if(result.state!=='restored'||!((await readFile(destination)).equals(restored)))throw new Error('restored bytes changed');
  if((await stat(destination)).size!==restored.length)throw new Error('restored size mismatch');
  result=await call('provider-history.restore.finish',{restoreId}) as any;
  if(result.state!=='restored')throw new Error('finish retry was not idempotent');
  const badId=randomUUID();
  let conflict=false;
  try{await call('provider-history.restore.begin',{restoreId:badId,provider:'claude-code',account,nativeId:restoreUuid,cwd,name:`${restoreUuid}.jsonl`,size:restored.length,sha256:'0'.repeat(64)});}catch(error){conflict=(error as Error).message==='PROVIDER_RESTORE_DESTINATION_CONFLICT';}
  if(!conflict)throw new Error('restore overwrote a destination');

  const authoredId='0192a345-6789-7abc-8def-223344556677';
  const authored=join(home,'projects',cwd.replace(/[^a-zA-Z0-9]/g,'-'),`${authoredId}.jsonl`);
  await Bun.write(authored,`${JSON.stringify({type:'assistant',timestamp:new Date(1000).toISOString(),message:{content:[{type:'text',text:'the exact authored phrase is here'}]}})}\n`);
  const match=await call('provider-history.authoredSubject',{provider:'claude-code',account:null,sessionUuid:authoredId,subject:'the exact authored phrase is here',beforeMs:2000}) as any;
  if(match.resolution!=='unique'||match.timestamp!==new Date(1000).toISOString())throw new Error('shared symlink legacy authored subject should resolve one physical content source');
  console.log('runner provider history bounded reads, identity fencing, exact-byte restore/retry, no-overwrite, and unique legacy match passed');
}finally{await rm(root,{recursive:true,force:true});}
