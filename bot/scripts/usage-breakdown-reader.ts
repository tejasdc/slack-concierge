#!/usr/bin/env bun
import {Database} from 'bun:sqlite';
import {closeSync,createReadStream,existsSync,mkdirSync,openSync,readFileSync,readSync,readdirSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {jsonLines} from '../src/json-lines';

type Counts={input:number;cacheWrite:number;cacheWrite1h:number;cacheRead:number;output:number};
type FileRow={offset:number;size:number;mtime:number;total_json:string};
const home=homedir();
const state=process.env.CONCIERGE_STATE_DIR??join(home,'.local/state/concierge');
const ledgerPath=process.env.USAGE_BREAKDOWN_LEDGER??join(state,'state.db');
const cachePath=process.env.USAGE_BREAKDOWN_CACHE??join(state,'usage-breakdown.db');
const claudeRoot=process.env.USAGE_BREAKDOWN_CLAUDE_ROOT??join(home,'.claude/projects');
const codexRoots=[process.env.USAGE_BREAKDOWN_CODEX_ROOT??join(home,'.codex/sessions'),join(home,'.codex-accounts')];
const empty=():Counts=>({input:0,cacheWrite:0,cacheWrite1h:0,cacheRead:0,output:0});
const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?Math.max(0,v):0;
const stamp=(v:unknown)=>typeof v==='string'?Date.parse(v):NaN;
const oneWeekAgo=Date.now()-7*86400_000;
const ledger=new Database(ledgerPath,{readonly:true});
mkdirSync(dirname(cachePath),{recursive:true});
const cache=new Database(cachePath);
cache.exec(`PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,offset INTEGER NOT NULL,size INTEGER NOT NULL,mtime INTEGER NOT NULL,total_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS records(path TEXT NOT NULL,record_id TEXT NOT NULL,provider TEXT NOT NULL,conversation TEXT NOT NULL,
   helper INTEGER NOT NULL,at_ms INTEGER NOT NULL,model TEXT, input INTEGER NOT NULL,cache_write INTEGER NOT NULL,
   cache_write_1h INTEGER NOT NULL,cache_read INTEGER NOT NULL,output INTEGER NOT NULL,PRIMARY KEY(path,record_id));
 CREATE INDEX IF NOT EXISTS records_recent ON records(at_ms);
 CREATE TABLE IF NOT EXISTS cache_boundaries(path TEXT NOT NULL,at_ms INTEGER NOT NULL,kind TEXT NOT NULL,
   PRIMARY KEY(path,at_ms,kind));
 CREATE INDEX IF NOT EXISTS cache_boundaries_recent ON cache_boundaries(at_ms);`);
if(!cache.query('PRAGMA table_info(records)').all().some((column:any)=>column.name==='provider_turn_id'))
  cache.exec('ALTER TABLE records ADD COLUMN provider_turn_id TEXT');
if(!cache.query('PRAGMA table_info(records)').all().some((column:any)=>column.name==='client_version'))
  cache.exec('ALTER TABLE records ADD COLUMN client_version TEXT');
function* walk(root:string):Generator<string>{
  if(!existsSync(root))return;
  const dirs=[root];
  while(dirs.length){
    const dir=dirs.pop()!;
    for(const item of readdirSync(dir,{withFileTypes:true})){
      const path=join(dir,item.name);
      if(item.isDirectory())dirs.push(path);
      else if(item.isFile()&&item.name.endsWith('.jsonl'))yield path;
    }
  }
}
function countsClaude(u:any):Counts{return {input:number(u.input_tokens),cacheWrite:number(u.cache_creation_input_tokens)-number(u.cache_creation?.ephemeral_1h_input_tokens),cacheWrite1h:number(u.cache_creation?.ephemeral_1h_input_tokens),cacheRead:number(u.cache_read_input_tokens),output:number(u.output_tokens)};}
function countsCodex(u:any):Counts{return {input:Math.max(0,number(u.input_tokens)-number(u.cached_input_tokens)-number(u.cache_write_input_tokens)),cacheWrite:number(u.cache_write_input_tokens),cacheWrite1h:0,cacheRead:number(u.cached_input_tokens),output:number(u.output_tokens)};}
function insert(path:string,id:string,provider:string,conversation:string,helper:boolean,at:number,model:string|null,c:Counts,providerTurnId:string|null,clientVersion:string|null){
  if(at<oneWeekAgo||at>Date.now()+60000)return;
  cache.query(`INSERT OR IGNORE INTO records
    (path,record_id,provider,conversation,helper,at_ms,model,input,cache_write,cache_write_1h,cache_read,output,provider_turn_id,client_version)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(path,id,provider,conversation,helper?1:0,at,model,c.input,c.cacheWrite,c.cacheWrite1h,c.cacheRead,c.output,providerTurnId,clientVersion);
}
async function scan(path:string,provider:'claude-code'|'codex'){
  const stat=statSync(path), prior=cache.query('SELECT * FROM files WHERE path=?').get(path) as FileRow|null;
  if(prior&&prior.size===stat.size&&prior.mtime===stat.mtimeMs
    &&(JSON.parse(prior.total_json) as {schemaVersion?:number}).schemaVersion===3)return;
  // An old file cannot add a row to the one-week report. Retire its old cursor
  // without rereading archived transcript bytes during the format upgrade.
  if(stat.mtimeMs<oneWeekAgo){
    if(prior){
      cache.query('DELETE FROM records WHERE path=?').run(path);
      cache.query('DELETE FROM cache_boundaries WHERE path=?').run(path);
      cache.query('UPDATE files SET offset=?,size=?,mtime=?,total_json=? WHERE path=?')
        .run(prior.offset,stat.size,stat.mtimeMs,
          JSON.stringify({...JSON.parse(prior.total_json),schemaVersion:3}),path);
    }
    return;
  }
  let offset=prior&&prior.size<=stat.size?prior.offset:0;
  if(prior&&prior.size>stat.size){cache.query('DELETE FROM records WHERE path=?').run(path);cache.query('DELETE FROM cache_boundaries WHERE path=?').run(path);offset=0;}
  let previous:any=prior&&offset?JSON.parse(prior.total_json):null;
  // Rebuild older cursors once: Claude needs the first response and compaction markers,
  // while Codex needs native per-response usage rather than cumulative event deltas.
  if(previous?.schemaVersion!==3){
    cache.query('DELETE FROM records WHERE path=?').run(path);
    cache.query('DELETE FROM cache_boundaries WHERE path=?').run(path);
    offset=0;previous=null;
  }
  let total:Counts=previous?.counts??empty(),model:string|null=previous?.model??null;
  let providerTurnId:string|null=previous?.providerTurnId??null;
  let firstUsageId:string|null=previous?.firstUsageId??null;
  let nativeCodexUsageSeen=previous?.nativeCodexUsageSeen??false;
  let codexClientVersion:string|null=previous?.clientVersion??null;
  let lastLegacyCodex:{id:string;at:number;counts:Counts}|null=null;
  // A partial trailing line is revisited on the next scan.
  const stream=createReadStream(path,{start:offset,highWaterMark:256*1024});
  const lines=jsonLines(stream);
  const conversation=provider==='claude-code'?(path.includes('/subagents/')?basename(dirname(dirname(path))):basename(path,'.jsonl'))
    :basename(path,'.jsonl').match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/)?.[1]??basename(path,'.jsonl');
  const helper=provider==='claude-code'&&path.includes('/subagents/');
  let atByte=offset;
  for await(const line of lines){
    const bytes=Buffer.byteLength(line)+1;
    if(atByte+bytes>stat.size)break;
    try{
      if(provider==='claude-code'&&!line.includes('"usage"')&&!line.includes('"compact_boundary"')){atByte+=bytes;continue;}
      if(provider==='codex'&&!line.includes('"token_count"')&&!line.includes('"token_usage_record"')
        &&!line.includes('"turn_context"')&&!line.includes('"compacted"')&&!line.includes('"session_meta"')){atByte+=bytes;continue;}
      const row=JSON.parse(line),at=stamp(row.timestamp);
      if(provider==='codex'&&row.type==='session_meta'&&typeof row.payload?.cli_version==='string')
        codexClientVersion=row.payload.cli_version;
      if(provider==='codex'&&row.type==='turn_context'){
        if(typeof row.payload?.model==='string')model=row.payload.model;
        if(typeof row.payload?.turn_id==='string')providerTurnId=row.payload.turn_id;
      }
      if((provider==='claude-code'&&row.type==='system'&&row.subtype==='compact_boundary')
        ||(provider==='codex'&&row.type==='compacted'))
        if(Number.isFinite(at))cache.query('INSERT OR IGNORE INTO cache_boundaries VALUES(?,?,?)').run(path,at,'compaction');
      if(provider==='claude-code'&&row.type==='assistant'&&row.message?.usage&&row.message?.id){
        if(!firstUsageId&&offset===0)firstUsageId=row.message.id;
        insert(path,row.message.id,provider,conversation,helper,at,row.message.model??null,countsClaude(row.message.usage),null,
          typeof row.version==='string'?row.version:null);
      }
      if(provider==='codex'&&row.type==='token_usage_record'&&row.payload?.usage
        &&typeof row.payload.response_id==='string'){
        const counts=countsCodex(row.payload.usage);
        if(!nativeCodexUsageSeen&&lastLegacyCodex&&Math.abs(at-lastLegacyCodex.at)<2000
          &&JSON.stringify(counts)===JSON.stringify(lastLegacyCodex.counts)){
          cache.query('DELETE FROM records WHERE path=? AND record_id=?').run(path,lastLegacyCodex.id);
          if(firstUsageId===lastLegacyCodex.id)firstUsageId=row.payload.response_id;
        }
        nativeCodexUsageSeen=true;
        const id=row.payload.response_id;
        if(!firstUsageId&&offset===0)firstUsageId=id;
        insert(path,id,provider,conversation,false,at,model,counts,
          typeof row.payload.turn_id==='string'?row.payload.turn_id:providerTurnId,codexClientVersion);
      }
      if(provider==='codex'&&row.type==='event_msg'&&row.payload?.type==='token_count'&&row.payload.info?.total_token_usage){
        const next=countsCodex(row.payload.info.total_token_usage);
        const delta={input:Math.max(0,next.input-total.input),cacheWrite:Math.max(0,next.cacheWrite-total.cacheWrite),cacheWrite1h:0,
          cacheRead:Math.max(0,next.cacheRead-total.cacheRead),output:Math.max(0,next.output-total.output)};
        if(!nativeCodexUsageSeen&&Object.values(delta).some(Boolean)){
          const id=String(row.ordinal??atByte);
          if(!firstUsageId&&offset===0)firstUsageId=id;
          insert(path,id,provider,conversation,false,at,model,delta,providerTurnId,codexClientVersion);
          lastLegacyCodex={id,at,counts:delta};
        }
        total=next;
      }
    }catch{/* incomplete or malformed transcript row; retain the rest */}
    atByte+=bytes;
  }
  cache.query('INSERT INTO files VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET offset=excluded.offset,size=excluded.size,mtime=excluded.mtime,total_json=excluded.total_json')
    .run(path,Math.min(atByte,stat.size),stat.size,stat.mtimeMs,JSON.stringify({schemaVersion:3,counts:total,model,
      providerTurnId,firstUsageId,nativeCodexUsageSeen,clientVersion:codexClientVersion}));
}
function midnight(zone:string,now=Date.now()){
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  const [year,month,date]=day.split('-').map(Number);
  let guess=Date.UTC(year,month-1,date);
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:zone,hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit'});
  for(let n=0;n<3;n++){
    const p=Object.fromEntries(parts.formatToParts(new Date(guess)).map(x=>[x.type,Number(x.value)]));
    const local=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);
    guess+=Date.UTC(year,month-1,date)-local;
  }
  return guess;
}
const pricing:Record<string,{input:number;cacheWrite:number;cacheWrite1h:number;cacheRead:number;output:number}>={
  'claude-opus-5-5':{input:4,cacheWrite:5,cacheWrite1h:8,cacheRead:.2,output:20},
  'claude-opus-5':{input:5,cacheWrite:6.25,cacheWrite1h:10,cacheRead:.5,output:25},
  'claude-fable-5-1':{input:10,cacheWrite:12.5,cacheWrite1h:20,cacheRead:.25,output:50},
  'claude-sonnet-5':{input:2,cacheWrite:2.5,cacheWrite1h:4,cacheRead:.2,output:10},
  'claude-sonnet-5-5':{input:2,cacheWrite:2.5,cacheWrite1h:4,cacheRead:.2,output:10},
  'claude-haiku-5-5':{input:.1,cacheWrite:.125,cacheWrite1h:.2,cacheRead:.01,output:.5},
  'claude-haiku-4-5':{input:1,cacheWrite:1.25,cacheWrite1h:2,cacheRead:.1,output:5},
  'claude-haiku-4-5-20251001':{input:1,cacheWrite:1.25,cacheWrite1h:2,cacheRead:.1,output:5},
  'gpt-6.1-sol':{input:2,cacheWrite:2.5,cacheWrite1h:0,cacheRead:.1,output:10},
  'gpt-6-sol':{input:2,cacheWrite:2.5,cacheWrite1h:0,cacheRead:.2,output:10},
  'gpt-5.6-sol':{input:4,cacheWrite:5,cacheWrite1h:0,cacheRead:.4,output:20},
  'gpt-6-astra':{input:10,cacheWrite:12.5,cacheWrite1h:0,cacheRead:1,output:50},
  'gpt-6-luna':{input:.1,cacheWrite:.125,cacheWrite1h:0,cacheRead:.01,output:.5},
};
function price(provider:string,model:string|null){return pricing[model??'']??(provider==='claude-code'?pricing['claude-opus-5-5']!:pricing['gpt-6.1-sol']!);}
type RecordRow={path:string;record_id:string;provider:string;conversation:string;helper:number;at_ms:number;model:string|null;
  input:number;cache_write:number;cache_write_1h:number;cache_read:number;output:number;provider_turn_id:string|null;client_version:string|null};
type Session={id:number;agent_session_uuid:string;native_metadata_json:string;provider_id:string};
type Turn={id:number;session_id:number;status:string;provider_turn_id:string|null;provider_started_at:string|null;ended_at:string|null;
  systemInstructionsSha256:string|null;effort:string|null;startMs:number;endMs:number};
type ScheduledFiring={id:number;session_id:number;status:string;saved_root_id:number;saved_sequence:number;saved_fire_at_ms:number;
  provider_started_at:string|null;provider_duration_ms:number|null;ended_at:string|null};
const codexLabels=new Map<string,string>();
for(const accountHome of [join(home,'.codex'),...existsSync(join(home,'.codex-accounts'))
  ?readdirSync(join(home,'.codex-accounts'),{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>join(home,'.codex-accounts',x.name)):[]]){
  try{
    const auth=JSON.parse(readFileSync(join(accountHome,'auth.json'),'utf8'));
    const id=auth?.tokens?.account_id;
    if(typeof id!=='string')continue;
    let label=id;
    try{
      const claims=JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1],'base64url').toString('utf8'));
      if(typeof claims.email==='string')label=claims.email;
    }catch{}
    codexLabels.set(id,label);
  }catch{}
}
const codexTranscriptAccount=new Map<string,string>();
function codexAccount(path:string){
  const known=codexTranscriptAccount.get(path);if(known)return known;
  let id:string|null=null;
  try{
    const fd=openSync(path,'r'),bytes=Buffer.alloc(4096);
    try{const n=readSync(fd,bytes,0,bytes.length,0);id=bytes.toString('utf8',0,n).match(/"creator_account_id":"([^"]+)"/)?.[1]??null;}
    finally{closeSync(fd);}
  }catch{}
  const label=id?(codexLabels.get(id)??`Codex account ${id}`):'unknown Codex account';
  codexTranscriptAccount.set(path,label);return label;
}
function report(period:'today'|'week',since:number,zone:string){
  const sessions=new Map((ledger.query("SELECT id,agent_session_uuid,native_metadata_json,provider_id FROM sessions WHERE agent_session_uuid IS NOT NULL").all() as Session[])
    .map(s=>[`${s.provider_id}:${s.agent_session_uuid}`,s]));
  const events=ledger.query("SELECT event.session_id,event.turn_id,event.created_at,json_extract(event.payload_json,'$.account') AS account FROM session_owner_events event WHERE event.kind='account' ORDER BY event.session_id,event.created_at").all() as {session_id:number;turn_id:number|null;created_at:string;account:string}[];
  const accounts=new Map<number,{at:number;name:string}[]>();
  const accountsByTurn=new Map<number,string>();
  for(const e of events){const a=accounts.get(e.session_id)??[];a.push({at:Date.parse(e.created_at+'Z'),name:e.account});accounts.set(e.session_id,a);
    if(e.turn_id!==null)accountsByTurn.set(e.turn_id,e.account);}
  const turns=(ledger.query(`SELECT turn.id,turn.session_id,turn.status,turn.provider_turn_id,turn.provider_started_at,turn.ended_at,
    json_extract(identity.payload_json,'$.systemInstructionsSha256') AS systemInstructionsSha256,
    json_extract(identity.payload_json,'$.effort') AS effort
    FROM turns turn LEFT JOIN session_owner_events identity ON identity.sequence=(
      SELECT MAX(sequence) FROM session_owner_events WHERE turn_id=turn.id AND kind='prompt_cache_identity')
    WHERE turn.provider_started_at IS NOT NULL AND (turn.ended_at IS NULL OR turn.ended_at>=datetime(?/1000,'unixepoch'))`).all(oneWeekAgo) as Turn[])
    .map(t=>({...t,startMs:Date.parse(`${t.provider_started_at}Z`),endMs:t.ended_at?Date.parse(`${t.ended_at}Z`):Date.now()}));
  const turnsBySession=new Map<number,Turn[]>();
  for(const turn of turns){const list=turnsBySession.get(turn.session_id)??[];list.push(turn);turnsBySession.set(turn.session_id,list);}
  const boundaries=new Map<string,number[]>();
  for(const b of cache.query('SELECT path,at_ms FROM cache_boundaries WHERE at_ms>=? ORDER BY at_ms').all(oneWeekAgo) as {path:string;at_ms:number}[]){
    const list=boundaries.get(b.path)??[];list.push(b.at_ms);boundaries.set(b.path,list);
  }
  const firstUsageByPath=new Map((cache.query('SELECT path,total_json FROM files').all() as {path:string;total_json:string}[])
    .map(file=>[file.path,(JSON.parse(file.total_json) as {firstUsageId?:string}).firstUsageId??null] as const));
  const groups=new Map<string,any>();
  const scheduled=(ledger.query(`SELECT id,session_id,status,saved_root_id,saved_sequence,saved_fire_at_ms,
    provider_started_at,provider_duration_ms,ended_at FROM turns
    WHERE saved_kind='scheduled' AND saved_repeat_ms IS NOT NULL AND saved_root_id IS NOT NULL
      AND saved_fire_at_ms>=? ORDER BY saved_fire_at_ms,id`).all(since) as ScheduledFiring[])
    .map(t=>({...t,providerStartMs:t.provider_started_at?Date.parse(`${t.provider_started_at}Z`):null,
      endedMs:t.ended_at?Date.parse(`${t.ended_at}Z`):null,raw:empty(),weighted:0,usageRecords:0}));
  const scheduledBySession=new Map<number,typeof scheduled>();
  for(const firing of scheduled){const list=scheduledBySession.get(firing.session_id)??[];list.push(firing);scheduledBySession.set(firing.session_id,list);}
  const fallbackModels=new Set<string>();
  const rows=cache.query(`SELECT path,record_id,provider,conversation,helper,at_ms,model,input,cache_write,cache_write_1h,cache_read,output,
    provider_turn_id,client_version FROM records WHERE at_ms>=? ORDER BY path,at_ms,record_id`).all(oneWeekAgo) as RecordRow[];
  const calls:any[]=[];
  const callsByTurn=new Map<number,{turnId:number;sessionId:number;provider:string;account:string;status:string;raw:Counts;callCount:number;
    flaggedCallCount:number;unknownCauseCount:number}>();
  const previousByPath=new Map<string,{row:RecordRow;turn:Turn|null}>();
  for(const r of rows){
    const s=sessions.get(`${r.provider}:${r.conversation}`),meta=s?JSON.parse(s.native_metadata_json):{};
    const candidates=s?turnsBySession.get(s.id)??[]:[];
    const exact=r.provider_turn_id?candidates.filter(t=>t.provider_turn_id===r.provider_turn_id):[];
    const matched=exact.length?exact:candidates.filter(t=>r.at_ms>=t.startMs&&r.at_ms<=t.endMs);
    const turn=matched.length===1?matched[0]!:null;
    const accountEvents=s?accounts.get(s.id)??[]:[];
    let account='unknown';for(const e of accountEvents){if(e.at<=r.at_ms)account=e.name;else break;}
    if(turn&&accountsByTurn.has(turn.id))account=accountsByTurn.get(turn.id)!;
    // Codex homes have separate transcript trees; Claude's shared history gives no account for an unrelated process.
    if(r.provider==='codex'&&account==='unknown')account=codexAccount(r.path);
    const project=meta.project?basename(meta.project):meta.cwd?basename(meta.cwd):null;
    const kind=!s?'outside Concierge':r.helper?'helper sub-agents':project==='slack-inbox'?'Inbox router':project??'ordinary sessions';
    const weights=price(r.provider,r.model);
    const previous=previousByPath.get(r.path);
    const rewritten=r.input+r.cache_write+r.cache_write_1h;
    const context=rewritten+r.cache_read;
    const reasons:string[]=[];
    const possibleReasons:string[]=[];
    if(previous){
      if(previous.row.model&&r.model&&previous.row.model!==r.model)reasons.push('model_changed');
      if(previous.row.client_version&&r.client_version&&previous.row.client_version!==r.client_version)reasons.push('client_version_changed');
      if(previous.turn&&turn&&previous.turn.id!==turn.id){
        const before=accountsByTurn.get(previous.turn.id),after=accountsByTurn.get(turn.id);
        if(before&&after&&before!==after)reasons.push('account_changed');
        if(previous.turn.systemInstructionsSha256&&turn.systemInstructionsSha256
          &&previous.turn.systemInstructionsSha256!==turn.systemInstructionsSha256){
          if(r.provider==='claude-code')possibleReasons.push('submitted_instructions_changed');
          else reasons.push('system_instructions_changed');
        }
        if(previous.turn.effort!==null&&turn.effort!==null&&previous.turn.effort!==turn.effort)reasons.push('effort_changed');
      }
      if((boundaries.get(r.path)??[]).some(at=>at>previous.row.at_ms&&at<=r.at_ms))reasons.push('compaction_observed');
      // A gap past the configured cache lifetime makes a rewrite unsurprising; it
      // does not prove that expiry caused this particular rewrite.
      const elapsed=r.at_ms-previous.row.at_ms;
      if(r.provider==='claude-code'){
        const lifetime=previous.row.helper&&previous.row.cache_write_1h===0?300_000:3600_000;
        if(elapsed>=lifetime)reasons.push('cache_lifetime_elapsed');
      }
    }
    const isFirstCall=!previous&&firstUsageByPath.get(r.path)===r.record_id;
    if(isFirstCall)reasons.push('first_call');
    // Keep the diagnostic threshold identical to the 48-hour incident measurement.
    const largeMiss=context>50_000&&rewritten>context/2;
    const expectedReason=isFirstCall||reasons.includes('compaction_observed')||reasons.includes('cache_lifetime_elapsed');
    const largeUnexpected=largeMiss&&!!previous&&!expectedReason;
    const cause={status:!largeMiss?'not_applicable':expectedReason?'expected':reasons.length?'observed':'unknown',
      reasons:largeMiss?reasons:[],possibleReasons:largeMiss?possibleReasons:[]};
    const call={provider:r.provider,account,sessionId:s?.id??null,turnId:turn?.id??null,
      providerConversationId:r.conversation,callId:r.record_id,at:new Date(r.at_ms).toISOString(),model:r.model,
      clientVersion:r.client_version,raw:{input:r.input,cacheWrite:r.cache_write,cacheWrite1h:r.cache_write_1h,
        cacheRead:r.cache_read,output:r.output},cachedInputTokens:r.cache_read,rewrittenInputTokens:rewritten,
      cacheReadShare:context?r.cache_read/context:null,cause,
      flags:largeUnexpected?['large_unexplained_cache_miss']:[]};
    previousByPath.set(r.path,{row:r,turn});
    if(r.at_ms<since)continue;
    calls.push(call);
    if(turn){
      let entry=callsByTurn.get(turn.id);
      if(!entry){entry={turnId:turn.id,sessionId:turn.session_id,provider:r.provider,account,status:turn.status,
        raw:empty(),callCount:0,flaggedCallCount:0,unknownCauseCount:0};callsByTurn.set(turn.id,entry);}
      entry.callCount++;entry.flaggedCallCount+=Number(largeUnexpected);entry.unknownCauseCount+=Number(cause.status==='unknown');
      entry.raw.input+=r.input;entry.raw.cacheWrite+=r.cache_write;entry.raw.cacheWrite1h+=r.cache_write_1h;
      entry.raw.cacheRead+=r.cache_read;entry.raw.output+=r.output;
    }
    if(!pricing[r.model??'']&&r.input+r.cache_write+r.cache_write_1h+r.cache_read+r.output>0)fallbackModels.add(r.model??'unreported');
    const weighted=(r.input*weights.input+r.cache_write*weights.cacheWrite+r.cache_write_1h*weights.cacheWrite1h+r.cache_read*weights.cacheRead+r.output*weights.output)/1e6;
    if(s){
      const firing=scheduledBySession.get(s.id)?.find(t=>t.providerStartMs!==null&&t.endedMs!==null
        &&r.at_ms>=t.providerStartMs&&r.at_ms<=t.endedMs);
      if(firing){firing.weighted+=weighted;firing.usageRecords++;
        firing.raw.input+=r.input;firing.raw.cacheWrite+=r.cache_write;firing.raw.cacheWrite1h+=r.cache_write_1h;
        firing.raw.cacheRead+=r.cache_read;firing.raw.output+=r.output;}
    }
    const key=`${r.provider}:${account}`;
    let g=groups.get(key);
    if(!g){g={provider:r.provider,account,total:0,raw:empty(),cache:{callCount:0,flaggedCallCount:0,unknownCauseCount:0},
      bySession:new Map(),byKind:new Map()};groups.set(key,g);}
    g.total+=weighted;g.raw.input+=r.input;g.raw.cacheWrite+=r.cache_write;g.raw.cacheWrite1h+=r.cache_write_1h;g.raw.cacheRead+=r.cache_read;g.raw.output+=r.output;
    g.cache.callCount++;g.cache.flaggedCallCount+=Number(largeUnexpected);g.cache.unknownCauseCount+=Number(cause.status==='unknown');
    const sessionKey=s?String(s.id):`outside:${r.conversation}`;
    let entry=g.bySession.get(sessionKey);
    if(!entry){entry={sessionId:s?.id??null,address:s?`concierge:${s.id}`:null,providerConversationId:r.conversation,
      title:meta.title??(s?null:`Outside Concierge · ${r.conversation}`),project,kind:s?project==='slack-inbox'?'Inbox router':'ordinary session':'outside Concierge',weighted:0,helperWeighted:0,raw:empty(),
      cache:{callCount:0,flaggedCallCount:0,unknownCauseCount:0}};g.bySession.set(sessionKey,entry);}
    entry.weighted+=weighted;entry.raw.input+=r.input;entry.raw.cacheWrite+=r.cache_write;entry.raw.cacheWrite1h+=r.cache_write_1h;entry.raw.cacheRead+=r.cache_read;entry.raw.output+=r.output;
    entry.cache.callCount++;entry.cache.flaggedCallCount+=Number(largeUnexpected);entry.cache.unknownCauseCount+=Number(cause.status==='unknown');
    if(r.helper)entry.helperWeighted+=weighted;
    let category=g.byKind.get(kind);
    if(!category){category={weighted:0,raw:empty()};g.byKind.set(kind,category);}
    category.weighted+=weighted;category.raw.input+=r.input;category.raw.cacheWrite+=r.cache_write;
    category.raw.cacheWrite1h+=r.cache_write_1h;category.raw.cacheRead+=r.cache_read;category.raw.output+=r.output;
  }
  const ordinaryCallCount=calls.filter(call=>!call.cause.reasons.includes('first_call')).length;
  const ordinaryMissRate=calls.filter(call=>call.flags.length>0).length/Math.max(1,ordinaryCallCount);
  const providerRates=new Map<string,{calls:number;misses:number}>();
  for(const call of calls){
    if(call.cause.reasons.includes('first_call'))continue;
    const rate=providerRates.get(call.provider)??{calls:0,misses:0};
    rate.calls++;rate.misses+=Number(call.flags.length>0);providerRates.set(call.provider,rate);
  }
  const aboveNormal=(misses:number,count:number,provider:string)=>{
    const rate=providerRates.get(provider);
    const baseline=rate?rate.misses/Math.max(1,rate.calls):ordinaryMissRate;
    return misses>0&&count>0&&misses/count>Math.max(.05,2*baseline);
  };
  for(const group of groups.values()){
    group.cache.bug=aboveNormal(group.cache.flaggedCallCount,group.cache.callCount,group.provider);
    for(const entry of group.bySession.values())
      entry.cache.bug=aboveNormal(entry.cache.flaggedCallCount,entry.cache.callCount,group.provider);
  }
  return {period,since:new Date(since).toISOString(),through:new Date().toISOString(),timeZone:zone,
    measure:'Published API price equivalent in USD; a proxy for allowance share, not the provider subscription meter.',
    fallbackModels:[...fallbackModels].sort(),
    cacheDiagnostics:{meaning:'Cached input was read from the provider cache; rewritten input was sent as uncached input or cache creation. Cause reasons are coincident observed changes, not proof that a specific change invalidated the cache prefix. Possible reasons include submitted Claude instructions that its recorded prompt may have ignored.',
      flagRule:'A call rewrites over half of more than 50000 input tokens after an earlier call, with no observed compaction or provider-supported cache lifetime elapsed. A turn or session is a bug candidate when its flagged-call rate exceeds both 5% and twice its provider period baseline.',
      ordinaryMissRate,
      callCount:calls.length,turnCount:callsByTurn.size,
      last48Hours:(()=>{const recent=calls.filter(call=>Date.parse(call.at)>=Date.now()-48*3600_000);
        const causes:Record<string,{calls:number;rewrittenInputTokens:number}>={};
        for(const call of recent.filter(call=>call.cause.status!=='not_applicable')){
          const labels=[...call.cause.reasons,...call.cause.possibleReasons];
          for(const reason of labels.length?labels:['unknown']){
            const prior=causes[reason]??{calls:0,rewrittenInputTokens:0};
            causes[reason]={calls:prior.calls+1,rewrittenInputTokens:prior.rewrittenInputTokens+call.rewrittenInputTokens};
          }}
        return {callCount:recent.length,expected:recent.filter(call=>call.cause.status==='expected').length,
          unexpected:recent.filter(call=>call.flags.length>0).length,
          unknown:recent.filter(call=>call.cause.status==='unknown').length,byCause:causes};})(),
      calls:calls.sort((a,b)=>b.rewrittenInputTokens-a.rewrittenInputTokens).slice(0,100),
      turns:[...callsByTurn.values()].sort((a,b)=>b.raw.input+b.raw.cacheWrite+b.raw.cacheWrite1h-(a.raw.input+a.raw.cacheWrite+a.raw.cacheWrite1h))
        .slice(0,100).map(t=>({...t,bug:aboveNormal(t.flaggedCallCount,t.callCount,t.provider),cachedInputTokens:t.raw.cacheRead,
          rewrittenInputTokens:t.raw.input+t.raw.cacheWrite+t.raw.cacheWrite1h}))},
    scheduledFirings:scheduled.map(t=>({turnId:t.id,sessionId:t.session_id,rootId:t.saved_root_id,
      sequence:t.saved_sequence,scheduledAt:new Date(t.saved_fire_at_ms).toISOString(),status:t.status,
      providerStartedAt:t.provider_started_at?`${t.provider_started_at}Z`:null,
      completedAt:t.ended_at?`${t.ended_at}Z`:null,wallMs:t.provider_duration_ms,
      cpuMs:null,peakMemoryBytes:null,usageObserved:t.usageRecords>0,
      apiPriceEquivalentUsd:t.usageRecords?t.weighted:null,rawTokens:t.usageRecords?t.raw:null})),
    weighting:pricing,pricingSources:['https://platform.claude.com/docs/en/about-claude/pricing','https://platform.openai.com/pricing'],
    accounts:[...groups.values()].map(g=>({provider:g.provider,account:g.account,totalWeighted:g.total,raw:g.raw,cache:g.cache,
      cachedInputTokens:g.raw.cacheRead,rewrittenInputTokens:g.raw.input+g.raw.cacheWrite+g.raw.cacheWrite1h,
      bySession:[...g.bySession.values()].map((x:any)=>({...x,share:g.total?x.weighted/g.total:0,
        cachedInputTokens:x.raw.cacheRead,rewrittenInputTokens:x.raw.input+x.raw.cacheWrite+x.raw.cacheWrite1h}))
        .sort((a:any,b:any)=>b.weighted-a.weighted),
      byKind:[...g.byKind].map(([kind,value])=>({kind,...value,share:g.total?value.weighted/g.total:0})).sort((a:any,b:any)=>b.weighted-a.weighted)}))};
}
async function main(){
  const started=performance.now();
  cache.exec('BEGIN IMMEDIATE');
  try{
    for(const path of walk(claudeRoot))await scan(path,'claude-code');
    for(const root of codexRoots)for(const path of walk(root))if(path.includes('/sessions/'))await scan(path,'codex');
    cache.query('DELETE FROM records WHERE at_ms<?').run(oneWeekAgo);
    cache.query('DELETE FROM cache_boundaries WHERE at_ms<?').run(oneWeekAgo);
    cache.exec('COMMIT');
  }catch(error){cache.exec('ROLLBACK');throw error;}
  const zone=(ledger.query('SELECT time_zone FROM saved_work_settings WHERE singleton=1').get() as {time_zone:string}|null)?.time_zone??'America/New_York';
  const week=report('week',oneWeekAgo,zone),today=report('today',midnight(zone),zone);
  today.cacheDiagnostics.last48Hours=week.cacheDiagnostics.last48Hours;
  console.log(JSON.stringify({today,week,scanMs:Math.round(performance.now()-started)}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
