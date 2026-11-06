import {runnerMachineCall} from './runner-machine-calls';

export type RemoteUsageRecord={sourceId:string;recordId:string;provider:'claude-code'|'codex';conversation:string;helper:boolean;atMs:number;model:string|null;
  input:number;cacheWrite:number;cacheWrite1h:number;cacheRead:number;output:number;providerTurnId:string|null;clientVersion:string|null;
  sourceAccount:string|null;parentThreadId:string|null;firstUsage:boolean;boundaries:number[]};
export type UsageRunnerCall=(runner:string,method:string,params:Record<string,unknown>,timeoutMs:number)=>Promise<any>;

/** Collects one runner's fixed-window snapshot before the caller changes its cached report rows. */
export async function collectRunnerUsageRecords(runner:string,providers:('claude-code'|'codex')[],sinceMs:number,
  call:UsageRunnerCall=runnerMachineCall):Promise<RemoteUsageRecord[]>{
  const records:RemoteUsageRecord[]=[],identities=new Set<string>();
  let cursor:string|null=null,snapshot:number|null=null,pages=0,totalBytes=0;
  for(;;){
    if(++pages>1000)throw new Error('PROVIDER_USAGE_BREAKDOWN_PAGE_LIMIT');
    const result=await call(runner,'provider-usage-breakdown.page',{cursor,limit:100,providers,sinceMs},120_000);
    if(!result||!Number.isSafeInteger(result.snapshotMaxRowid)||result.snapshotMaxRowid<0||!Array.isArray(result.records)||result.records.length>100
      ||result.nextCursor!==null&&typeof result.nextCursor!=='string')throw new Error('INVALID_PROVIDER_USAGE_BREAKDOWN_REPLY');
    if(snapshot===null)snapshot=result.snapshotMaxRowid;
    else if(snapshot!==result.snapshotMaxRowid)throw new Error('PROVIDER_USAGE_BREAKDOWN_SNAPSHOT_CHANGED');
    totalBytes+=Buffer.byteLength(JSON.stringify(result));
    if(totalBytes>64*1024*1024||records.length+result.records.length>100_000)throw new Error('PROVIDER_USAGE_BREAKDOWN_TRANSFER_LIMIT');
    for(const row of result.records as RemoteUsageRecord[]){
      if(!row||! /^[a-f0-9]{64}$/.test(row.sourceId)||typeof row.recordId!=='string'||!row.recordId||row.recordId.length>512
        ||!providers.includes(row.provider)||typeof row.conversation!=='string'||!row.conversation||row.conversation.length>512||typeof row.helper!=='boolean'
        ||!Number.isSafeInteger(row.atMs)||row.atMs<0||row.model!==null&&typeof row.model!=='string'
        ||typeof row.model==='string'&&row.model.length>256
        ||['input','cacheWrite','cacheWrite1h','cacheRead','output'].some(key=>!Number.isFinite((row as any)[key])||(row as any)[key]<0)
        ||row.providerTurnId!==null&&(typeof row.providerTurnId!=='string'||row.providerTurnId.length>512)
        ||row.clientVersion!==null&&(typeof row.clientVersion!=='string'||row.clientVersion.length>256)
        ||row.sourceAccount!==null&&(typeof row.sourceAccount!=='string'||row.sourceAccount.length>320)
        ||row.parentThreadId!==null&&(typeof row.parentThreadId!=='string'||row.parentThreadId.length>512)
        ||typeof row.firstUsage!=='boolean'||!Array.isArray(row.boundaries)||row.boundaries.length>1000
        ||row.boundaries.some(value=>!Number.isSafeInteger(value)||value<0))throw new Error('INVALID_PROVIDER_USAGE_BREAKDOWN_RECORD');
      const identity=`${row.sourceId}:${row.recordId}`;if(identities.has(identity))throw new Error('DUPLICATE_PROVIDER_USAGE_BREAKDOWN_RECORD');identities.add(identity);
      records.push(row);
    }
    const next=result.nextCursor as string|null;
    if(next===null)break;
    if(next===cursor)throw new Error('PROVIDER_USAGE_BREAKDOWN_CURSOR_STALLED');
    cursor=next;
  }
  return records;
}
