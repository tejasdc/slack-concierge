/** Applies canonical owner message events to one derived provider-history snapshot. */
import { Database } from "bun:sqlite";
import { open, stat, readFile, writeFile, rename } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { writeLogLine } from "./log";

type Meta = { session_uuid:string;source_path:string;event_cutoff:number;generation:string;verified_source_size:number;
  verified_source_mtime_ms:number;verified_tail_uuid:string|null };

async function verifyTail(cache:Database,state:Database,sessionId:number,meta:Meta):Promise<{size:number;mtimeMs:number;tailUuid:string|null;covered:boolean}> {
  const file = await stat(meta.source_path);
  const failure = {size:meta.verified_source_size,mtimeMs:meta.verified_source_mtime_ms,
    tailUuid:meta.verified_tail_uuid,covered:false};
  if (file.size < meta.verified_source_size) return failure;
  if (file.size===meta.verified_source_size) return {size:file.size,mtimeMs:file.mtimeMs,
    tailUuid:meta.verified_tail_uuid,covered:file.mtimeMs===meta.verified_source_mtime_ms};
  const handle = await open(meta.source_path,"r");
  try {
    let parent=meta.verified_tail_uuid;
    let offset=meta.verified_source_size;
    let pending="";
    const decoder=new StringDecoder("utf8");
    const baseline=cache.query("SELECT 1 FROM message_ids WHERE id=? LIMIT 1");
    const retained=state.query(`SELECT 1 FROM session_owner_events WHERE session_id=? AND kind='message'
      AND sequence>? AND json_extract(payload_json,'$.message.id')=? LIMIT 1`);
    const known=(id:string)=>typeof id==="string" && (!!baseline.get(id) || !!retained.get(sessionId,meta.event_cutoff,id));
    while(offset<file.size) {
      const bytes=Buffer.alloc(Math.min(1024*1024,file.size-offset));
      const read=await handle.read(bytes,0,bytes.length,offset);
      if(!read.bytesRead)return failure;
      offset+=read.bytesRead;
      pending+=decoder.write(bytes.subarray(0,read.bytesRead));
      const lines=pending.split("\n");
      pending=lines.pop() || "";
      if(pending.length>32*1024*1024)return failure;
      for(const line of lines) {
        if(!line)continue;
        let row:Record<string,any>;
        try {row=JSON.parse(line);} catch{return failure;}
        if(row.isCompactSummary===true || row.type==="summary" || row.subtype==="compact_boundary")return failure;
        if(typeof row.uuid==="string" && row.uuid) {
          if(parent && typeof row.parentUuid==="string" && row.parentUuid && row.parentUuid!==parent)return failure;
          parent=row.uuid;
        }
        if((row.type==="user" || row.type==="assistant") && row.isSidechain!==true && row.isMeta!==true && row.parent_tool_use_id==null) {
          const parts=Array.isArray(row.message?.content)?row.message.content:[];
          const text=typeof row.message?.content==="string" || parts.some((part:any)=>part?.type==="text");
          if(text && (typeof row.uuid!=="string" || !known(row.uuid)))return failure;
          if(parts.some((part:any)=>(part?.type==="tool_use" || part?.type==="tool_result") &&
            !known(part.type==="tool_result"?`${part.tool_use_id}:result`:part.id)))return failure;
        }
        if(row.type==="attachment" && row.attachment?.type==="queued_command") {
          const id=row.attachment.source_uuid || row.uuid;
          if(typeof id!=="string" || !known(id))return failure;
        }
      }
    }
    if(pending || decoder.end())return failure;
    return {size:file.size,mtimeMs:file.mtimeMs,tailUuid:parent,covered:true};
  } finally { await handle.close(); }
}

async function main() {
  const [cachePath,statePath,sessionText,uuid] = process.argv.slice(2);
  const sessionId=Number(sessionText);
  if(!cachePath || !statePath || !uuid || !Number.isSafeInteger(sessionId) || sessionId<1) throw new Error("INVALID_HISTORY_SYNC");
  const state=new Database(statePath,{readonly:true,strict:true});
  const cache=new Database(cachePath,{readonly:true,strict:true});
  try {
    const meta=cache.query("SELECT * FROM meta").get() as Meta|null;
    if(!meta || meta.session_uuid!==uuid) throw new Error("STALE_HISTORY_CACHE");
    const statusPath=cachePath+".verified.json";
    let checkpoint:Partial<Meta>={};
    try {
      const saved=JSON.parse(await readFile(statusPath,"utf8"));
      if(saved.generation===meta.generation)checkpoint=saved;
    } catch { /* Missing or incomplete status: start from the immutable import position. */ }
    const fresh=await verifyTail(cache,state,sessionId,{...meta,...checkpoint});
    const next={generation:meta.generation,verified_source_size:fresh.size,
      verified_source_mtime_ms:fresh.mtimeMs,verified_tail_uuid:fresh.tailUuid,needs_reimport:fresh.covered?0:1};
    const temporary=statusPath+`.${process.pid}.next`;
    await writeFile(temporary,JSON.stringify(next),{mode:0o600});
    await rename(temporary,statusPath);
  } finally {cache.close();state.close();}
}
main().catch(error=>{writeLogLine("error",error instanceof Error?error.message:"HISTORY_SYNC_FAILED");process.exitCode=1;});
