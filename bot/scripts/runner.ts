/**
 * A Concierge runner (docs/architecture/RUNNERS.md): a machine that pulls work from the owner over
 * outbound HTTPS. It opens no port. It claims a job, heartbeats its lease, streams sequenced events
 * and finishes under one operation id, and on restart takes back the attempts it recorded.
 *
 * Environment: CONCIERGE_OWNER_URL (the owner's agent entrance), CONCIERGE_RUNNER_TOKEN_FILE (a
 * runner token from `POST /runner/v1/token` on the owner's machine), CONCIERGE_RUNNER_STATE (this
 * runner's own folder), CONCIERGE_RUNNER_KINDS (default `probe,turn,codex`; `codex` offers this
 * machine's Codex App Server through the owner's relay). `--once` handles at most one
 * probe and exits (the probe check uses it).
 *
 * Job kinds:
 * - `probe` echoes its payload.
 * - `turn` runs one agent turn inside the unchanged execution host (bot/scripts/execution-host.ts),
 *   started under this machine's systemd with this runner's state folder, environment and release.
 *   Every journal frame becomes one event (RUNNERS.md "Turns on a runner"); the owner's submit,
 *   close, signal, status and release arrive as commands and their results are the host's receipts.
 *   The host is released only when the owner sends `release` after settling the turn, and the job
 *   finishes after that. A turn is never replayed: if this runner loses its lease, the owner has
 *   already settled the turn as unconfirmed and the local host is stopped.
 */
import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ADOPTABLE_HOST_PROTOCOLS,HOST_PROTOCOL_VERSION,HostConnection,HostNotStartedError,connectWhenReady,executionDirectory,
  executionUnit,hostCustody,hostSocketPath,startHost,stopSupersededHost,streamJournal,type HostFrame} from '../src/execution-host-client';
import {watchClaudeTranscript} from '../src/claude-transcript-watch';
import {RUNNER_FENCE_MS} from '../src/runner-leases';
import {codexAppServerSocketPath} from '../src/codex-app-server-client';
import {controlSocketListeners,startCodexDaemonWhenAbsent} from '../src/codex-daemon-file-limit';

const owner=process.env.CONCIERGE_OWNER_URL?.replace(/\/+$/,'');
const tokenFile=process.env.CONCIERGE_RUNNER_TOKEN_FILE;
const stateDir=process.env.CONCIERGE_RUNNER_STATE;
if(!owner||!tokenFile||!stateDir){console.error('CONCIERGE_OWNER_URL, CONCIERGE_RUNNER_TOKEN_FILE and CONCIERGE_RUNNER_STATE are required.');process.exit(2);}
const token=readFileSync(tokenFile,'utf8').trim();
mkdirSync(stateDir,{recursive:true,mode:0o700});
const held=join(stateDir,'attempts.json');
/**
 * When this runner last reached the owner, for its hosts: each host stops its agent once this is
 * older than RUNNER_FENCE_MS, so an agent never outlives a runner that went down for good.
 */
const ownerContactFile=join(stateDir,'owner-contact');
let contactWrittenAt=0;
const recordOwnerContact=()=>{
  const now=Date.now();
  if(now-contactWrittenAt<5_000)return;
  contactWrittenAt=now;
  try{writeFileSync(ownerContactFile+'.tmp',String(now),{mode:0o600});renameSync(ownerContactFile+'.tmp',ownerContactFile);}catch{}
};
const once=process.argv.includes('--once');
const kinds=(process.env.CONCIERGE_RUNNER_KINDS??'probe,turn,codex').split(',').map(kind=>kind.trim()).filter(Boolean);
const maxTurns=Number(process.env.CONCIERGE_RUNNER_MAX_TURNS)||64;
/** This runner's release: the host program and the agents' helpers come from here, never from the owner. */
const botDir=resolve(import.meta.dir,'..');

type HeldAttempt={jobId:string;epoch:number;kind?:string;executionId?:string;manifest?:unknown;watches?:Record<string,string>;lastContactAtMs?:number};
type Held=Record<string,HeldAttempt>;
const readHeld=():Held=>{try{return JSON.parse(readFileSync(held,'utf8'));}catch{return {};}};
const writeHeld=(value:Held)=>{writeFileSync(held+'.tmp',JSON.stringify(value),{mode:0o600});renameSync(held+'.tmp',held);};
const updateHeld=(change:(state:Held)=>void)=>{const state=readHeld();change(state);writeHeld(state);};
const say=(event:string,fields:Record<string,unknown>={})=>console.log(JSON.stringify({event,at:new Date().toISOString(),...fields}));

class OwnerRefusal extends Error {constructor(message:string,readonly code:string|undefined,readonly status:number){super(message);}}
async function call(path:string,body:unknown):Promise<any> {
  const response=await fetch(`${owner}/runner/v1/${path}`,{method:'POST',signal:AbortSignal.timeout(30_000),
    headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json().catch(()=>({ok:false,error:`HTTP ${response.status}`}));
  if(!response.ok)throw new OwnerRefusal(result.detail??result.error??`HTTP ${response.status}`,result.error,response.status);
  return result;
}
async function read(path:string):Promise<any> {
  const response=await fetch(`${owner}/runner/v1/${path}`,{signal:AbortSignal.timeout(30_000),headers:{authorization:`Bearer ${token}`}});
  const result=await response.json().catch(()=>({ok:false,error:`HTTP ${response.status}`}));
  if(!response.ok)throw new OwnerRefusal(result.detail??result.error??`HTTP ${response.status}`,result.error,response.status);
  return result;
}
/** A 404 whose answer is not a runner protocol code: this owner has no runner routes. */
const ownerWithoutRunners=(error:unknown)=>error instanceof OwnerRefusal&&error.status===404&&!/^[A-Z_]+$/.test(error.code??'');
const lostCustody=(error:unknown)=>error instanceof OwnerRefusal&&(error.code==='STALE_EPOCH'||error.code==='UNKNOWN_ATTEMPT');

async function runProbe(job:{jobId:string;attemptId:string;epoch:number;payload:any}) {
  updateHeld(state=>{state[job.attemptId]={jobId:job.jobId,epoch:job.epoch,kind:'probe'};});
  const beat=await call('heartbeat',{attemptId:job.attemptId,epoch:job.epoch});
  const events=[{seq:1,frame:{k:'started',runner:process.env.CONCIERGE_RUNNER_NAME??null,pid:process.pid}},
    {seq:2,frame:{k:'echo',text:job.payload?.text??null,commandsSeen:beat.commands.length}}];
  const acked=await call('events',{attemptId:job.attemptId,epoch:job.epoch,events});
  // A resend of an acknowledged sequence stores nothing twice; this proves it on every probe.
  const again=await call('events',{attemptId:job.attemptId,epoch:job.epoch,events});
  const finished=await call('finish',{attemptId:job.attemptId,epoch:job.epoch,operationId:`finish:${job.attemptId}`,
    result:{echoed:job.payload?.text??null,ackedSeq:acked.ackedSeq,resendAckedSeq:again.ackedSeq}});
  updateHeld(state=>{delete state[job.attemptId];});
  return finished;
}

/**
 * The provider's environment, built here from this runner's own: the owner's environment never
 * travels. The run's own variables (its identity, token, account home, model settings) come from
 * the job; the paths that name a machine (state folder, helper release, Bun) are this runner's.
 */
function turnEnvironment(manifest:{environment:Record<string,string>;inheritEnvironment:boolean}) {
  if(!manifest.inheritEnvironment)return {...manifest.environment};
  const ownerScripts=manifest.environment.CONCIERGE_ROUTER_BOT_DIR?join(manifest.environment.CONCIERGE_ROUTER_BOT_DIR,'scripts'):null;
  const runPath=(manifest.environment.PATH??'').split(':').filter(part=>part&&part!==ownerScripts);
  const basePath=(process.env.PATH??'/usr/local/bin:/usr/bin:/bin').split(':');
  return {...process.env as Record<string,string>,...manifest.environment,
    PATH:[join(botDir,'scripts'),...new Set([...runPath,...basePath])].join(':'),
    CONCIERGE_STATE_DIR:stateDir!,CONCIERGE_STATE_DB:join(stateDir!,'no-ledger-on-a-runner.db'),
    CONCIERGE_ROUTER_BOT_DIR:botDir,CONCIERGE_BUN_BIN:process.execPath,
    // The address this runner reaches the owner at is the one known to work from here.
    CONCIERGE_OWNER_URL:owner!,
    CONCIERGE_RUNNER_NAME:process.env.CONCIERGE_RUNNER_NAME??'',
    // thnkr.ing's network entrance, reached with the same run token (Thinkering's step 2).
    ...(process.env.THINKERING_CAPABILITY_URL?{THINKERING_CAPABILITY_URL:process.env.THINKERING_CAPABILITY_URL}:{})};
}

function resolveExecutable(name:string,environment:Record<string,string>):string|null {
  if(name.includes('/'))return existsSync(name)?name:null;
  return Bun.which(name,{PATH:environment.PATH??process.env.PATH??''});
}

/** One turn job held by this runner: from start (or a restart's resume) to the owner's release. */
class Turn {
  private seq:number;
  private hostSeq:number;
  private queue:{seq:number;frame:unknown}[]=[];
  private connection:HostConnection|null=null;
  private handled=new Set<string>();
  private watches=new Map<string,()=>void>();
  private stopped=false;
  private released=false;
  private exited=false;
  private environment:Record<string,string>={};
  constructor(private readonly job:{jobId:string;attemptId:string;payload:any},private epoch:number,resume?:{ackedSeq:number;hostSeq:number}) {
    this.seq=resume?.ackedSeq??0;this.hostSeq=resume?.hostSeq??0;
  }
  get executionId():string{return String(this.job.payload?.executionId??'');}
  private get directory(){return executionDirectory(stateDir!,this.executionId);}

  private emit(frame:Record<string,unknown>) {
    this.queue.push({seq:++this.seq,frame:{...frame,h:this.hostSeq}});
  }
  /** The next events to send in the runner's sync, oldest first, about 1 MB at most. */
  outgoing(budget:number):{seq:number;frame:unknown}[] {
    const batch=[];let bytes=0;
    for(const event of this.queue){const size=JSON.stringify(event.frame).length;if(batch.length&&bytes+size>budget)break;bytes+=size;batch.push(event);}
    return batch;
  }
  get pending(){return this.queue.length;}
  /** The owner's answer for this attempt in a sync: the durable cursor and unanswered commands. */
  synced(answer:{ok:boolean;ackedSeq?:number;commands?:{commandId:string;kind:string;body:any}[];error?:string;detail?:string}) {
    if(this.stopped)return;
    if(!answer.ok){
      if(answer.error==='STALE_EPOCH'||answer.error==='UNKNOWN_ATTEMPT')this.lose(new Error(answer.detail??answer.error));
      return;
    }
    // Saved at most every half minute, so a runner restarted after a long silence knows to stop it.
    if(Date.now()-this.lastContact>30_000)updateHeld(state=>{const held=state[this.job.attemptId];if(held)held.lastContactAtMs=Date.now();});
    this.lastContact=Date.now();
    this.queue=this.queue.filter(event=>event.seq>answer.ackedSeq!);
    for(const command of answer.commands??[])this.offer(command);
  }
  private lastContact=Date.now();
  private fenced=false;
  /**
   * Out of touch with the owner for RUNNER_FENCE_MS: the owner may soon settle this turn as lost and
   * a later turn may resume the same conversation, so the agent must stop acting now. The attempt is
   * kept: if the owner comes back before the lease passes, the next sync refuses or continues it.
   */
  fenceIfSilent() {
    if(this.stopped||this.fenced||Date.now()-this.lastContact<RUNNER_FENCE_MS)return;
    this.fenced=true;
    say('runner_turn_fenced',{job:this.job.jobId,silentMs:Date.now()-this.lastContact});
    spawnSync('systemctl',['stop',`${executionUnit(this.executionId)}.service`],{timeout:15_000});
  }
  get attempt(){return {attemptId:this.job.attemptId,epoch:this.epoch};}

  private async finish(result:unknown) {
    if(this.stopped)return;
    // Every event is stored before the job ends: the owner reads an ended job's events as complete.
    // An owner out of reach is waited for; the lease, not this loop, decides when the turn is lost.
    while(this.queue.length&&!this.stopped)await Bun.sleep(500);
    if(this.stopped)return;
    // The same operation id makes a repeated finish harmless; an unreachable owner is waited for.
    for(;!this.stopped;) {
      try{await call('finish',{attemptId:this.job.attemptId,epoch:this.epoch,operationId:`finish:${this.job.attemptId}`,result});break;}
      catch(error){if(lostCustody(error))break;say('runner_finish_retry',{job:this.job.jobId,error:String(error)});await Bun.sleep(2_000);}
    }
    if(this.stopped)return;
    this.end();
    say('runner_turn_finished',{job:this.job.jobId,result});
  }
  private end() {
    this.stopped=true;
    for(const stop of this.watches.values())stop();
    this.connection?.close();
    updateHeld(state=>{delete state[this.job.attemptId];});
    turns.delete(this.job.attemptId);
  }
  /**
   * The owner refused this attempt's epoch: its lease passed and the turn is already settled as
   * unconfirmed, or another copy of this runner took it. The local host is stopped only in the
   * first case; a newer copy of this daemon keeps it.
   */
  abandon(why:string){this.lose(new Error(why));}
  private lose(error:unknown) {
    if(this.stopped)return;
    say('runner_turn_custody_lost',{job:this.job.jobId,error:String(error)});
    const state=readHeld()[this.job.attemptId];
    this.end();
    if(!state||state.epoch<=this.epoch)spawnSync('systemctl',['stop',`${executionUnit(this.executionId)}.service`],{timeout:15_000});
  }

  async start() {
    const payload=this.job.payload??{};
    // The manifest is kept here (0600) so a restarted runner can rebuild the provider's environment.
    updateHeld(state=>{state[this.job.attemptId]={jobId:this.job.jobId,epoch:this.epoch,kind:'turn',executionId:this.executionId,manifest:payload.manifest,lastContactAtMs:Date.now()};});
    if(!/^[0-9a-f]{16}$/.test(this.executionId))return this.finish({notStarted:'the turn names no valid execution id'});
    if(!Array.isArray(payload.protocols)||!payload.protocols.includes(HOST_PROTOCOL_VERSION))
      return this.finish({notStarted:`this runner's host speaks protocol ${HOST_PROTOCOL_VERSION}, which the owner does not adopt`});
    const manifest=payload.manifest;
    this.environment=turnEnvironment(manifest);
    const executable=resolveExecutable(String(manifest.executable),this.environment);
    if(!executable)return this.finish({notStarted:`cannot find ${manifest.executable} on this runner`,localPrerequisiteUnavailable:true});
    try {
      for(const file of payload.files??[]) {
        if(!isAbsolute(file.path))throw new HostNotStartedError(`attachment path ${file.path} is not absolute`);
        mkdirSync(dirname(file.path),{recursive:true,mode:0o700});
        writeFileSync(file.path,Buffer.from(String(file.base64),'base64'),{mode:0o600});
      }
      if(!existsSync(manifest.cwd))throw new HostNotStartedError(`the turn's folder ${manifest.cwd} does not exist on this runner`);
      await startHost({stateDir:stateDir!,executionId:this.executionId,routerBotDir:botDir,
        hiddenPaths:(process.env.CONCIERGE_RUNNER_HIDE_PATHS??'').split(':').filter(Boolean),
        manifest:{executable,args:manifest.args,cwd:manifest.cwd,environment:this.environment,initialInput:manifest.initialInput,initialMeta:manifest.initialMeta,
          ownerContact:{file:ownerContactFile,fenceMs:RUNNER_FENCE_MS}}});
    } catch(error) {
      if(error instanceof HostNotStartedError)return this.finish({notStarted:error.message});
      // The supervisor may have started it without answering: custody below decides.
      say('runner_host_start_unanswered',{job:this.job.jobId,error:String(error)});
    }
    await this.follow(true);
  }

  /** A restarted runner takes the turn back: reattach after the host frames the owner already holds. */
  async resume(watches:Record<string,string>={}) {
    this.environment=turnEnvironment(this.job.payload?.manifest??{environment:{},inheritEnvironment:true});
    // Transcript watches the owner asked for before the restart go on; reading from the start again
    // reports pickups made meanwhile, and the owner ignores ones it already counted.
    for(const [id,sessionUuid] of Object.entries(watches))this.watch(id,sessionUuid,true);
    await this.follow(false);
  }

  /** Attach (or reattach) to the local host; when the connection ends, decide from the host itself. */
  private async follow(fresh:boolean) {
    for(let attempt=0;!this.stopped;attempt++) {
      const custody=await hostCustody(this.directory,this.executionId);
      if(custody==='answering') {
        try {
          const connection=fresh&&attempt===0?await connectWhenReady(hostSocketPath(this.directory)):await HostConnection.connect(hostSocketPath(this.directory),3_000);
          // The attachment is reported before any frame, so the owner learns the protocol first.
          const before=await connection.status();
          if(!ADOPTABLE_HOST_PROTOCOLS.includes(before.protocol))throw new Error(`host protocol ${before.protocol} is not adoptable`);
          if(this.seq===0)this.emit({k:'attached',protocol:before.protocol,hostPid:before.hostPid,providerPid:before.providerPid});
          await connection.attach(this.hostSeq+1,frame=>this.frame(frame));
          this.connection=connection;
          const reason=await new Promise<string>(done=>connection.onClosed(done));
          this.connection=null;
          if(this.released){await this.finish({released:true});return;}
          say('runner_host_connection_closed',{job:this.job.jobId,reason});
          fresh=false;
          continue;
        } catch(error){say('runner_host_attach_failed',{job:this.job.jobId,error:String(error)});}
      } else if(custody==='settle-from-record') {
        // The host is gone and its record holds the exit: ship what the owner does not have yet.
        for await(const frame of streamJournal(this.directory))if(frame.s>this.hostSeq)this.frame(frame);
        await this.finish({hostGone:true,exitRecorded:true});
        return;
      } else if(custody==='dead') {
        await this.finish({hostGone:true,exitRecorded:false});
        return;
      }
      await Bun.sleep(attempt<3?1_000:5_000);
    }
  }

  private frame(frame:HostFrame) {
    if(frame.s<=this.hostSeq)return;
    this.hostSeq=frame.s;
    if(frame.k==='x')this.exited=true;
    this.emit({k:'host',f:frame});
  }

  private offer(command:{commandId:string;kind:string;body:any}) {
    {
      if(this.handled.has(command.commandId))return;
      this.handled.add(command.commandId);
      void this.apply(command).then(result=>call('command-results',{attemptId:this.job.attemptId,epoch:this.epoch,results:[{commandId:command.commandId,result}]}))
        .catch(error=>{
          // Unanswered: it is offered again on the next sync and applied again under the same host id.
          this.handled.delete(command.commandId);
          if(lostCustody(error))this.lose(error);
          else say('runner_command_retry',{job:this.job.jobId,command:command.kind,error:String(error)});
        });
    }
  }

  private watch(id:string,sessionUuid:string,fromStart:boolean) {
    this.watches.get(id)?.();
    this.watches.set(id,watchClaudeTranscript({sessionUuid,fromStart,environment:this.environment,
      onPickup:pickup=>this.emit({k:'pickup',watch:id,pickup:{text:pickup.text,uuid:pickup.uuid}})}));
    updateHeld(state=>{const held=state[this.job.attemptId];if(held)held.watches={...held.watches,[id]:sessionUuid};});
  }

  private async apply(command:{commandId:string;kind:string;body:any}):Promise<unknown> {
    const body=command.body??{};
    if(command.kind==='watch-transcript') {
      this.watch(String(body.id),String(body.sessionUuid),body.fromStart===true);
      return {watching:true};
    }
    if(command.kind==='unwatch-transcript'){
      this.watches.get(body.watch)?.();this.watches.delete(body.watch);
      updateHeld(state=>{delete state[this.job.attemptId]?.watches?.[body.watch];});
      return {stopped:true};
    }
    if(command.kind==='stop-superseded')return {stopped:await stopSupersededHost(this.directory,this.executionId)};
    const connection=this.connection;
    if(!connection)throw new Error('not attached to the host yet');
    if(command.kind==='status')return await connection.status(10_000);
    if(!['submit','close','signal','release'].includes(command.kind))return {refused:`unknown command ${command.kind}`};
    try {
      const receipt=await connection.command({...body,op:command.kind,id:String(body.id)});
      if(command.kind==='release')this.released=true;
      return receipt;
    } catch(error) {
      const message=error instanceof Error?error.message:String(error);
      // The host's own refusal is its answer; a lost connection is not and the command is offered again.
      if(message.startsWith('host refused: '))return {refused:message.slice('host refused: '.length)};
      throw error;
    }
  }
}
const turns=new Map<string,Turn>();

// Take back what this runner held before a restart; a stale attempt is no longer this runner's.
// First, a turn this runner has not been able to report for the fencing time is stopped: the owner
// may already have settled it as lost, and the restart must not let its agent keep acting.
const fenceStale=()=>{
  for(const [attemptId,held] of Object.entries(readHeld())) {
    if(held.kind!=='turn'||!held.executionId||Date.now()-(held.lastContactAtMs??0)<RUNNER_FENCE_MS)continue;
    say('runner_turn_fenced',{job:held.jobId,attemptId,silentMs:Date.now()-(held.lastContactAtMs??0)});
    spawnSync('systemctl',['stop',`${executionUnit(held.executionId)}.service`],{timeout:15_000});
  }
};
const before=readHeld();
if(Object.keys(before).length){
  let answer:any=null;
  for(;;){
    fenceStale();
    answer=await call('reacquire',{attemptIds:Object.keys(before)}).catch(error=>{say('runner_reacquire_retry',{error:String(error)});return null;});
    if(answer){recordOwnerContact();break;}
    await Bun.sleep(5_000);
  }
  const {attempts}=answer;
  for(const attempt of attempts) {
    const prior=before[attempt.attemptId]!;
    if(attempt.stale) {
      updateHeld(state=>{delete state[attempt.attemptId];});
      // The owner already settled this turn without us: its host must not keep acting.
      if(prior.kind==='turn'&&prior.executionId)spawnSync('systemctl',['stop',`${executionUnit(prior.executionId)}.service`],{timeout:15_000});
      continue;
    }
    updateHeld(state=>{state[attempt.attemptId]!.epoch=attempt.epoch;state[attempt.attemptId]!.lastContactAtMs=Date.now();});
    if(prior.kind!=='turn')continue; // a reacquired probe is left to expire
    // The last stored event names the host sequence it covered; the host's journal resumes after it.
    const {job}=await read(`jobs/${encodeURIComponent(prior.jobId)}?attempt=${encodeURIComponent(attempt.attemptId)}&after=${Math.max(0,attempt.ackedSeq-1)}`);
    const lastEvent=job.events.at(-1);
    const turn=new Turn({jobId:prior.jobId,attemptId:attempt.attemptId,payload:{executionId:prior.executionId,manifest:prior.manifest}},attempt.epoch,
      {ackedSeq:attempt.ackedSeq,hostSeq:lastEvent?.frame?.h??0});
    turns.set(attempt.attemptId,turn);
    void turn.resume(prior.watches);
  }
  say('runner_reacquired',{attempts});
}
/**
 * Every held turn's events, lease and commands travel in one call per half second: the owner's load
 * grows with runners, not with the number of agents each runs.
 */
let syncing=false;
setInterval(()=>{for(const turn of turns.values())turn.fenceIfSilent();},5_000);
setInterval(async()=>{
  if(syncing||!turns.size)return;
  syncing=true;
  try {
    let budget=2_000_000;
    const sent=[...turns.values()].map(turn=>{const events=turn.outgoing(Math.max(64_000,budget));budget-=events.reduce((sum,event)=>sum+JSON.stringify(event.frame).length,0);return {turn,events};});
    const {attempts}=await call('sync',{attempts:sent.map(({turn,events})=>({...turn.attempt,events}))});
    recordOwnerContact();
    for(const answer of attempts)turns.get(answer.attemptId)?.synced(answer);
  } catch(error){
    say('runner_sync_failed',{error:String(error)});
    // An owner that does not know the runner routes at all (a rollback to a release without them)
    // has already settled these turns as lost: stop their agents now, not after the fencing time.
    if(ownerWithoutRunners(error))for(const turn of [...turns.values()])turn.abandon('the owner does not speak the runner protocol');
  }
  finally{syncing=false;}
},500);

/**
 * Live services this runner offers the owner through its relay (RUNNERS.md "Codex App Server on a
 * runner"): one outbound listen channel; for each `open` the owner's gateway sends, a second
 * outbound WebSocket is paired with a fresh connection to the service here, and messages pass both
 * ways unchanged. This runner's App Server is started here when absent, under the runner's own
 * environment, so the shells it runs carry this runner's owner address and token file.
 */
const relayBase=owner!.replace(/^http/,'ws');
function relayCodexAppServer(id:string) {
  const remote=new WebSocket(`${relayBase}/runner/v1/relay/accept?id=${encodeURIComponent(id)}`,{headers:{authorization:`Bearer ${token}`}} as any);
  const local=new WebSocket(`ws+unix://${codexAppServerSocketPath()}:/`);
  const waiting:(string|ArrayBuffer|Uint8Array)[]=[];
  let ended=false;
  const end=(why:string)=>{
    if(ended)return;ended=true;
    say('runner_relay_closed',{relay:id,why});
    for(const socket of [remote,local])try{socket.close(1011,why.slice(0,120));}catch{}
  };
  remote.binaryType='arraybuffer';local.binaryType='arraybuffer';
  remote.onmessage=event=>{if(local.readyState===WebSocket.OPEN)local.send(event.data);else waiting.push(event.data);};
  local.onopen=()=>{for(const message of waiting.splice(0))local.send(message);};
  local.onmessage=event=>{if(remote.readyState===WebSocket.OPEN)remote.send(event.data);};
  local.onerror=()=>{
    // Nobody listening on the App Server's socket: start it (once per half minute); the owner's
    // client sees this relay end and connects again.
    if(!existsSync(codexAppServerSocketPath())||!controlSocketListeners(codexAppServerSocketPath()).length)startCodexDaemonWhenAbsent('ECONNREFUSED');
    end('the App Server on this runner is not answering');
  };
  local.onclose=event=>end(`App Server closed (${event.code})`);
  remote.onclose=event=>end(`owner side closed (${event.code})`);
  remote.onerror=()=>end('owner side failed');
}
let relayChannel:WebSocket|null=null;
function listenForRelays(delayMs=0) {
  setTimeout(()=>{
    const channel=new WebSocket(`${relayBase}/runner/v1/relay/listen`,{headers:{authorization:`Bearer ${token}`}} as any);
    relayChannel=channel;
    channel.onopen=()=>say('runner_relay_listening');
    channel.onmessage=event=>{
      let message:any;try{message=JSON.parse(String(event.data));}catch{return;}
      if(message?.op==='open'&&message.target==='codex-app-server'&&typeof message.id==='string')relayCodexAppServer(message.id);
    };
    channel.onclose=event=>{
      if(relayChannel!==channel)return;
      say('runner_relay_listen_closed',{code:event.code});
      listenForRelays(5_000);
    };
  },delayMs);
}
if(!once&&kinds.includes('codex'))listenForRelays();

for(let idle=0;;) {
  const jobKinds=kinds.filter(kind=>kind!=='codex');
  const offered=turns.size>=maxTurns?jobKinds.filter(kind=>kind!=='turn'):jobKinds;
  const {job}=offered.length?await call('claim',{kinds:once?['probe']:offered}).catch(error=>{say('runner_claim_failed',{error:String(error)});return {job:null};}):{job:null};
  if(job){
    recordOwnerContact();
    if(job.kind==='turn'){
      const turn=new Turn(job,job.epoch);
      turns.set(job.attemptId,turn);
      void turn.start().catch(error=>say('runner_turn_failed',{job:job.jobId,error:String(error)}));
      say('runner_turn_claimed',{jobId:job.jobId,attemptId:job.attemptId});
      continue;
    }
    const result=job.kind==='probe'?await runProbe(job):null;
    say('runner_job_finished',{jobId:job.jobId,attemptId:job.attemptId,result});
    if(once)break;
    idle=0;continue;
  }
  if(once&&++idle>=15){say('runner_no_job');break;}
  await Bun.sleep(2_000);
}
