#!/usr/bin/env bun
import {Database} from 'bun:sqlite';
import {closeSync,createReadStream,existsSync,mkdirSync,openSync,readFileSync,readSync,readdirSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {createInterface} from 'node:readline';

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
 CREATE INDEX IF NOT EXISTS records_recent ON records(at_ms);`);
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
function insert(path:string,id:string,provider:string,conversation:string,helper:boolean,at:number,model:string|null,c:Counts){
  if(at<oneWeekAgo||at>Date.now()+60000)return;
  cache.query('INSERT OR IGNORE INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(path,id,provider,conversation,helper?1:0,at,model,c.input,c.cacheWrite,c.cacheWrite1h,c.cacheRead,c.output);
}
async function scan(path:string,provider:'claude-code'|'codex'){
  const stat=statSync(path), prior=cache.query('SELECT * FROM files WHERE path=?').get(path) as FileRow|null;
  if(prior&&prior.size===stat.size&&prior.mtime===stat.mtimeMs)return;
  if(stat.mtimeMs<oneWeekAgo&&!prior)return;
  let offset=prior&&prior.size<=stat.size?prior.offset:0;
  if(prior&&prior.size>stat.size){cache.query('DELETE FROM records WHERE path=?').run(path);offset=0;}
  let previous:any=prior&&offset?JSON.parse(prior.total_json):null;
  let total:Counts=previous?.counts??empty(),model:string|null=previous?.model??null;
  // A partial trailing line is revisited on the next scan.
  const stream=createReadStream(path,{start:offset,highWaterMark:256*1024});
  const lines=createInterface({input:stream,crlfDelay:Infinity});
  const conversation=provider==='claude-code'?(path.includes('/subagents/')?basename(dirname(dirname(path))):basename(path,'.jsonl'))
    :basename(path,'.jsonl').match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/)?.[1]??basename(path,'.jsonl');
  const helper=provider==='claude-code'&&path.includes('/subagents/');
  let atByte=offset;
  for await(const line of lines){
    const bytes=Buffer.byteLength(line)+1;
    if(atByte+bytes>stat.size)break;
    try{
      if(provider==='claude-code'&&(!line.includes('"type":"assistant"')||!line.includes('"usage"'))){atByte+=bytes;continue;}
      if(provider==='codex'&&!line.includes('"type":"token_count"')&&!line.includes('"type":"turn_context"')){atByte+=bytes;continue;}
      const row=JSON.parse(line),at=stamp(row.timestamp);
      if(provider==='codex'&&row.type==='turn_context'&&typeof row.payload?.model==='string')model=row.payload.model;
      if(provider==='claude-code'&&row.type==='assistant'&&row.message?.usage&&row.message?.id)
        insert(path,row.message.id,provider,conversation,helper,at,row.message.model??null,countsClaude(row.message.usage));
      if(provider==='codex'&&row.type==='event_msg'&&row.payload?.type==='token_count'&&row.payload.info?.total_token_usage){
        const next=countsCodex(row.payload.info.total_token_usage);
        const delta={input:Math.max(0,next.input-total.input),cacheWrite:Math.max(0,next.cacheWrite-total.cacheWrite),cacheWrite1h:0,
          cacheRead:Math.max(0,next.cacheRead-total.cacheRead),output:Math.max(0,next.output-total.output)};
        if(Object.values(delta).some(Boolean))insert(path,String(row.ordinal??atByte),provider,conversation,false,at,model,delta);
        total=next;
      }
    }catch{/* incomplete or malformed transcript row; retain the rest */}
    atByte+=bytes;
  }
  cache.query('INSERT INTO files VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET offset=excluded.offset,size=excluded.size,mtime=excluded.mtime,total_json=excluded.total_json')
    .run(path,Math.min(atByte,stat.size),stat.size,stat.mtimeMs,JSON.stringify({counts:total,model}));
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
type RecordRow={path:string;provider:string;conversation:string;helper:number;at_ms:number;model:string|null;input:number;cache_write:number;cache_write_1h:number;cache_read:number;output:number};
type Session={id:number;agent_session_uuid:string;native_metadata_json:string;provider_id:string};
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
  const events=ledger.query("SELECT event.session_id,event.created_at,json_extract(event.payload_json,'$.account') AS account FROM session_owner_events event WHERE event.kind='account' ORDER BY event.session_id,event.created_at").all() as {session_id:number;created_at:string;account:string}[];
  const accounts=new Map<number,{at:number;name:string}[]>();
  for(const e of events){const a=accounts.get(e.session_id)??[];a.push({at:Date.parse(e.created_at+'Z'),name:e.account});accounts.set(e.session_id,a);}
  const groups=new Map<string,any>();
  const fallbackModels=new Set<string>();
  const rows=cache.query('SELECT path,provider,conversation,helper,at_ms,model,input,cache_write,cache_write_1h,cache_read,output FROM records WHERE at_ms>=?').all(since) as RecordRow[];
  for(const r of rows){
    const s=sessions.get(`${r.provider}:${r.conversation}`),meta=s?JSON.parse(s.native_metadata_json):{};
    const accountEvents=s?accounts.get(s.id)??[]:[];
    let account='unknown';for(const e of accountEvents){if(e.at<=r.at_ms)account=e.name;else break;}
    // Codex homes have separate transcript trees; Claude's shared history gives no account for an unrelated process.
    if(r.provider==='codex'&&account==='unknown')account=codexAccount(r.path);
    const project=meta.project?basename(meta.project):meta.cwd?basename(meta.cwd):null;
    const kind=!s?'outside Concierge':r.helper?'helper sub-agents':project==='slack-inbox'?'Inbox router':project??'ordinary sessions';
    const weights=price(r.provider,r.model);
    if(!pricing[r.model??'']&&r.input+r.cache_write+r.cache_write_1h+r.cache_read+r.output>0)fallbackModels.add(r.model??'unreported');
    const weighted=(r.input*weights.input+r.cache_write*weights.cacheWrite+r.cache_write_1h*weights.cacheWrite1h+r.cache_read*weights.cacheRead+r.output*weights.output)/1e6;
    const key=`${r.provider}:${account}`;
    let g=groups.get(key);
    if(!g){g={provider:r.provider,account,total:0,raw:empty(),bySession:new Map(),byKind:new Map()};groups.set(key,g);}
    g.total+=weighted;g.raw.input+=r.input;g.raw.cacheWrite+=r.cache_write;g.raw.cacheWrite1h+=r.cache_write_1h;g.raw.cacheRead+=r.cache_read;g.raw.output+=r.output;
    const sessionKey=s?String(s.id):`outside:${r.conversation}`;
    let entry=g.bySession.get(sessionKey);
    if(!entry){entry={sessionId:s?.id??null,address:s?`concierge:${s.id}`:null,providerConversationId:r.conversation,
      title:meta.title??(s?null:`Outside Concierge · ${r.conversation}`),project,kind:s?project==='slack-inbox'?'Inbox router':'ordinary session':'outside Concierge',weighted:0,helperWeighted:0,raw:empty()};g.bySession.set(sessionKey,entry);}
    entry.weighted+=weighted;entry.raw.input+=r.input;entry.raw.cacheWrite+=r.cache_write;entry.raw.cacheWrite1h+=r.cache_write_1h;entry.raw.cacheRead+=r.cache_read;entry.raw.output+=r.output;
    if(r.helper)entry.helperWeighted+=weighted;
    let category=g.byKind.get(kind);
    if(!category){category={weighted:0,raw:empty()};g.byKind.set(kind,category);}
    category.weighted+=weighted;category.raw.input+=r.input;category.raw.cacheWrite+=r.cache_write;
    category.raw.cacheWrite1h+=r.cache_write_1h;category.raw.cacheRead+=r.cache_read;category.raw.output+=r.output;
  }
  return {period,since:new Date(since).toISOString(),through:new Date().toISOString(),timeZone:zone,
    measure:'Published API price equivalent in USD; a proxy for allowance share, not the provider subscription meter.',
    fallbackModels:[...fallbackModels].sort(),
    weighting:pricing,pricingSources:['https://platform.claude.com/docs/en/about-claude/pricing','https://platform.openai.com/pricing'],
    accounts:[...groups.values()].map(g=>({provider:g.provider,account:g.account,totalWeighted:g.total,raw:g.raw,
      bySession:[...g.bySession.values()].map((x:any)=>({...x,share:g.total?x.weighted/g.total:0})).sort((a:any,b:any)=>b.weighted-a.weighted),
      byKind:[...g.byKind].map(([kind,value])=>({kind,...value,share:g.total?value.weighted/g.total:0})).sort((a:any,b:any)=>b.weighted-a.weighted)}))};
}
async function main(){
  const started=performance.now();
  cache.exec('BEGIN IMMEDIATE');
  try{
    for(const path of walk(claudeRoot))await scan(path,'claude-code');
    for(const root of codexRoots)for(const path of walk(root))if(path.includes('/sessions/'))await scan(path,'codex');
    cache.query('DELETE FROM records WHERE at_ms<?').run(oneWeekAgo);
    cache.exec('COMMIT');
  }catch(error){cache.exec('ROLLBACK');throw error;}
  const zone=(ledger.query('SELECT time_zone FROM saved_work_settings WHERE singleton=1').get() as {time_zone:string}|null)?.time_zone??'America/New_York';
  const today=report('today',midnight(zone),zone),week=report('week',oneWeekAgo,zone);
  console.log(JSON.stringify({today,week,scanMs:Math.round(performance.now()-started)}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
