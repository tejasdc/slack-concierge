import {createHash,timingSafeEqual,randomUUID} from 'node:crypto';
import {copyFileSync,existsSync,mkdirSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename,join} from 'node:path';
import {sessionProject} from './session-projects';
import {AWAITING_INSPECTION,REMINDERS_SINCE_MS,replyCommand,sameAnswerKey,stalledNotice,strandedStep,tellWorkerCanceled,type OwedRequest} from './request-liveness';
import {REQUEST_PROTOCOL_POINTER} from './request-protocol';
import {db,getSessionById,SETTLED_EXECUTION_SQL} from './state';
import {getAcceptedSessionInput,humanAuthored,isInferredFinal,nativeRunId,recordSessionEvent,recoverUnsentSteeredInput,retainSessionInput,sessionInputProvenance,sessionMetadata,updateSessionMetadata} from './session-inputs';
import {readInputExecution,resolveSessionAddress,sessionAddress,SessionOwnerError,type SessionOwner} from './session-owner';
import {log,errorFields} from './log';
import {presentSessionForPeer,receiveSessionFromPeer} from './peer-identity';

/**
 * A second Concierge instance is a peer: its own ledger, FIFO and recovery on another
 * machine, reached over the tailnet with one shared bearer token. A peer request is the
 * existing `sessions ask` with the target session living in the peer's ledger, so the
 * origin keeps the request and its return obligation while the peer keeps the target's
 * execution. Neither side ever writes the other's database.
 */
/** `paths` are the peer's home prefixes: an archived transcript under one of them belongs to that peer. */
export type PeerSettings={self:string|null;peers:{name:string;url:string;paths:string[];archives:string[]}[];listen:{hostname:string;port:number}|null;token:string|null};
const NAME=/^[a-z][a-z0-9-]{0,31}$/;
export function peerSettings(env:NodeJS.ProcessEnv=process.env):PeerSettings {
  const self=env.CONCIERGE_PEER_NAME?.trim()||null;
  const peers=env.CONCIERGE_PEERS?.trim()?JSON.parse(env.CONCIERGE_PEERS) as unknown:[];
  const listen=env.CONCIERGE_PEER_LISTEN?.trim()||null;
  const tokenPath=env.CONCIERGE_PEER_TOKEN_FILE?.trim()||null;
  if(!self&&!listen&&!tokenPath&&!(Array.isArray(peers)&&peers.length))return {self:null,peers:[],listen:null,token:null};
  if(!self||!NAME.test(self))throw new Error('CONCIERGE_PEER_NAME must name this instance (lowercase letters, digits, dashes).');
  if(!Array.isArray(peers)||peers.some(peer=>typeof peer!=='object'||!peer||!NAME.test((peer as any).name)||typeof (peer as any).url!=='string'||!/^https?:\/\/[^/\s]+$/.test((peer as any).url)
      ||['paths','archives'].some(key=>(peer as any)[key]!==undefined&&(!Array.isArray((peer as any)[key])||(peer as any)[key].some((path:unknown)=>typeof path!=='string'||!path.startsWith('/'))))))
    throw new Error('CONCIERGE_PEERS must be a JSON array of {name,url,paths?,archives?} with an origin-only http(s) URL and absolute paths.');
  if(peers.some(peer=>(peer as any).name===self))throw new Error('CONCIERGE_PEERS cannot list this instance.');
  if(!tokenPath)throw new Error('CONCIERGE_PEER_TOKEN_FILE is required when peers are configured.');
  const token=readFileSync(tokenPath,'utf8').trim();
  if(token.length<32)throw new Error('The peer token must contain at least 32 characters.');
  let bound:{hostname:string;port:number}|null=null;
  if(listen){
    const match=listen.match(/^(.+):(\d{2,5})$/);
    if(!match)throw new Error('CONCIERGE_PEER_LISTEN must be host:port.');
    bound={hostname:match[1]!,port:Number(match[2])};
    if(bound.hostname==='0.0.0.0'||bound.hostname==='::'||bound.hostname==='')throw new Error('CONCIERGE_PEER_LISTEN must bind one tailnet address, never every interface.');
  }
  return {self,peers:(peers as {name:string;url:string;paths?:string[];archives?:string[]}[]).map(peer=>({name:peer.name,url:peer.url,paths:peer.paths??[],archives:peer.archives??[]})),listen:bound,token};
}

export class PeerError extends Error {
  constructor(message:string,readonly kind:'unreachable'|'unauthorized'|'refused',readonly status:number|null=null,readonly code:string|null=null){super(message);}
}
export class PeerClient {
  constructor(readonly name:string,readonly url:string,private readonly token:string,readonly paths:string[]=[],readonly archives:string[]=[]){}
  async request<T=any>(method:'GET'|'POST',path:string,body?:unknown,timeoutMs=20_000):Promise<T> {
    let response:Response;
    try {
      response=await fetch(this.url+path,{method,signal:AbortSignal.timeout(timeoutMs),headers:{authorization:`Bearer ${this.token}`,accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    } catch(error) {
      throw new PeerError(`Peer ${this.name} is unreachable.`,'unreachable',null,'PEER_UNREACHABLE');
    }
    let value:any=null;
    try {value=await response.json();} catch {value=null;}
    if(response.status===401||response.status===403)throw new PeerError(`Peer ${this.name} refused this instance's token.`,'unauthorized',response.status,'PEER_UNAUTHORIZED');
    if(!response.ok){
      const message=typeof value?.error==='string'?value.error:value?.error?.message??`Peer ${this.name} answered ${response.status}.`;
      throw new PeerError(message,'refused',response.status,value?.error?.code??'PEER_REFUSED');
    }
    return value as T;
  }
}

/** The owner API on a tailnet address; one shared token stands in for the socket's file mode. */
export function startPeerListener(input:{hostname:string;port:number;token:string;fetch:(request:Request)=>Promise<Response>}) {
  const expected=Buffer.from(input.token);
  return Bun.serve({hostname:input.hostname,port:input.port,idleTimeout:0,
    async fetch(request) {
      const header=request.headers.get('authorization')??'';
      const presented=Buffer.from(header.startsWith('Bearer ')?header.slice(7):'');
      if(presented.length!==expected.length||!timingSafeEqual(presented,expected))return Response.json({error:{code:'PEER_UNAUTHORIZED',message:'A valid peer token is required.'}},{status:401});
      const url=new URL(request.url);
      if(url.pathname!=='/sessions/v1'&&!url.pathname.startsWith('/sessions/v1/'))return Response.json({error:{code:'NOT_FOUND',message:'Only the session owner API is served to peers.'}},{status:404});
      return input.fetch(request);
    }});
}

type PeerRequestRow={request_id:string;peer:string;source_session_id:number;source_turn_id:number;source_input_id:string;action_id:string;payload_json:string;payload_hash:string;
  remote_session_id:string;remote_address:string;remote_operation_id:string;remote_status_json:string|null;delivery_json:string|null;status:string;outcome:string|null;result_json:string|null;due_at_ms:number;overdue_at_ms:number|null;stalled_at_ms:number|null;created_at_ms:number};
type CatalogueRow={peer:string;remote_session_id:string;address:string;runtime_thread_id:string|null;view_json:string;updated_at_ms:number};
const OFFLINE_MS=60_000;
const evidenceTime=(result:any):string|null=>{const times=(result.evidence??[]).map((item:any)=>item.at).filter((at:unknown)=>typeof at==='string');return times.length?times.sort().pop():null;};
export const offlineNote=(peer:string)=>`${peer} is offline — its sessions come from the transcript archive and its last catalogue and cannot resume until ${peer} is back.`;
type PeerEventRow={event_id:string;request_id:string;kind:'progress'|'final'|'overdue';payload_json:string;status:string;error:string|null;accepted_input_id:string|null;created_at_ms:number};
type DeliveryRow={request_id:string;peer:string;origin_session_id:string;origin_input_id:string;origin_run_id:string;target_session_id:number;target_input_id:string;requested_effect:string;origin_provenance_json:string|null;notified_fingerprint:string|null;closed_at_ms:number|null;reminded_at_ms:number|null;reminded_via:string|null;stalled_at_ms:number|null;stalled_reason:string|null;created_at_ms:number};
type ReplyRow={event_id:string;request_id:string;action_key:string|null;kind:'progress'|'final';payload_json:string;status:string;error:string|null;created_at_ms:number};
export type PeerActor={session:number;turn:number;inputId:string};
type WorkDisposition='completed'|'failed'|'needs_decision';
type Dependencies={self:string;clients:Map<string,PeerClient>;owner:SessionOwner;now?:()=>number;onError:(error:unknown)=>void;isOwnerAlive:(owner:string)=>boolean};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown):Record<string,any>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new SessionOwnerError('A JSON object is required.');return value as Record<string,any>;};
const DUE_MS=30*60*1000;
/** The request ID is a function of the source input and action, so a retry after a lost response reaches the same peer row. */
const requestIdFor=(sourceInputId:string,actionId:string)=>{const h=hash(`peer-request:${sourceInputId}:${actionId}`);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};

export class SessionPeers {
  private readonly tasks=new Map<string,Promise<void>>();
  private readonly again=new Set<string>();
  private scheduled=false;
  private stopped=true;
  private disarm:(()=>void)|null=null;
  private readonly now:()=>number;
  private readonly unreachable=new Map<string,number>();
  constructor(private readonly dependencies:Dependencies){this.now=dependencies.now??Date.now;}
  get self(){return this.dependencies.self;}
  inventory(){return {self:this.self,peers:[...this.dependencies.clients.values()].map(client=>({name:client.name,url:client.url,lastUnreachableAt:this.unreachable.get(client.name)??null}))};}
  async inventoryWithReachability() {
    return {self:this.self,peers:await Promise.all([...this.dependencies.clients.values()].map(async client=>{
      try {const status=await client.request('GET','/sessions/v1/status',undefined,5_000);return {name:client.name,url:client.url,reachable:true,status};}
      catch(error) {return {name:client.name,url:client.url,reachable:false,error:error instanceof Error?error.message:String(error)};}
    }))};
  }
  client(name:unknown):PeerClient {
    if(typeof name!=='string'||!this.dependencies.clients.has(name))throw new SessionOwnerError(`Unknown peer instance${typeof name==='string'?` ${name}`:''}; see sessions peers.`,404,'PEER_UNKNOWN');
    return this.dependencies.clients.get(name)!;
  }
  private note(peer:string,error:unknown) {
    if(error instanceof PeerError&&error.kind==='unreachable'){this.unreachable.set(peer,this.now());return;}
    this.unreachable.delete(peer);
  }
  /** Seen unreachable within the last minute; a probe decides otherwise. */
  offline(peer:string){const at=this.unreachable.get(peer);return at!==undefined&&this.now()-at<OFFLINE_MS;}
  availability(peer:string,state:'live'|'archived-only'=this.offline(peer)?'archived-only':'live'){return this.offline(peer)?{state:'archived-only' as const,reachable:false,note:offlineNote(peer)}:{state,reachable:true,note:null};}
  private readonly catalogueRefreshedAt=new Map<string,number>();
  /** Retain what a peer said about its sessions, so they stay addressable while it is offline. */
  remember(peer:string,views:unknown[]) {
    const now=this.now();
    db.transaction(()=>{
      for(const view of views){
        const item=view as any;
        if(!item||typeof item!=='object'||typeof item.id!=='string'||typeof item.address!=='string')continue;
        const remote=item.id.startsWith(`${peer}:`)?`concierge:${item.id.slice(peer.length+1)}`:item.id;
        const address=item.address.startsWith(`${peer}/`)?item.address.slice(peer.length+1):item.address;
        if(!/^concierge:[1-9][0-9]*$/.test(remote)||!/^session:/.test(address))continue;
        db.query(`INSERT INTO session_peer_catalogue(peer,remote_session_id,address,runtime_thread_id,view_json,updated_at_ms) VALUES(?,?,?,?,?,?)
          ON CONFLICT(peer,remote_session_id) DO UPDATE SET address=excluded.address,runtime_thread_id=excluded.runtime_thread_id,view_json=excluded.view_json,updated_at_ms=excluded.updated_at_ms`)
          .run(peer,remote,address,typeof item.runtimeThreadId==='string'?item.runtimeThreadId:null,JSON.stringify(item),now);
      }
    })();
  }
  async refreshCatalogue(peer:string) {
    const client=this.dependencies.clients.get(peer);
    if(!client||this.now()-(this.catalogueRefreshedAt.get(peer)??0)<OFFLINE_MS)return;
    try {
      const value=await client.request<{sessions:unknown[]}>('GET','/sessions/v1/sessions',undefined,10_000);
      this.remember(peer,(this.qualify(peer,value) as any).sessions??[]);
      this.catalogueRefreshedAt.set(peer,this.now());this.unreachable.delete(peer);
    } catch(error) {this.note(peer,error);}
  }
  private cachedView(peer:string,remote:string):any|null {
    const row=db.query('SELECT * FROM session_peer_catalogue WHERE peer=? AND remote_session_id=?').get(peer,remote) as CatalogueRow|null;
    return row?{...JSON.parse(row.view_json),peer,availability:this.availability(peer),lastSeenAt:new Date(row.updated_at_ms).toISOString()}:null;
  }
  private cachedByThread(threadId:string):{peer:string;view:any}|null {
    const row=db.query('SELECT * FROM session_peer_catalogue WHERE runtime_thread_id=? ORDER BY updated_at_ms DESC LIMIT 1').get(threadId) as CatalogueRow|null;
    return row?{peer:row.peer,view:this.cachedView(row.peer,row.remote_session_id)}:null;
  }
  private peerForPath(path:unknown):string|null {
    if(typeof path!=='string')return null;
    for(const client of this.dependencies.clients.values())if(client.paths.some(prefix=>path.startsWith(prefix)))return client.name;
    return null;
  }
  /** Which peer's home holds this absolute path, or null when no peer claims it. */
  instanceForPath(path:string):string|null{return this.peerForPath(path);}
  /** Read a Markdown file from the machine that holds it. The peer applies its own workspace boundary. */
  async readFile(peer:string,path:string){return this.client(peer).request('GET','/sessions/v1/files?'+new URLSearchParams({path,machine:peer}),undefined,20_000);}
  /** Configured peers in the order they were given, for surfaces that show every machine. */
  names():string[]{return [...this.dependencies.clients.keys()];}
  /**
   * A peer's own provider accounts and the logins that change them. The login itself runs on
   * the peer, under the peer's own Concierge, which is the only place allowed to write that
   * machine's credentials.
   *
   * The read names the peer as its own machine so it answers locally instead of fanning out
   * to its own peers and back here; that is the same recursion guard `readFile` uses. A
   * change needs no guard — arriving without a machine already means "this one" — so it is
   * forwarded exactly as the route has always accepted it, and a peer still running an older
   * build signs itself in rather than rejecting a field it has never heard of.
   */
  async authProviders(peer:string){return this.client(peer).request('GET','/sessions/v1/auth/providers?'+new URLSearchParams({machine:peer}),undefined,8_000);}
  async authAction(peer:string,path:string,body:Record<string,unknown>,timeoutMs:number){return this.client(peer).request('POST',`/sessions/v1/auth/${path}`,body,timeoutMs);}
  async projects(peer:string){return this.client(peer).request('GET','/sessions/v1/projects');}
  async search(peer:string,concepts:string[],limit?:number):Promise<any>{return this.qualify(peer,await this.client(peer).request('POST','/sessions/v1/search',{query:concepts.join(' '),...(limit===undefined?{}:{limit})},8_000));}
  async context(peer:string,address:string):Promise<any>{return this.qualify(peer,await this.client(peer).request('POST','/sessions/v1/context',{address},8_000));}
  /** A peer's answer names its sessions as `<peer>:<n>` and its addresses as `<peer>/session:…`, so an agent can use them directly. */
  private qualify(peer:string,value:unknown):unknown {
    const walk=(item:unknown):unknown=>{
      if(typeof item==='string')return /^concierge:[1-9][0-9]*$/.test(item)?`${peer}:${item.slice(10)}`:/^session:[A-Za-z0-9_-]+$/.test(item)?`${peer}/${item}`:item;
      if(Array.isArray(item))return item.map(walk);
      if(item&&typeof item==='object'){const out:Record<string,unknown>={};for(const [key,child] of Object.entries(item as Record<string,unknown>))out[key]=walk(child);if('address' in out&&'id' in out)out.peer=peer;return out;}
      return item;
    };
    return walk(value);
  }
  /**
   * Every session the agent can reach, wherever it lives. The transcript archive on this
   * instance is the primary index — it holds both machines' history and answers whether a
   * peer is on or off — so an archived transcript that belongs to a peer session is shown
   * as that session, marked offline when the peer does not answer. A live peer answer only
   * adds sessions the archive has not seen yet and says which are running now.
   */
  async federatedSearch(local:()=>Promise<any>,concepts:string[],limit?:number) {
    const [own,...peers]=await Promise.all([local(),...[...this.dependencies.clients.keys()].map(async name=>{
      try{const value=await this.search(name,concepts,limit);this.unreachable.delete(name);this.remember(name,(value?.results??[]).map((result:any)=>result.session));return {name,value,error:null};}
      catch(error){this.note(name,error);return {name,value:null,error:error instanceof Error?error.message:String(error)};}
    })]);
    const merged=new Map<string,any>();
    const add=(result:any)=>{const id=result.session?.id;const prior=id?merged.get(id):null;
      if(prior){prior.evidence=[...prior.evidence,...(result.evidence??[])];if(result.session.execution)prior.session={...prior.session,...result.session};}
      else merged.set(id??`local:${merged.size}`,{...result,evidence:[...(result.evidence??[])]});};
    for(const result of own.results as any[]){
      const session=result.session;
      if(session?.origin==='imported'){
        let threadId:string|null=null;
        try{const key=JSON.parse(session.nativeKey??'null');threadId=Array.isArray(key)?String(key[key.length-1]):null;}catch{}
        const cached=threadId?this.cachedByThread(threadId):null;
        if(cached?.view){
          // The archive transcript is this peer session's own history; present the session, keep the passages.
          // Until the live peer confirms it below, the archive alone vouches for it.
          add({...result,session:{...cached.view,availability:{...cached.view.availability,state:'archived-only'}},archive:{sessionId:session.id,address:session.address,archivedAt:evidenceTime(result)},evidence:(result.evidence??[]).map((item:any)=>({...item,sessionId:cached.view.id}))});
          continue;
        }
        const peer=this.peerForPath(session.project);
        if(peer){add({...result,session:{...session,peer,archived:true,availability:{...this.availability(peer),note:this.offline(peer)?offlineNote(peer):`Transcript archived from ${peer}; not a Concierge session there.`}}});continue;}
      }
      add(result);
    }
    const omissions=[...(own.coverage?.omissions??[])];let complete=own.coverage?.complete!==false;const availability:Record<string,{state:'live'|'archived-only';reachable:boolean;note:string|null}>={};
    for(const peer of peers){
      availability[peer.name]=peer.error?{state:'archived-only',reachable:false,note:offlineNote(peer.name)}:{state:'live',reachable:true,note:null};
      if(peer.error){complete=false;omissions.push(offlineNote(peer.name));continue;}
      for(const result of (peer.value?.results??[]) as any[])add({...result,session:{...result.session,availability:{state:'live',reachable:true,note:null}}});
      if(peer.value?.coverage?.complete===false)complete=false;
      omissions.push(...((peer.value?.coverage?.omissions??[]) as string[]).map(item=>`${peer.name}: ${item}`));
    }
    // A peer that did not answer may hold sessions newer than the archive's last push; its
    // last catalogue still names them. A catalogue-only match carries no dialogue evidence.
    const needles=concepts.map(concept=>concept.toLowerCase());
    for(const [name,state] of Object.entries(availability)){
      if(state.reachable)continue;
      for(const row of db.query('SELECT * FROM session_peer_catalogue WHERE peer=? ORDER BY updated_at_ms DESC LIMIT 500').all(name) as CatalogueRow[]){
        const view=JSON.parse(row.view_json);
        const haystack=`${view.title??''} ${view.summary??''} ${view.project??''}`.toLowerCase();
        if(!needles.some(needle=>haystack.includes(needle)))continue;
        if(merged.has(view.id))continue;
        add({session:{...view,peer:name,availability:{...state,state:'archived-only'},lastSeenAt:new Date(row.updated_at_ms).toISOString()},evidence:[],catalogueOnly:true});
      }
    }
    const results=[...merged.values()].slice(0,limit&&limit>0?Math.max(limit,own.results.length):undefined);
    log('info','session_peer_search',{local:own.results.length,merged:results.length,offline:Object.entries(availability).filter(([,value])=>!value.reachable).map(([name])=>name),
      peerSessions:results.filter((result:any)=>result.session?.peer).map((result:any)=>`${result.session.id}${result.archive?'@archive':result.catalogueOnly?'@catalogue':result.session.archived?'@archived':'@live'}`).slice(0,12)});
    return {...own,results,coverage:{...own.coverage,complete,omissions,peers:availability,sources:(own.coverage?.sources??0)+peers.reduce((sum,peer)=>sum+Number(peer.value?.coverage?.sources??0),0)}};
  }
  /** Where a peer session's transcript sits in this instance's archive, if it has been pushed here. */
  archivedTranscript(peer:string,threadId:string):{path:string;archivedAt:string}|null {
    const client=this.dependencies.clients.get(peer);
    if(!client||!/^[0-9a-f-]{36}$/i.test(threadId))return null;
    const matches=(root:string):string[]=>{
      let out:string[]=[];
      let entries:import('node:fs').Dirent[];
      try{entries=readdirSync(root,{withFileTypes:true});}catch{return out;}
      for(const entry of entries){
        const path=join(root,entry.name);
        if(entry.isDirectory())out=out.concat(matches(path));
        else if(entry.isFile()&&entry.name.endsWith('.jsonl')&&entry.name.includes(threadId))out.push(path);
      }
      return out;
    };
    const found=client.archives.flatMap(matches).map(path=>({path,mtime:statSync(path).mtimeMs})).sort((a,b)=>b.mtime-a.mtime)[0];
    return found?{path:found.path,archivedAt:new Date(found.mtime).toISOString()}:null;
  }
  /**
   * A new process on this instance continuing a peer session's archived transcript: the
   * provider's own resume by session UUID, fed the transcript copied into its local store.
   * The peer's session stays parked; this is a distinct session with `resurrection` lineage.
   */
  resurrect(peer:string,address:string,options:{createSession:(provider:'claude-code'|'codex',metadata:Record<string,unknown>)=>{id:number};bind:(sessionId:number,provider:'claude-code'|'codex',uuid:string)=>void;defaultCwd:string}) {
    this.client(peer);
    let tuple:any=null;try{tuple=JSON.parse(Buffer.from(address.slice(8),'base64url').toString());}catch{}
    const remote=Array.isArray(tuple)&&Number.isSafeInteger(tuple[1])?`concierge:${tuple[1]}`:null;
    const view=remote?this.cachedView(peer,remote):null;
    if(!view)throw new SessionOwnerError(`This ${peer} session has not been seen by this instance yet, so there is nothing to resurrect from.`,404,'PEER_SESSION_UNKNOWN');
    const provider=view.provider;
    if(provider!=='claude-code'&&provider!=='codex')throw new SessionOwnerError('Only Claude and Codex sessions can be resurrected from a transcript.',409,'CAPABILITY_UNAVAILABLE');
    const threadId=view.runtimeThreadId;
    if(typeof threadId!=='string'||!threadId)throw new SessionOwnerError('This session never bound a provider transcript, so there is nothing to resurrect.',409,'CAPABILITY_UNAVAILABLE');
    const presented=this.presentedSession(peer,remote!);
    const existing=db.query("SELECT id FROM sessions WHERE status<>'archived' AND json_extract(native_metadata_json,'$.resurrection.sessionId')=? AND json_extract(native_metadata_json,'$.resurrection.threadId')=?").get(presented,threadId) as {id:number}|null;
    if(existing)return {sessionId:existing.id,reused:true};
    const archived=this.archivedTranscript(peer,threadId);
    if(!archived)throw new SessionOwnerError(`${peer}'s transcript for this session has not reached this instance's archive yet (it is pushed every few minutes); try again shortly or wait for ${peer}.`,409,'ARCHIVE_NOT_YET_SYNCED');
    const projectName=typeof view.project==='string'?basename(view.project.replace(/\/+$/,'')):null;
    const project=projectName?sessionProject(options.defaultCwd,projectName):null;
    if(!project)throw new SessionOwnerError(`This instance has no registered project folder named ${projectName??'(unknown)'} to resurrect into.`,409,'PROJECT_UNAVAILABLE');
    // Place the transcript where the provider's own resume finds it for this cwd.
    let destination:string;
    if(provider==='claude-code'){
      const slug=project.cwd.replace(/[\/.]/g,'-');
      destination=join(homedir(),'.claude','projects',slug,`${threadId}.jsonl`);
    } else {
      const day=archived.archivedAt.slice(0,10).split('-');
      destination=join(homedir(),'.codex','sessions',day[0]!,day[1]!,day[2]!,basename(archived.path));
    }
    if(!existsSync(destination)){mkdirSync(join(destination,'..'),{recursive:true,mode:0o700});copyFileSync(archived.path,destination);}
    const created=options.createSession(provider,{origin:'reconstructed',purpose:view.purpose??'chat',title:`${view.title} (resurrected from ${peer})`,cwd:project.cwd,project:project.cwd,
      ...(view.model?{model:view.model}:{}),...(view.reasoningEffort?{reasoningEffort:view.reasoningEffort}:{}),
      resurrection:{peer,sessionId:presented,address:`${peer}/${address}`,threadId,archivedAt:archived.archivedAt,archivePath:archived.path,resurrectedAt:new Date(this.now()).toISOString()}});
    options.bind(created.id,provider,threadId);
    log('info','session_peer_resurrected',{peer,remote_session:presented,session_id:created.id,provider});
    return {sessionId:created.id,reused:false};
  }
  /** Context for a peer session while the peer is offline: its last catalogue view plus its archived transcript here. */
  async offlineContext(peer:string,address:string,localContext:(address:string)=>Promise<any>) {
    let tuple:any=null;try{tuple=JSON.parse(Buffer.from(address.slice(8),'base64url').toString());}catch{}
    const remote=Array.isArray(tuple)&&Number.isSafeInteger(tuple[1])?`concierge:${tuple[1]}`:null;
    const view=remote?this.cachedView(peer,remote):null;
    if(!view)throw new SessionOwnerError(`${offlineNote(peer)} This session has not been seen by this instance yet.`,503,'PEER_UNREACHABLE');
    const threadId=view.runtimeThreadId;
    const archived=threadId?db.query("SELECT id,binding_generation FROM sessions WHERE json_extract(native_metadata_json,'$.origin')='imported' AND json_extract(native_metadata_json,'$.source.nativeId')=? ORDER BY id DESC LIMIT 1").get(threadId) as {id:number}|null:null;
    if(!archived)return {session:view,evidence:[],hasMore:false,offline:true,note:`${offlineNote(peer)} No archived transcript of this session is indexed here yet.`};
    const context=await localContext(sessionAddress(getSessionById(archived.id)!));
    return {...context,session:view,archive:context.session,offline:true,note:`${offlineNote(peer)} Dialogue below comes from the archived transcript.`};
  }
  /** `<peer>/session:…` names a session on that peer; anything else is local. */
  splitAddress(address:unknown):{peer:string;address:string}|null {
    if(typeof address!=='string')return null;
    const match=address.match(/^([a-z][a-z0-9-]{0,31})\/(session:[A-Za-z0-9_-]+)$/);
    return match&&this.dependencies.clients.has(match[1]!)?{peer:match[1]!,address:match[2]!}:null;
  }

  // ---- origin side: a request this instance sent to a peer ----
  private row(id:string):PeerRequestRow {
    const row=db.query('SELECT * FROM session_peer_requests WHERE request_id=?').get(id) as PeerRequestRow|null;
    if(!row)throw new SessionOwnerError('Unknown session request.',404);
    return row;
  }
  owns(requestId:string){return !!db.query('SELECT 1 FROM session_peer_requests WHERE request_id=?').get(requestId);}
  hasDelivery(requestId:string){return !!db.query('SELECT 1 FROM session_peer_deliveries WHERE request_id=?').get(requestId);}
  private presentedSession(peer:string,remote:string){return receiveSessionFromPeer(remote,peer,this.self);}
  private presentedAddress(peer:string,address:string){return address.startsWith('session:')?`${peer}/${address}`:address;}
  async ask(actor:PeerActor,input:{peer:string;action_id:string;address?:string;provider?:string;effort?:string;project?:string;title?:string;text:string;
    requestedEffect?:'informational'|'work';files?:{name:string;contentType:string;base64:string}[];attachments?:string[];captureId?:string;evidence?:unknown[]}) {
    if(this.stopped)throw new Error('Session communication is not accepting requests.');
    const client=this.client(input.peer);
    const effect=input.requestedEffect??'informational';
    const encoded=JSON.stringify({peer:input.peer,...(input.provider?{provider:input.provider}:{address:input.address}),...(input.title===undefined?{}:{title:input.title}),text:input.text,
      ...(input.effort===undefined?{}:{effort:input.effort}),...(input.project===undefined?{}:{project:input.project}),...(input.files===undefined?{}:{files:input.files}),
      ...(input.captureId===undefined?{}:{captureId:input.captureId}),...(input.attachments?{attachments:input.attachments}:{}),...(input.evidence?{evidence:input.evidence}:{}),requestedEffect:effect});
    const digest=hash(encoded);
    const prior=()=>db.query('SELECT * FROM session_peer_requests WHERE source_input_id=? AND action_id=?').get(actor.inputId,input.action_id) as PeerRequestRow|null;
    const previous=prior();
    if(previous){if(previous.payload_hash!==digest)throw new Error('Idempotency conflict: this source/action already names a different request.');return this.receipt(previous);}
    const id=requestIdFor(actor.inputId,input.action_id);
    const owner=this.dependencies.owner;
    const captured=input.captureId?owner.inboxCaptureAttachments(input.captureId):[];
    const files=[...(input.files??[]),...[...(input.attachments??[]),...captured].map(attachmentId=>owner.attachment(attachmentId))]
      .map(({name,contentType,base64})=>({name,contentType,base64}));
    const sourceInput=getAcceptedSessionInput(actor.inputId)!;
    const provenance=sessionInputProvenance(sourceInput);
    const runId=nativeRunId(actor.turn);
    // A human message asking directly is its own originating human; a local walk would find it as the parent.
    const known=provenance?.originatingHuman??(humanAuthored(sourceInput)
      ?{inputId:sourceInput.id,runId,sessionId:`concierge:${actor.session}`,...(JSON.parse(sourceInput.payload_json).capture?.id?{captureId:JSON.parse(sourceInput.payload_json).capture.id}:{})}:null);
    // Every identity leaving this instance is named by it (peer-identity.ts).
    const originatingHuman=known?{...known,sessionId:presentSessionForPeer(known.sessionId,this.self)}:null;
    const text=`Session request ${id} from ${this.self}/concierge:${actor.session}, a session on the ${this.self} Concierge instance. This is agent-authored input within the originating human task, not a new human message. Requested effect: ${effect}. Close it with sessions reply ${id}${effect==='work'?' --work-disposition completed|failed|needs_decision':''}. ${REQUEST_PROTOCOL_POINTER}\n\n${input.text}`;
    const delivery={requestId:id,origin:{peer:this.self,sessionId:`concierge:${actor.session}`,inputId:actor.inputId,runId,originatingHuman,effectScope:provenance?.effectScope??null},
      ...(input.provider?{provider:input.provider,...(input.effort===undefined?{}:{effort:input.effort}),...(input.project===undefined?{}:{project:input.project}),...(input.title===undefined?{}:{title:input.title})}:{address:input.address}),
      text,message:input.text,requestedEffect:effect,...(files.length?{files}:{})};
    let accepted:{sessionId:string;address:string;operationId:string};
    let queued=false;
    try {
      accepted=await client.request('POST','/sessions/v1/peers/requests',delivery);
      this.unreachable.delete(input.peer);
      if(typeof accepted?.sessionId!=='string'||typeof accepted.address!=='string'||typeof accepted.operationId!=='string')throw new Error('The peer did not return the accepted session.');
    } catch(error) {
      this.note(input.peer,error);
      if(!(error instanceof PeerError&&error.kind==='unreachable'))throw error;
      // The peer is off: keep the exact delivery and hand it over when the peer answers again.
      // An addressed session is already known by its address; a new session has no identity yet.
      let tuple:any=null;try{tuple=JSON.parse(Buffer.from((input.address??'').slice(8),'base64url').toString());}catch{}
      accepted={sessionId:Array.isArray(tuple)&&Number.isSafeInteger(tuple[1])?`concierge:${tuple[1]}`:'',address:input.address??'',operationId:`request:${id}`};
      queued=true;
    }
    const now=this.now();
    db.transaction(()=>{
      const raced=prior();
      if(raced){if(raced.payload_hash!==digest)throw new Error('Idempotency conflict: this source/action already names a different request.');return;}
      db.query(`INSERT INTO session_peer_requests(request_id,peer,source_session_id,source_turn_id,source_input_id,action_id,payload_json,payload_hash,remote_session_id,remote_address,remote_operation_id,delivery_json,status,due_at_ms,created_at_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.peer,actor.session,actor.turn,actor.inputId,input.action_id,JSON.stringify({...JSON.parse(encoded),files:files.map(({name,contentType,base64})=>({name,contentType,sha256:createHash('sha256').update(Buffer.from(base64,'base64')).digest('hex')}))}),digest,accepted.sessionId,accepted.address,accepted.operationId,queued?JSON.stringify(delivery):null,queued?'queued_offline':'recorded',now+DUE_MS,now);
      const operation=retainSessionInput({sessionId:actor.session,scope:`communication:${actor.inputId}`,actionId:input.action_id,kind:'request',origin:'agent',
        payload:{text:input.text,sourceInputId:actor.inputId,sourceRunId:runId,peer:input.peer,targetSessionId:this.presentedSession(input.peer,accepted.sessionId),targetAddress:accepted.address,
          ...(input.provider?{targetProvider:input.provider}:{}),...(input.title===undefined?{}:{title:input.title}),afterRequestIds:[],requestedEffect:effect,...(input.evidence?{evidence:input.evidence}:{}),...(queued?{queuedOffline:true}:{})},
        sourceInputId:actor.inputId,sourceRunId:runId,requestId:id}).input;
      recordSessionEvent({eventId:`request:${id}`,sessionId:actor.session,inputId:operation.id,turnId:actor.turn,kind:'request',payload:{requestId:id,peer:input.peer,targetSessionId:this.presentedSession(input.peer,accepted.sessionId)}});
    })();
    this.wake();
    return this.receipt(this.row(id));
  }
  receipt(row:PeerRequestRow) {
    const remote=row.remote_status_json?JSON.parse(row.remote_status_json):null;
    const execution=remote?.execution;
    const queued=row.status==='queued_offline';
    return {request_id:row.request_id,status:row.status,outcome:row.outcome,peer:row.peer,source_session_id:`concierge:${row.source_session_id}`,
      availability:queued?{reachable:false,note:`${row.peer} is offline; this ask is queued here and will be delivered when ${row.peer} wakes.`}:this.availability(row.peer),
      target_address:row.remote_address?this.presentedAddress(row.peer,row.remote_address):null,target:row.remote_session_id?this.cachedView(row.peer,row.remote_session_id):null,target_session_id:row.remote_session_id?this.presentedSession(row.peer,row.remote_session_id):null,target_input_id:row.remote_operation_id,
      operation_id:(db.query("SELECT id FROM session_inputs WHERE request_id=? AND kind='request' ORDER BY rowid LIMIT 1").get(row.request_id) as {id:string}|null)?.id??null,
      routed_request_id:null,target_turn_id:null,due_at_ms:row.due_at_ms,overdue_at_ms:row.overdue_at_ms,result:row.result_json?JSON.parse(row.result_json):null,
      remote:remote?{inputState:remote.inputState,inputError:remote.inputError??null,stillWorking:remote.stillWorking,observedAt:remote.observedAt}:null,
      execution:execution?{turn_id:execution.turnId,run_id:execution.runId,input_kind:execution.steeringStatus?'steering':'turn',input_status:execution.steeringStatus??execution.status,acknowledged_at:execution.acknowledgedAt??null,provider_turn_id:null,peer:row.peer}:null,
      events:(db.query('SELECT * FROM session_peer_events WHERE request_id=? ORDER BY rowid').all(row.request_id) as PeerEventRow[])
        .map(event=>({event_id:event.event_id,kind:event.kind,status:event.status,error:event.error,payload:JSON.parse(event.payload_json),routed_request_id:null}))};
  }
  inspect(requestId:string){return this.receipt(this.row(requestId));}
  get(actor:PeerActor,requestId:string) {
    if(this.owns(requestId)){const row=this.row(requestId);if(row.source_session_id!==actor.session)throw new Error('Request is outside this session.');return this.receipt(row);}
    const delivery=this.delivery(requestId);
    if(delivery.target_session_id!==actor.session)throw new Error('Request is outside this session.');
    return this.deliveryReceipt(delivery);
  }
  cancel(actor:PeerActor,requestId:string,actionId:string) {
    const row=this.row(requestId);
    if(row.source_session_id!==actor.session)throw new Error('Only the requesting session can cancel this request.');
    db.transaction(()=>{
      const retained=retainSessionInput({sessionId:actor.session,scope:`communication:${actor.inputId}`,actionId,kind:'cancel',origin:'agent',
        payload:{requestId,sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn)},sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn),requestId});
      if(retained.duplicate)return;
      db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'completed'}),retained.input.id);
      if(!row.outcome)this.settle(row,'canceled','The requesting session canceled this request. The worker on the peer is told to stop.');
    })();
    // Tell the peer now; if it is unreachable, it learns at its next report, which returns the outcome.
    const client=this.dependencies.clients.get(row.peer);
    if(!row.outcome&&client)void client.request('POST',`/sessions/v1/peers/requests/${encodeURIComponent(requestId)}/cancel`,{}).catch(error=>log('warn','session_peer_cancel_unsent',{request_id:requestId,peer:row.peer,...errorFields(error)}));
    return this.receipt(this.row(requestId));
  }
  private event(row:PeerRequestRow,kind:PeerEventRow['kind'],payload:unknown,eventId=randomUUID()) {
    if(db.query('SELECT 1 FROM session_peer_events WHERE event_id=?').get(eventId))return eventId;
    db.query('INSERT INTO session_peer_events(event_id,request_id,kind,payload_json,created_at_ms) VALUES(?,?,?,?,?)').run(eventId,row.request_id,kind,JSON.stringify(payload),this.now());
    recordSessionEvent({eventId,sessionId:row.source_session_id,inputId:row.source_input_id,kind:'response',payload:{requestId:row.request_id,kind,...payload as object}});
    const session=getSessionById(row.source_session_id)!;
    updateSessionMetadata(session.id,{generation:(sessionMetadata(session).generation??0)+1});
    return eventId;
  }
  private settle(row:PeerRequestRow,outcome:string,text:string,output:unknown=null,disposition:WorkDisposition|null=null) {
    db.transaction(()=>{
      if(this.row(row.request_id).outcome)return;
      const payload={outcome,text,output,responding_session_id:this.presentedSession(row.peer,row.remote_session_id),...(disposition?{workDisposition:disposition}:{})};
      const final=this.currentFinal(row.request_id);
      if(final){
        const declared=JSON.parse(final.payload_json);
        if(declared.workDisposition!=='completed')throw new Error('A final reply already exists for this request.');
        // The result keeps the files that reply carried.
        db.query("UPDATE session_peer_requests SET status='settled',outcome=?,result_json=? WHERE request_id=?").run(outcome,JSON.stringify({...payload,...(declared.attachments?.length?{attachments:declared.attachments}:{}),event_id:final.event_id,declaredDisposition:'completed'}),row.request_id);
        return;
      }
      const event_id=this.event(row,'final',payload);
      db.query("UPDATE session_peer_requests SET status='settled',outcome=?,result_json=? WHERE request_id=?").run(outcome,JSON.stringify({...payload,event_id}),row.request_id);
    })();
    this.wake();
  }
  /** A reply the peer's recipient forwarded here; the peer's own reply ledger already holds it. */
  receiveReply(requestId:string,body:unknown) {
    const input=object(body);
    const row=this.row(requestId);
    if(input.responder?.peer!==row.peer)throw new SessionOwnerError('This reply does not come from the request’s peer.',403,'PEER_MISMATCH');
    const recorded=this.recordReply(row,input);
    this.wake();
    // The recipient marks its reply forwarded only on this event-specific answer; a reply this
    // instance refused used to be acknowledged with the request's outcome and was lost silently.
    return {outcome:this.row(requestId).outcome,eventId:input.eventId,...recorded};
  }
  /** Whether this instance now holds the reply: recorded, already held, or refused with the reason. */
  private recordReply(row:PeerRequestRow,input:Record<string,any>):{recorded:'recorded'|'duplicate'|'refused';reason?:string} {
    const requestId=row.request_id;
    if(input.files!==undefined&&(!Array.isArray(input.files)||input.files.some((file:any)=>typeof file?.name!=='string'||typeof file?.contentType!=='string'||typeof file?.base64!=='string')))throw new SessionOwnerError('Files must contain named attachment bytes.');
    // A reply carrying files is a message even without words.
    if(typeof input.eventId!=='string'||!input.eventId||!['progress','final'].includes(input.kind)||typeof input.text!=='string'||(!input.text.trim()&&!input.files?.length))throw new SessionOwnerError('A reply needs an event ID, kind and either text or a file.');
    const final=input.kind==='final';
    const disposition:WorkDisposition|undefined=input.workDisposition;
    const requestedEffect=JSON.parse(row.payload_json).requestedEffect;
    if(disposition!==undefined&&(!final||requestedEffect!=='work'||!['completed','failed','needs_decision'].includes(disposition)))throw new SessionOwnerError('A work disposition requires a final reply to a work request.');
    const result=db.transaction(():{recorded:'recorded'|'duplicate'|'refused';reason?:string}=>{
      if(db.query('SELECT 1 FROM session_peer_events WHERE event_id=?').get(input.eventId))return {recorded:'duplicate'};
      // The owner's own inference from a finished turn is not the recipient's word: a recipient
      // still working past it can answer, and that answer returns to the requester.
      const current=this.currentFinal(requestId);
      const inferred=isInferredFinal(current)?current:null;
      if(this.row(requestId).outcome&&!inferred)return {recorded:'refused',reason:`This request already has a final disposition (${this.row(requestId).outcome}).`};
      if(final&&current&&!inferred)return {recorded:'refused',reason:'This request already has a final reply.'};
      // The peer's bytes become this instance's own custody, keyed by request, event and
      // position, so a re-forward of the same reply reuses it instead of duplicating it.
      const attachments=((input.files??[]) as {name:string;contentType:string;base64:string}[])
        .map((file,index)=>this.dependencies.owner.upload({name:file.name,contentType:file.contentType,base64:file.base64,
          clientActionId:`peer-reply-file:${requestId}:${input.eventId}:${index}`}).attachment.id);
      const payload={text:input.text,final,source:{peer:row.peer,input_id:input.responder?.inputId,run_id:input.responder?.runId},responding_session_id:this.presentedSession(row.peer,input.responder?.sessionId??row.remote_session_id),
        ...(attachments.length?{attachments}:{}),
        ...(disposition?{workDisposition:disposition,completionTurnId:input.completionTurnId??null}:{}),...(input.evidence?{evidence:input.evidence}:{})};
      if(final&&inferred)db.query('UPDATE session_peer_events SET superseded_by_event_id=? WHERE event_id=?').run(input.eventId,inferred.event_id);
      const id=this.event(row,final?'final':'progress',payload,input.eventId);
      if(final){
        // Declared completion settles when the reply arrives, not when the peer's run ends.
        const outcome=disposition==='failed'?'failed':disposition==='needs_decision'?'decision_needed':disposition==='completed'?'answered':requestedEffect==='work'?'undetermined':'answered';
        db.query('UPDATE session_peer_requests SET outcome=?,status=?,result_json=? WHERE request_id=?').run(outcome,'settled',JSON.stringify({...payload,event_id:id}),requestId);
      }
      log('info','session_peer_reply_recorded',{request_id:requestId,peer:row.peer,kind:input.kind,event_id:input.eventId,...(final&&inferred?{superseded_event_id:inferred.event_id}:{})});
      return {recorded:'recorded'};
    })();
    if(result.recorded==='refused')log('warn','session_peer_reply_refused',{request_id:requestId,peer:row.peer,kind:input.kind,event_id:input.eventId,reason:result.reason});
    return result;
  }
  /**
   * Record a reply read from the peer's status. A reply with files is fetched whole first, because
   * recording its event ID from the summary would make the later full push a duplicate and lose
   * the files. When that fetch fails the event stays unrecorded: an ordinary pull leaves it to the
   * peer's push, and historical recovery (whose replies the peer will never push again) throws so
   * the peer stays in `unrecovered` and the whole reply is fetched on a later attempt.
   */
  private async pullReply(client:PeerClient,row:PeerRequestRow,reply:any,historical:boolean) {
    const responder={peer:row.peer,sessionId:row.remote_session_id,inputId:reply.sourceInputId??null,runId:reply.sourceRunId??null};
    if(!reply.files)return this.recordReply(this.row(row.request_id),{eventId:reply.eventId,kind:reply.kind,text:reply.text,workDisposition:reply.workDisposition??undefined,completionTurnId:reply.completionTurnId??null,evidence:reply.evidence??undefined,responder});
    let whole:any;
    try {whole=await client.request<any>('GET',`/sessions/v1/peers/requests/${encodeURIComponent(row.request_id)}/replies/${encodeURIComponent(reply.eventId)}`);}
    catch(error) {
      log('warn','session_peer_reply_fetch_failed',{request_id:row.request_id,peer:row.peer,event_id:reply.eventId,historical,...errorFields(error)});
      if(historical)throw error;
      return null;
    }
    return this.recordReply(this.row(row.request_id),whole);
  }
  /** The request's final that still stands; a superseded inference is history. */
  private currentFinal(requestId:string){
    return db.query("SELECT * FROM session_peer_events WHERE request_id=? AND kind='final' AND superseded_by_event_id IS NULL").get(requestId) as PeerEventRow|null;
  }
  async notified(requestId:string) {
    const row=this.row(requestId);
    await this.dispatch(row);
    return {outcome:this.row(requestId).outcome};
  }
  private async dispatch(row:PeerRequestRow) {
    if(row.outcome||this.stopped)return;
    const client=this.dependencies.clients.get(row.peer);
    if(!client){this.settle(row,'failed',`Peer ${row.peer} is no longer configured on this instance.`);return;}
    if(row.status==='queued_offline'){
      if(!row.delivery_json){this.settle(row,'failed','The queued delivery body is missing.');return;}
      let accepted:any;
      try{accepted=await client.request('POST','/sessions/v1/peers/requests',JSON.parse(row.delivery_json));this.unreachable.delete(row.peer);}
      catch(error){
        this.note(row.peer,error);
        if(error instanceof PeerError&&error.kind!=='unreachable'){this.settle(row,'failed',error.message);return;}
        return;
      }
      db.query("UPDATE session_peer_requests SET remote_session_id=?,remote_address=?,remote_operation_id=?,delivery_json=NULL,status='recorded' WHERE request_id=? AND status='queued_offline'")
        .run(accepted.sessionId,accepted.address,accepted.operationId,row.request_id);
      log('info','session_peer_request_delivered_late',{request_id:row.request_id,peer:row.peer});
      recordSessionEvent({eventId:`peer-delivered:${row.request_id}`,sessionId:row.source_session_id,inputId:row.source_input_id,kind:'response',payload:{requestId:row.request_id,kind:'progress',text:`${row.peer} is back; the queued request was delivered to ${this.presentedSession(row.peer,accepted.sessionId)}.`}});
      row=this.row(row.request_id);
    }
    let remote:any;
    try {remote=await client.request('GET',`/sessions/v1/peers/requests/${encodeURIComponent(row.request_id)}`);this.unreachable.delete(row.peer);}
    catch(error) {
      this.note(row.peer,error);
      if(error instanceof PeerError&&error.kind==='refused'&&error.status===404){this.settle(row,'failed','The peer no longer holds this request; its target session was not found.');return;}
      log('warn','session_peer_request_unavailable',{request_id:row.request_id,peer:row.peer,...errorFields(error)});
      return;
    }
    remote={...remote,observedAt:new Date(this.now()).toISOString()};
    void this.refreshCatalogue(row.peer);
    // Polled on every wake: rewrite only what changed, ignoring the poll's own timestamp, so an
    // unchanged peer request is not a commit the database's other writers queue behind.
    db.query(`UPDATE session_peer_requests SET remote_status_json=?1,status=?2 WHERE request_id=?3 AND outcome IS NULL
      AND (status IS NOT ?2 OR remote_status_json IS NULL OR json_remove(remote_status_json,'$.observedAt') IS NOT json_remove(?1,'$.observedAt'))`)
      .run(JSON.stringify(remote),remote.execution?'admitted':remote.inputState==='failed'?'failed':'recorded',row.request_id);
    // A reply the peer retained but could not push yet lands here by the same event ID, so
    // push and pull never produce two records for one reply.
    for(const reply of (remote.replies as any[])??[])if(!db.query('SELECT 1 FROM session_peer_events WHERE event_id=?').get(reply.eventId))
      await this.pullReply(client,row,reply,false);
    row=this.row(row.request_id);
    if(row.outcome)return;
    const effect=JSON.parse(row.payload_json).requestedEffect;
    const execution=remote.execution;
    const output=execution?{turn_id:execution.turnId,session_id:this.presentedSession(row.peer,row.remote_session_id),run_id:execution.runId,input_id:row.remote_operation_id,sha256:execution.sha256??null,
      ...(execution.text?{text:execution.text}:{}),...(execution.error?{error:execution.error}:{})}:null;
    if(remote.inputState==='failed'){this.settle(row,'failed',remote.inputError?.message??(typeof remote.inputError==='string'?remote.inputError:null)??'The peer target could not receive this request.');return;}
    // The worker's machine says the request stalled: tell the requester once. It stays open.
    if(remote.stalled&&row.stalled_at_ms===null){
      db.transaction(()=>{
        const current=this.row(row.request_id);
        if(current.outcome||current.stalled_at_ms!==null)return;
        const partial=db.query("SELECT payload_json FROM session_peer_events WHERE request_id=? AND kind='progress' ORDER BY rowid DESC LIMIT 1").get(row.request_id) as {payload_json:string}|null;
        const worker=this.presentedSession(row.peer,row.remote_session_id);
        this.event(row,'overdue',{text:stalledNotice(row.request_id,worker,remote.stalled.reason,partial?JSON.parse(partial.payload_json).text:null),stalled:true,reason:remote.stalled.reason});
        db.query('UPDATE session_peer_requests SET stalled_at_ms=? WHERE request_id=?').run(this.now(),row.request_id);
      })();
      log('warn','session_peer_request_stalled',{request_id:row.request_id,peer:row.peer,reason:remote.stalled.reason});
      this.wake();
    }
    if(!execution)return;
    if(execution.steeringStatus==='failed'){this.settle(row,'failed','The peer provider did not accept this live request.');return;}
    if(!execution.settled)return;
    // A request closes only through the recipient's reply, the requester's cancel or a failed
    // execution; a turn ending is none of those, however its text is worded. Reading that text
    // as the answer closed this request on "final reply will follow" and discarded the real
    // answer that followed (September 23, 2026). The exception is a recipient with no reply
    // command (ChatGPT, consultation-only), whose dedicated turn is its reply.
    if(execution.status==='done'){
      if(execution.answersWithTurn&&execution.dedicated&&execution.text)this.settle(row,effect==='work'?'undetermined':'answered',execution.text,output);
      return;
    }
    this.settle(row,execution.status==='cancelled'?'canceled':'failed',`The recipient execution on ${row.peer} ended with ${execution.status}${execution.status!=='cancelled'&&execution.error?`: ${String(execution.error).slice(0,400)}`:''}.`,output);
  }
  private async deliver(event:PeerEventRow) {
    if(this.stopped)return;
    const row=this.row(event.request_id);
    const declared=JSON.parse(event.payload_json);
    const source=getSessionById(row.source_session_id);
    if(!source||!this.dependencies.owner.view(source).capabilities.send){
      db.query("UPDATE session_peer_events SET status='held',error='Requester is unavailable, paused or archived; the result is retained.' WHERE event_id=?").run(event.event_id);
      return;
    }
    const payload=declared.workDisposition==='completed'&&row.outcome!=='answered'?JSON.parse(row.result_json!):declared;
    // One answer reaches the requester once (see the coordinator's sameAnswerGroup): a copy carried by
    // another event's return only follows that return.
    const current=db.query('SELECT * FROM session_peer_events WHERE event_id=?').get(event.event_id) as PeerEventRow;
    if(current.accepted_input_id&&current.accepted_input_id!==`return:${event.event_id}`){this.followReturn(current.event_id,current.accepted_input_id);return;}
    const group=current.accepted_input_id?{carriedBy:null as string|null,joining:[] as PeerEventRow[]}:this.sameAnswerGroup(current,row.source_session_id);
    if(group.carriedBy){
      db.query('UPDATE session_peer_events SET accepted_input_id=? WHERE event_id=?').run(group.carriedBy,event.event_id);
      this.followReturn(event.event_id,group.carriedBy);
      log('info','session_peer_return_merged',{event_id:event.event_id,request_id:row.request_id,carried_by:group.carriedBy});
      return;
    }
    const requestIds=[row.request_id,...group.joining.map(joined=>joined.request_id)];
    recoverUnsentSteeredInput(`return:${event.event_id}`);
    const existing=getAcceptedSessionInput(`return:${event.event_id}`);
    const accepted=existing?this.dependencies.owner.dispatch(existing):this.dependencies.owner.admit({sessionId:source.id,inputId:`return:${event.event_id}`,origin:'service',sourceInputId:row.source_input_id,sourceRunId:nativeRunId(row.source_turn_id),requestId:row.request_id,
      text:`Session ${declared.stalled?'stalled':event.kind} event ${event.event_id} for ${requestIds.length>1?`requests ${requestIds.join(', ')} (one answer closing all of them)`:`request ${row.request_id}`} from peer ${row.peer}. This is an agent/service result, not new human authorization. No acknowledgement or reciprocal question is required.\n\n${payload.text}\n\n${JSON.stringify({...payload,text:undefined})}`,
      // The peer's files are already in this instance's custody; the return carries them.
      ...(Array.isArray(payload.attachments)&&payload.attachments.length?{attachments:payload.attachments as string[]}:{})});
    for(const joined of group.joining)db.query('UPDATE session_peer_events SET accepted_input_id=? WHERE event_id=? AND accepted_input_id IS NULL').run(`return:${event.event_id}`,joined.event_id);
    const observed=readInputExecution(accepted);
    const received=observed.acknowledgedAt||observed.turn?.input_context_received_by_turn_id;
    const unacknowledged=observed.steering?.status==='ambiguous'&&!observed.steering.provider_sent_at;
    const status=received?'received':unacknowledged?'uncertain':['failed','uncertain','canceled'].includes(observed.state)?observed.state:accepted.turn_id?'admitted':'held';
    const error=unacknowledged?'The provider did not acknowledge this specific return; its linked turn outcome does not prove receipt.':observed.steering?.error??null;
    db.query('UPDATE session_peer_events SET status=?,error=? WHERE accepted_input_id=?').run(status,received?null:error,accepted.id);
    db.query('UPDATE session_peer_events SET accepted_input_id=?,status=?,error=? WHERE event_id=?').run(accepted.id,status,received?null:error,event.event_id);
  }
  /** Finals to the same requester carrying the same answer; see the coordinator's sameAnswerGroup. */
  private sameAnswerGroup(event:PeerEventRow,requesterSessionId:number):{carriedBy:string|null;joining:PeerEventRow[]} {
    if(event.kind!=='final')return {carriedBy:null,joining:[]};
    const answer=sameAnswerKey(event.payload_json);
    if(!answer)return {carriedBy:null,joining:[]};
    const candidates=(db.query(`SELECT event.* FROM session_peer_events event JOIN session_peer_requests request ON request.request_id=event.request_id
      WHERE request.source_session_id=? AND event.kind='final' AND event.event_id<>? AND event.created_at_ms>=? ORDER BY event.rowid`)
      .all(requesterSessionId,event.event_id,event.created_at_ms-60*60*1000) as PeerEventRow[]).filter(candidate=>sameAnswerKey(candidate.payload_json)===answer);
    const carrier=candidates.find(candidate=>candidate.accepted_input_id===`return:${candidate.event_id}`);
    return carrier?{carriedBy:carrier.accepted_input_id,joining:[]}:{carriedBy:null,joining:candidates.filter(candidate=>!candidate.accepted_input_id)};
  }
  private followReturn(eventId:string,inputId:string) {
    const input=getAcceptedSessionInput(inputId);
    if(!input)return;
    const observed=readInputExecution(input);
    const received=observed.acknowledgedAt||observed.turn?.input_context_received_by_turn_id;
    db.query('UPDATE session_peer_events SET status=? WHERE event_id=?').run(received?'received':['failed','uncertain','canceled'].includes(observed.state)?observed.state:input.turn_id?'admitted':'held',eventId);
  }
  private inspectOverdue() {
    const now=this.now();
    for(const row of db.query(`SELECT * FROM session_peer_requests WHERE ${AWAITING_INSPECTION} AND due_at_ms<=?`).all(now) as PeerRequestRow[]) {
      const remote=row.remote_status_json?JSON.parse(row.remote_status_json):null;
      const healthy=remote?.execution?.status==='running'&&!remote.execution.stopped||remote?.execution?.status==='done'&&remote.stillWorking;
      if(healthy){db.query('UPDATE session_peer_requests SET due_at_ms=? WHERE request_id=? AND outcome IS NULL AND overdue_at_ms IS NULL').run(now+DUE_MS,row.request_id);continue;}
      const health=row.status==='queued_offline'?`queued; ${row.peer} has been offline since it was asked`:this.unreachable.has(row.peer)?`peer ${row.peer} unreachable`:remote?.execution?.stopped?'deliberately stopped'
        :remote?.execution?.status==='done'?`${this.presentedSession(row.peer,row.remote_session_id)} ended its turn without a final reply; the request stays open until that session replies or you cancel it`
        :remote?.execution?.status??remote?.inputState??'waiting for admission on the peer';
      db.transaction(()=>{
        if(this.row(row.request_id).outcome||this.row(row.request_id).overdue_at_ms!==null)return;
        this.event(row,'overdue',{text:`Request ${row.request_id} to peer ${row.peer} has no confirmed answer after 30 minutes. Recipient state: ${health}. The request remains recorded; no uncertain provider effect or deliberate Stop was replayed. Inspect the request and decide whether more work is needed.`,health});
        db.query('UPDATE session_peer_requests SET overdue_at_ms=? WHERE request_id=?').run(now,row.request_id);
      })();
    }
  }

  // ---- target side: a request a peer delivered to this instance ----
  private delivery(requestId:string):DeliveryRow {
    const row=db.query('SELECT * FROM session_peer_deliveries WHERE request_id=?').get(requestId) as DeliveryRow|null;
    if(!row)throw new SessionOwnerError('Unknown session request.',404);
    return row;
  }
  deliveryFor(inputId:string){return db.query('SELECT * FROM session_peer_deliveries WHERE target_input_id=?').get(inputId) as DeliveryRow|null;}
  accept(body:unknown) {
    const input=object(body);
    const requestId=input.requestId;
    if(typeof requestId!=='string'||!/^[0-9a-f-]{36}$/.test(requestId))throw new SessionOwnerError('A peer request needs its UUID.');
    const origin=object(input.origin);
    if(typeof origin.peer!=='string'||!this.dependencies.clients.has(origin.peer))throw new SessionOwnerError('Unknown peer instance.',403,'PEER_UNKNOWN');
    if(typeof origin.sessionId!=='string'||typeof origin.inputId!=='string'||typeof origin.runId!=='string')throw new SessionOwnerError('A peer request names its origin session, input and run.');
    if(typeof input.text!=='string'||!input.text.trim())throw new SessionOwnerError('Nonempty request text required.');
    const effect=input.requestedEffect??'informational';
    if(!['informational','work'].includes(effect))throw new SessionOwnerError('Requested effect must be informational or work.');
    if(input.files!==undefined&&(!Array.isArray(input.files)||input.files.some((file:any)=>typeof file?.name!=='string'||typeof file.contentType!=='string'||typeof file.base64!=='string')))throw new SessionOwnerError('Files must contain named attachment bytes.');
    const owner=this.dependencies.owner;
    const existing=db.query('SELECT * FROM session_peer_deliveries WHERE request_id=?').get(requestId) as DeliveryRow|null;
    if(existing)return this.accepted(existing);
    // The sender's own words stay beside the delivery text its preamble wraps for the provider.
    const provenance={origin:{peer:origin.peer,sessionId:origin.sessionId,inputId:origin.inputId,runId:origin.runId},originatingHuman:origin.originatingHuman??null,effectScope:origin.effectScope??null,
      ...(typeof input.message==='string'&&input.message.trim()?{message:input.message}:{})};
    const created=db.transaction(()=>{
      const attachments=((input.files??[]) as {name:string;contentType:string;base64:string}[]).map((file,index)=>owner.upload({name:file.name,contentType:file.contentType,base64:file.base64,clientActionId:`peer-file:${requestId}:${index}`}).attachment.id);
      const scope=`peer:${origin.peer}:${origin.inputId}`;
      let sessionId:number;
      if(typeof input.provider==='string'){
        const operation=owner.createRequestTarget({scope,requestId,provider:input.provider,effort:input.effort,project:input.project,title:input.title,
          firstInput:{text:input.text,...(attachments.length?{attachments}:{})}});
        sessionId=operation.session_id;
      } else {
        if(typeof input.address!=='string')throw new SessionOwnerError('Choose an exact session address or a provider for a new session.');
        const target=resolveSessionAddress(input.address);
        const view=owner.view(target);
        if(sessionMetadata(target).interactionPolicy==='consultation-only'&&effect==='work')throw new SessionOwnerError('This session accepts consultation only — information, no actions.',409);
        if(!view.capabilities.send)throw new SessionOwnerError('The exact session is not currently messageable.',409,'CAPABILITY_UNAVAILABLE');
        owner.attachments(attachments);
        retainSessionInput({id:`request:${requestId}`,sessionId:target.id,scope,actionId:`request:${requestId}`,kind:'input',origin:'agent',
          payload:{text:input.text,...(attachments.length?{attachments}:{}),...(target.provider_id==='chatgpt'||sessionMetadata(target).interactionPolicy==='consultation-only'?{delivery:'queue'}:{})},requestId});
        sessionId=target.id;
      }
      db.query(`INSERT INTO session_peer_deliveries(request_id,peer,origin_session_id,origin_input_id,origin_run_id,target_session_id,target_input_id,requested_effect,origin_provenance_json,created_at_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(requestId,origin.peer,origin.sessionId,origin.inputId,origin.runId,sessionId,`request:${requestId}`,effect,JSON.stringify(provenance),this.now());
      return this.delivery(requestId);
    })();
    owner.dispatch(getAcceptedSessionInput(created.target_input_id)!);
    this.wake();
    return this.accepted(created);
  }
  private accepted(row:DeliveryRow){const session=getSessionById(row.target_session_id)!;return {sessionId:`concierge:${session.id}`,address:sessionAddress(session),operationId:row.target_input_id};}
  /** What the origin needs to settle its request: the exact execution facts, never an outcome guessed here. */
  status(requestId:string) {
    const row=this.delivery(requestId);
    const input=getAcceptedSessionInput(row.target_input_id);
    if(!input)throw new SessionOwnerError('Accepted request input is missing.',404);
    const observed=readInputExecution(input);
    const saved=input.receipt_json?JSON.parse(input.receipt_json):{};
    const turn=observed.turn?db.query(`SELECT prerequisite.*,(${SETTLED_EXECUTION_SQL}) AS settled FROM turns prerequisite WHERE id=?`).get(observed.turn.id) as any:null;
    const steeringCount=turn?(db.query("SELECT count(*) AS count FROM turn_steering_messages WHERE turn_id=? AND status<>'failed'").get(turn.id) as any).count:0;
    const shared=turn?(db.query(`SELECT count(*) AS count FROM session_inputs WHERE turn_id=? AND (id IN (SELECT target_input_id FROM session_peer_deliveries) OR id IN (SELECT target_input_id FROM session_communication_requests WHERE target_input_id IS NOT NULL))`).get(turn.id) as any).count:0;
    const dedicated=!!turn&&turn.accepted_input_id===input.id&&!!turn.provider_input_acknowledged_at&&!input.steering_id&&shared===1&&steeringCount===0;
    const session=getSessionById(row.target_session_id)!;
    const view=this.dependencies.owner.view(session);
    // A recipient with no reply command answers with its turn; every other one answers only by replying.
    const answersWithTurn=session.provider_id==='chatgpt'||sessionMetadata(session).interactionPolicy==='consultation-only';
    const replies=(db.query('SELECT * FROM session_peer_replies WHERE request_id=? ORDER BY rowid').all(requestId) as ReplyRow[]).map(reply=>{
      const payload=JSON.parse(reply.payload_json);
      const completionTurn=payload.completionTurnId?db.query(`SELECT prerequisite.status,prerequisite.provider_input_acknowledged_at,prerequisite.stop_requested_at,(${SETTLED_EXECUTION_SQL}) AS settled FROM turns prerequisite WHERE id=?`).get(payload.completionTurnId) as any:null;
      return {eventId:reply.event_id,kind:reply.kind,status:reply.status,text:payload.text,workDisposition:payload.workDisposition??null,createdAtMs:reply.created_at_ms,files:payload.attachments?.length??0,
        completionTurnId:payload.completionTurnId??null,sourceInputId:payload.source?.input_id??null,sourceRunId:payload.source?.run_id??null,
        completion:completionTurn?{settled:!!completionTurn.settled,status:completionTurn.status,completed:completionTurn.status==='done'&&!!completionTurn.provider_input_acknowledged_at&&!completionTurn.stop_requested_at}:null};
    });
    return {requestId,sessionId:`concierge:${session.id}`,address:sessionAddress(session),inputState:saved.state??observed.state,inputError:saved.error??null,stillWorking:['running','queued'].includes(view.execution),
      execution:turn?{turnId:turn.id,runId:nativeRunId(turn.id),status:turn.status,settled:!!turn.settled,acknowledged:!!turn.provider_input_acknowledged_at,acknowledgedAt:observed.acknowledgedAt??null,stopped:!!turn.stop_requested_at,dedicated,answersWithTurn,
        steeringStatus:observed.steering?.status??null,text:turn.status==='done'?turn.agent_text||null:null,error:turn.status!=='done'?turn.agent_text??null:null,sha256:turn.agent_text?hash(turn.agent_text):null}:null,
      replies,stalled:row.stalled_at_ms===null?null:{atMs:row.stalled_at_ms,reason:row.stalled_reason??'the worker sent no final reply after one reminder'}};
  }
  private deliveryReceipt(row:DeliveryRow) {
    const status=this.status(row.request_id);
    return {request_id:row.request_id,status:row.closed_at_ms?'settled':'delivered',outcome:null,peer:row.peer,role:'recipient',source_session_id:receiveSessionFromPeer(row.origin_session_id,row.peer,this.self),
      target_session_id:status.sessionId,target_address:status.address,target_input_id:row.target_input_id,operation_id:row.target_input_id,routed_request_id:null,target_turn_id:status.execution?.turnId??null,
      due_at_ms:null,overdue_at_ms:null,result:null,execution:status.execution?{turn_id:status.execution.turnId,input_kind:status.execution.steeringStatus?'steering':'turn',input_status:status.execution.steeringStatus??status.execution.status,acknowledged_at:status.execution.acknowledgedAt,provider_turn_id:null}:null,
      events:status.replies.map(reply=>({event_id:reply.eventId,kind:reply.kind,status:reply.status,error:null,payload:{text:reply.text,final:reply.kind==='final',workDisposition:reply.workDisposition},routed_request_id:null}))};
  }
  /**
   * The worker lives on this instance, so this instance takes the stranded steps for it
   * (request-liveness.ts): a stall the origin reads from status() and returns to its requester. It
   * does not close the request.
   */
  private chaseStranded(row:DeliveryRow,status:ReturnType<SessionPeers['status']>) {
    const execution=status.execution;
    if(!execution||execution.status!=='done'||!execution.settled||execution.answersWithTurn)return;
    if(status.replies.some(reply=>reply.kind==='final'))return;
    const owner=this.dependencies.owner;
    const next=strandedStep(owner,{requestId:row.request_id,workerSessionId:row.target_session_id,createdAtMs:row.created_at_ms,remindedAtMs:row.reminded_at_ms,remindedVia:row.reminded_via,stalledAtMs:row.stalled_at_ms});
    if(next.step==='stall'){
      db.query('UPDATE session_peer_deliveries SET stalled_at_ms=?,stalled_reason=? WHERE request_id=? AND stalled_at_ms IS NULL').run(this.now(),next.reason,row.request_id);
      log('warn','session_request_stalled',{request_id:row.request_id,peer:row.peer,worker_session_id:`concierge:${row.target_session_id}`,reason:next.reason});
    }
  }
  /**
   * One reply exactly as the origin must record it. The origin has no access to this instance's
   * custody, so the reply's exact bytes travel with it; push and the origin's pull both use this.
   */
  private replyBody(row:DeliveryRow,reply:ReplyRow) {
    const payload=JSON.parse(reply.payload_json);
    const files=payload.attachments?.length
      ?this.dependencies.owner.attachments(payload.attachments).map(({name,contentType,base64})=>({name,contentType,base64}))
      :null;
    return {eventId:reply.event_id,kind:reply.kind,text:payload.text,workDisposition:payload.workDisposition,evidence:payload.evidence,completionTurnId:payload.completionTurnId??null,
      ...(files?{files}:{}),
      responder:{peer:this.self,sessionId:`concierge:${row.target_session_id}`,inputId:payload.source.input_id,runId:payload.source.run_id}};
  }
  /** GET …/requests/:id/replies/:eventId — a reply with its files, for an origin that pulls. */
  fullReply(requestId:string,eventId:string) {
    const row=this.delivery(requestId);
    const reply=db.query('SELECT * FROM session_peer_replies WHERE request_id=? AND event_id=?').get(requestId,eventId) as ReplyRow|null;
    if(!reply)throw new SessionOwnerError('Unknown reply.',404);
    return this.replyBody(row,reply);
  }
  /** Deliveries from a peer that this session holds without a final reply (see the coordinator's owed). */
  owedDeliveries(sessionId:number,runId:string,mark:{offer:string[];remind:boolean}):OwedRequest[] {
    const owed:OwedRequest[]=[];
    for(const row of db.query(`SELECT * FROM session_peer_deliveries WHERE target_session_id=? AND closed_at_ms IS NULL AND stalled_at_ms IS NULL AND created_at_ms>=? ORDER BY rowid`).all(sessionId,REMINDERS_SINCE_MS) as DeliveryRow[]) {
      if(!getAcceptedSessionInput(row.target_input_id)?.turn_id)continue;
      if(db.query("SELECT 1 FROM session_peer_replies WHERE request_id=? AND kind='final'").get(row.request_id))continue;
      if(mark.offer.includes(row.request_id))db.query('UPDATE session_peer_deliveries SET hook_offered_run=? WHERE request_id=?').run(runId,row.request_id);
      if(mark.remind)db.query("UPDATE session_peer_deliveries SET reminded_at_ms=?,reminded_via='hook' WHERE request_id=? AND reminded_at_ms IS NULL AND hook_offered_run=?").run(this.now(),row.request_id,runId);
      owed.push({request_id:row.request_id,requester:`${row.peer}/${row.origin_session_id}`,requested_effect:row.requested_effect,command:replyCommand(row.request_id,row.requested_effect)});
    }
    return owed;
  }
  /** The origin canceled a request this instance delivered: close the delivery and tell its worker. */
  canceledByOrigin(requestId:string) {
    const row=this.delivery(requestId);
    db.query('UPDATE session_peer_deliveries SET closed_at_ms=coalesce(closed_at_ms,?) WHERE request_id=?').run(this.now(),requestId);
    if(!db.query("SELECT 1 FROM session_peer_replies WHERE request_id=? AND kind='final'").get(requestId))
      tellWorkerCanceled(this.dependencies.owner,{requestId,workerSessionId:row.target_session_id,targetInputId:row.target_input_id,requester:`${row.peer}/${row.origin_session_id}`});
    return {canceled:true};
  }
  inspectDelivery(requestId:string){return this.deliveryReceipt(this.delivery(requestId));}
  reply(actor:PeerActor,input:{action_id:string;request_id:string;text:string;final:boolean;workDisposition?:WorkDisposition;evidence?:unknown[];attachments?:string[]}) {
    if(this.stopped)throw new Error('Session communication is not accepting replies.');
    const row=this.delivery(input.request_id);
    if(row.target_session_id!==actor.session)throw new Error('Only the exact recipient session/conversation can reply.');
    if(input.workDisposition!==undefined&&(!input.final||row.requested_effect!=='work'||!['completed','failed','needs_decision'].includes(input.workDisposition)))throw new Error('A work disposition requires a final reply to a work request.');
    if(input.final&&row.requested_effect==='work'&&input.workDisposition===undefined)throw new Error('A final reply to a work request needs --work-disposition completed, failed or needs_decision.');
    const target=getAcceptedSessionInput(row.target_input_id);
    if(!target?.turn_id)throw new Error('This request has not been delivered to this session yet.');
    const key=JSON.stringify(['input',actor.inputId,input.action_id]);
    const payload={text:input.text,final:input.final,source:{input_id:actor.inputId,run_id:nativeRunId(actor.turn)},responding_session_id:`concierge:${actor.session}`,
      // Custody on this instance; the forward reads these exact bytes for the origin.
      ...(input.attachments?.length?{attachments:input.attachments}:{}),
      ...(input.workDisposition?{workDisposition:input.workDisposition,completionTurnId:actor.turn}:{}),...(input.evidence?{evidence:input.evidence}:{})};
    const prior=db.query('SELECT * FROM session_peer_replies WHERE action_key=?').get(key) as ReplyRow|null;
    if(prior){if(prior.request_id!==row.request_id||prior.payload_json!==JSON.stringify(payload))throw new Error('Idempotency conflict: reply action has a different payload.');return this.deliveryReceipt(row);}
    db.transaction(()=>{
      if(input.final&&db.query("SELECT 1 FROM session_peer_replies WHERE request_id=? AND kind='final'").get(row.request_id))throw new Error('This request already has a final reply awaiting the peer’s confirmation.');
      const eventId=randomUUID();
      db.query('INSERT INTO session_peer_replies(event_id,request_id,action_key,kind,payload_json,created_at_ms) VALUES(?,?,?,?,?,?)').run(eventId,row.request_id,key,input.final?'final':'progress',JSON.stringify(payload),this.now());
      const operation=retainSessionInput({sessionId:actor.session,scope:`communication:${actor.inputId}`,actionId:input.action_id,kind:'reply',origin:'agent',
        payload:{text:input.text,sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn),kind:input.final?'final':'partial',workDisposition:input.workDisposition,evidence:input.evidence,peer:row.peer,...(input.attachments?.length?{attachments:input.attachments}:{})},
        sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn),requestId:row.request_id}).input;
      db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'completed',eventId}),operation.id);
    })();
    this.wake();
    return this.deliveryReceipt(row);
  }
  /** Forward a recipient's replies and execution changes to the origin; both are retried until the origin has them. */
  private async report(row:DeliveryRow) {
    if(this.stopped)return;
    const client=this.dependencies.clients.get(row.peer);
    if(!client)return;
    for(const reply of db.query("SELECT * FROM session_peer_replies WHERE request_id=? AND status='pending' ORDER BY rowid").all(row.request_id) as ReplyRow[]) {
      const payload=JSON.parse(reply.payload_json);
      try {
        const answer=await client.request<{eventId?:string;recorded?:string;reason?:string}>('POST',`/sessions/v1/peers/requests/${encodeURIComponent(row.request_id)}/replies`,this.replyBody(row,reply));
        // Forwarded means the origin confirmed it holds this exact event. A refusal is recorded as
        // one; any other answer (an origin from before confirmations) leaves it pending and resent.
        // A plain success used to count as delivery while the origin discarded the reply.
        if(answer?.eventId===reply.event_id&&answer.recorded==='refused'){
          db.query("UPDATE session_peer_replies SET status='refused',error=? WHERE event_id=?").run(answer.reason??'The origin refused this reply.',reply.event_id);
          log('warn','session_peer_reply_refused_by_origin',{request_id:row.request_id,peer:row.peer,event_id:reply.event_id,kind:reply.kind,reason:answer.reason??null});
          continue;
        }
        if(answer?.eventId!==reply.event_id||!['recorded','duplicate'].includes(answer.recorded??'')){
          db.query('UPDATE session_peer_replies SET error=? WHERE event_id=?').run('The origin did not confirm it recorded this reply; it will be sent again.',reply.event_id);
          log('warn','session_peer_reply_unconfirmed',{request_id:row.request_id,peer:row.peer,event_id:reply.event_id,kind:reply.kind});
          return;
        }
        db.query("UPDATE session_peer_replies SET status='forwarded',error=NULL WHERE event_id=?").run(reply.event_id);
        this.unreachable.delete(row.peer);
        log('info','session_peer_reply_forwarded',{request_id:row.request_id,peer:row.peer,event_id:reply.event_id,kind:reply.kind});
      } catch(error) {
        this.note(row.peer,error);
        const permanent=error instanceof PeerError&&error.kind==='refused';
        db.query('UPDATE session_peer_replies SET status=?,error=? WHERE event_id=?').run(permanent?'refused':'pending',error instanceof Error?error.message:String(error),reply.event_id);
        log('warn','session_peer_reply_forward_failed',{request_id:row.request_id,peer:row.peer,event_id:reply.event_id,permanent,...errorFields(error)});
        if(!permanent)return;
      }
    }
    if(row.closed_at_ms)return;
    this.chaseStranded(row,this.status(row.request_id));
    row=this.delivery(row.request_id);
    const status=this.status(row.request_id);
    const fingerprint=JSON.stringify([status.inputState,status.execution?.status??null,status.execution?.settled??null,status.stillWorking,status.replies.map(reply=>reply.eventId+':'+reply.status),status.stalled?.atMs??null]);
    if(fingerprint===row.notified_fingerprint)return;
    try {
      const answer=await client.request<{outcome:string|null}>('POST',`/sessions/v1/peers/requests/${encodeURIComponent(row.request_id)}/notify`,{});
      this.unreachable.delete(row.peer);
      db.query('UPDATE session_peer_deliveries SET notified_fingerprint=?,closed_at_ms=CASE WHEN ? THEN ? ELSE closed_at_ms END WHERE request_id=?').run(fingerprint,answer?.outcome?1:0,this.now(),row.request_id);
      if(answer?.outcome==='canceled'&&!db.query("SELECT 1 FROM session_peer_replies WHERE request_id=? AND kind='final'").get(row.request_id))
        tellWorkerCanceled(this.dependencies.owner,{requestId:row.request_id,workerSessionId:row.target_session_id,targetInputId:row.target_input_id,requester:`${row.peer}/${row.origin_session_id}`});
    } catch(error) {
      this.note(row.peer,error);
      // The origin commits its request only after this instance accepted it, so a 404 within
      // the first minutes is a race, not an orphan; an old delivery the origin never learned of is.
      const orphan=error instanceof PeerError&&error.kind==='refused'&&error.status===404&&this.now()-row.created_at_ms>10*60*1000;
      if(orphan)db.query('UPDATE session_peer_deliveries SET closed_at_ms=? WHERE request_id=?').run(this.now(),row.request_id);
      else log('warn','session_peer_notify_failed',{request_id:row.request_id,peer:row.peer,status:error instanceof PeerError?error.status:null,...errorFields(error)});
    }
  }

  // ---- scheduling, shared with the coordinator's wake ----
  wake() {
    if(this.stopped||this.scheduled)return;
    this.scheduled=true;
    queueMicrotask(()=>{
      this.scheduled=false;
      if(this.stopped)return;
      try {
        // Keep each peer's catalogue fresh while this instance is active, at most once a minute,
        // so its sessions stay addressable when it later goes offline.
        for(const name of this.dependencies.clients.keys())void this.refreshCatalogue(name);
        this.inspectOverdue();
        if(this.unrecovered.size)this.schedule('recover-discarded-replies',()=>this.recoverDiscardedReplies());
        for(const row of db.query('SELECT * FROM session_peer_requests WHERE outcome IS NULL ORDER BY rowid').all() as PeerRequestRow[])
          this.schedule(`ask:${row.request_id}`,()=>this.dispatch(this.row(row.request_id)));
        for(const event of db.query("SELECT * FROM session_peer_events WHERE status NOT IN ('received','retained') ORDER BY rowid").all() as PeerEventRow[])
          this.schedule(`event:${event.event_id}`,()=>this.deliver(event));
        for(const row of db.query(`SELECT * FROM session_peer_deliveries WHERE closed_at_ms IS NULL
            OR request_id IN (SELECT request_id FROM session_peer_replies WHERE status='pending') ORDER BY rowid`).all() as DeliveryRow[])
          this.schedule(`report:${row.request_id}`,()=>this.report(this.delivery(row.request_id)));
        this.arm();
      } catch(error) {this.disarm?.();this.disarm=null;this.dependencies.onError(error);}
    });
  }
  private schedule(key:string,work:()=>Promise<void>) {
    if(this.tasks.has(key)){this.again.add(key);return;}
    const task=Promise.resolve().then(work);
    this.tasks.set(key,task);
    void task.catch(this.dependencies.onError).finally(()=>{this.tasks.delete(key);if(this.again.delete(key)&&!this.stopped)this.schedule(key,work);});
  }
  /** Retry an unreachable peer on a bounded timer while something is still owed; nothing runs when nothing is owed. */
  private arm() {
    this.disarm?.();this.disarm=null;
    if(this.stopped)return;
    const owed=this.unrecovered.size>0||(db.query("SELECT 1 FROM session_peer_requests WHERE outcome IS NULL LIMIT 1").get()
      ||db.query("SELECT 1 FROM session_peer_replies WHERE status='pending' LIMIT 1").get()
      ||db.query('SELECT 1 FROM session_peer_deliveries WHERE closed_at_ms IS NULL LIMIT 1').get())!==null;
    const due=(db.query(`SELECT min(due_at_ms) AS due FROM session_peer_requests WHERE ${AWAITING_INSPECTION}`).get() as {due:number|null}).due;
    const delays=[...(owed?[60_000]:[]),...(due===null?[]:[Math.max(0,due-this.now())])];
    if(!delays.length)return;
    const timer=setTimeout(()=>this.wake(),Math.min(...delays));
    timer.unref();
    this.disarm=()=>clearTimeout(timer);
  }
  start(){if(!this.stopped)return;this.stopped=false;this.unrecovered=new Set(this.dependencies.clients.keys());this.wake();}
  /**
   * Before September 23, 2026 this instance closed peer requests by inference from a finished
   * turn and then discarded the recipient's later replies while telling the peer they arrived,
   * so the peer never sent them again. Its own reply record still holds them: read it once per
   * start for the recent inferred closures and record what is missing, which supersedes the
   * inference and returns it. Event IDs make this idempotent. A peer that does not answer stays
   * in `unrecovered` and is retried on the minute retry timer until every read succeeds.
   */
  private unrecovered=new Set<string>();
  private async recoverDiscardedReplies() {
    const since=this.now()-14*24*60*60*1000;
    const failed=new Set<string>();
    for(const row of db.query('SELECT * FROM session_peer_requests WHERE outcome IS NOT NULL AND created_at_ms>=? ORDER BY rowid').all(since) as PeerRequestRow[]) {
      if(this.stopped)return;
      if(!this.unrecovered.has(row.peer)||failed.has(row.peer))continue;
      if(!isInferredFinal(this.currentFinal(row.request_id)))continue;
      const client=this.dependencies.clients.get(row.peer);
      if(!client)continue;
      try {
        const remote=await client.request<any>('GET',`/sessions/v1/peers/requests/${encodeURIComponent(row.request_id)}`);
        for(const reply of (remote.replies as any[])??[])if(!db.query('SELECT 1 FROM session_peer_events WHERE event_id=?').get(reply.eventId)){
          const result=await this.pullReply(client,row,reply,true);
          log('info','session_peer_discarded_reply_recovered',{request_id:row.request_id,peer:row.peer,event_id:reply.eventId,kind:reply.kind,recorded:result?.recorded??'left for push'});
        }
      } catch(error) {failed.add(row.peer);log('warn','session_peer_discarded_reply_recovery_failed',{request_id:row.request_id,peer:row.peer,...errorFields(error)});}
    }
    for(const peer of [...this.unrecovered])if(!failed.has(peer))this.unrecovered.delete(peer);
  }
  async stop(){this.stopped=true;this.disarm?.();this.disarm=null;await Promise.allSettled([...this.tasks.values()]);}
}
