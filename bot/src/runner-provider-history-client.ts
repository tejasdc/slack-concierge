import {runnerMachineCall} from './runner-machine-calls';
import {createHash} from 'node:crypto';
import {randomUUID} from 'node:crypto';

const PROVIDER_HISTORY_MAX_CHUNK=256*1024;

export type RunnerProviderHistorySource={sourceIdentity:string;snapshotSize:number};
export type RunnerProviderHistoryChunk={source:RunnerProviderHistorySource|null;bytes:Uint8Array;eof:boolean};
export type RunnerProviderHistoryStat={sourceIdentity:string|null;size:number|null;mtimeMs:number|null};

export async function statRunnerClaudeTranscript(input:{runner:string;account:string;sessionUuid:string;cwd:string}):Promise<RunnerProviderHistoryStat>{
  const result=await runnerMachineCall<any>(input.runner,'provider-history.claude.transcript.stat',{
    account:input.account,sessionUuid:input.sessionUuid,cwd:input.cwd});
  if(!result||result.sourceIdentity!==null&&typeof result.sourceIdentity!=='string'
    ||result.sourceIdentity!==null&&!/^[a-f0-9]{64}$/.test(result.sourceIdentity)
    ||result.size!==null&&(!Number.isSafeInteger(result.size)||result.size<0)
    ||result.mtimeMs!==null&&(typeof result.mtimeMs!=='number'||!Number.isFinite(result.mtimeMs)))throw new Error('INVALID_PROVIDER_HISTORY_REPLY');
  return result;
}

/** Reads one exact provider transcript from its runner in bounded chunks; owner paths never cross the relay. */
export async function readRunnerClaudeTranscriptChunk(input:{runner:string;account:string;sessionUuid:string;cwd:string;offset:number;maxBytes:number;source?:RunnerProviderHistorySource}):Promise<RunnerProviderHistoryChunk>{
  const result=await runnerMachineCall<any>(input.runner,'provider-history.claude.transcript.read',{
    account:input.account,sessionUuid:input.sessionUuid,cwd:input.cwd,offset:input.offset,maxBytes:input.maxBytes,
    ...(input.source?{sourceIdentity:input.source.sourceIdentity,snapshotSize:input.source.snapshotSize}:{})});
  if(!result||result.sourceIdentity!==null&&typeof result.sourceIdentity!=='string'
    ||result.sourceIdentity!==null&&!/^[a-f0-9]{64}$/.test(result.sourceIdentity)
    ||result.snapshotSize!==null&&!Number.isSafeInteger(result.snapshotSize)
    ||typeof result.bytes!=='string'||result.bytes.length>400_000||typeof result.eof!=='boolean')
    throw new Error('INVALID_PROVIDER_HISTORY_REPLY');
  const bytes=Buffer.from(result.bytes,'base64');
  if(bytes.toString('base64')!==result.bytes)throw new Error('INVALID_PROVIDER_HISTORY_REPLY');
  return {source:result.sourceIdentity===null?null:{sourceIdentity:result.sourceIdentity,snapshotSize:result.snapshotSize},bytes,eof:result.eof};
}

/** Returns provider timestamps keyed by the exact Codex turn and item identities. */
export async function readRunnerCodexTimestamps(runner:string,account:string,threadId:string,identities:readonly {turnId:string;itemId:string}[]):Promise<Map<string,string|null>>{
  if(identities.length>2_000)throw new Error('INVALID_PROVIDER_HISTORY_IDENTITIES');
  const result=await runnerMachineCall<any>(runner,'provider-history.codex.timestamps',{account,threadId,identities});
  if(!result||result.threadId!==threadId||!Array.isArray(result.timestamps)||result.timestamps.length>500_000)
    throw new Error('INVALID_PROVIDER_HISTORY_REPLY');
  const timestamps=new Map<string,string|null>();
  for(const row of result.timestamps){
    if(!row||!Array.isArray(row.identity)||row.identity.length!==2||row.identity.some((value:unknown)=>typeof value!=='string'||!value)
      ||row.timestamp!==null&&(typeof row.timestamp!=='string'||!Number.isFinite(Date.parse(row.timestamp))))throw new Error('INVALID_PROVIDER_HISTORY_REPLY');
    const key=JSON.stringify(row.identity);
    if(timestamps.has(key))throw new Error('INVALID_PROVIDER_HISTORY_REPLY');
    timestamps.set(key,row.timestamp);
  }
  return timestamps;
}

/** Matches an authored subject against one exact provider conversation. Legacy null-account
 * requests scan registered homes and succeed only when the native UUID has one unique match. */
export async function authoredRunnerProviderSubject(input:{runner:string;provider:'claude-code'|'codex';account:string|null;sessionUuid:string;subject:string;beforeMs:number}):Promise<{timestamp:string|null;resolution:'named'|'unique'|'missing'|'ambiguous'}>{
  const result=await runnerMachineCall<any>(input.runner,'provider-history.authoredSubject',{
    provider:input.provider,account:input.account,sessionUuid:input.sessionUuid,subject:input.subject,beforeMs:input.beforeMs});
  if(!result||!(result.timestamp===null||typeof result.timestamp==='string'&&Number.isFinite(Date.parse(result.timestamp)))
    ||!['named','unique','missing','ambiguous'].includes(result.resolution))throw new Error('INVALID_PROVIDER_HISTORY_REPLY');
  return result;
}

/** Restores one archived provider transcript with an idempotent, bounded three-step transfer. */
export async function restoreRunnerProviderTranscript(input:{runner:string;account:string;provider:'claude-code'|'codex';nativeId:string;cwd:string;name:string;bytes:Uint8Array;restoreId?:string}):Promise<'restored'|'already_present'>{
  if(input.bytes.length<1||input.bytes.length>64*1024*1024)throw new Error('INVALID_PROVIDER_RESTORE_SIZE');
  const restoreId=input.restoreId??randomUUID(),sha256=createHash('sha256').update(input.bytes).digest('hex');
  const begun=await runnerMachineCall<any>(input.runner,'provider-history.restore.begin',{
    restoreId,account:input.account,provider:input.provider,nativeId:input.nativeId,cwd:input.cwd,name:input.name,size:input.bytes.length,sha256});
  if(begun?.state==='already_present')return 'already_present';
  if(begun?.state==='restored')return 'restored';
  if(begun?.state!=='ready'||!Number.isSafeInteger(begun.nextOffset)||begun.nextOffset<0||begun.nextOffset>input.bytes.length)
    throw new Error('INVALID_PROVIDER_RESTORE_REPLY');
  let offset=begun.nextOffset;
  while(offset<input.bytes.length){
    const chunk=input.bytes.subarray(offset,Math.min(input.bytes.length,offset+PROVIDER_HISTORY_MAX_CHUNK));
    const reply=await runnerMachineCall<any>(input.runner,'provider-history.restore.chunk',{
      restoreId,offset,base64:Buffer.from(chunk).toString('base64')});
    if(reply?.nextOffset!==offset+chunk.length)throw new Error('INVALID_PROVIDER_RESTORE_REPLY');
    offset=reply.nextOffset;
  }
  const finished=await runnerMachineCall<any>(input.runner,'provider-history.restore.finish',{restoreId});
  if(finished?.state!=='restored'&&finished?.state!=='already_present')throw new Error('INVALID_PROVIDER_RESTORE_REPLY');
  return finished.state;
}
