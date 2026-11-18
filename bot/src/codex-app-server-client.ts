import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { jsonLine, onJsonLines } from "./json-lines";
import { homedir } from "node:os";
import { join } from "node:path";
import { errorFields, log } from "./log";
import {releaseCodexBridgePath} from "./release-worker";
import { moveCodexDaemonToOwnScope, raiseCodexDaemonFileLimit, startCodexDaemonWhenAbsent } from "./codex-daemon-file-limit";
import { OwnerDrainBeforeProviderAdmissionError } from "./provider-failures";
import { randomUUID } from "node:crypto";
import {isCodexNativeObservation} from './codex-native-observations';
import type {CodexRelayAssociation} from './runner-codex-relay';
import {assertCustodyEndpoint} from './codex-custody-colocation';

const DEFAULT_SOCKET_PATH = join(homedir(), ".codex/app-server-control/app-server-control.sock");
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const custodyClients = new Set<CodexAppServerClient>();
type CustodyCutoffEndpoint={socketPath:string;relayRunner:string|null;relayAssociation?:CodexRelayAssociation};
const frozenCustodyTargets = new Map<string,{ownerSessionId:number;threadId:string;endpoint:CustodyCutoffEndpoint|undefined}>();
const custodyBarrierGenerations = new Map<string,Map<number,Map<string,number>>>();
function isCustodyMutation(method:string) { return !isCodexNativeObservation(method); }

export class CodexAppServerClientError extends Error {
  constructor(
    message: string,
    readonly outcome: "rejected" | "ambiguous",
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CodexAppServerClientError";
  }
}

/** The App Server never answered this request on this connection within its deadline. */
export class CodexAppServerUnansweredError extends CodexAppServerClientError {
  constructor(message: string) {
    super(message, "ambiguous");
    this.name = "CodexAppServerUnansweredError";
  }
}

interface PendingRequest {
  connectionGeneration: number;
  method: string;
  resolve(value: any): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout> | undefined;
  onAccepted?(value: any): void;
  onCompleted?():void;
}

interface ActiveConnection {
  serverInfo?:unknown;
  relayAssociation?:CodexRelayAssociation;
  generation: number;
  process: ChildProcessWithoutNullStreams;
  disconnected: Promise<void>;
  resolveDisconnected(): void;
  exited: Promise<void>;
  resolveExited(): void;
  ready: Promise<void>;
  resolveReady(): void;
  rejectReady(error: Error): void;
  stderr: string;
}

type NotificationListener = (event: any) => void;
type DisconnectListener = (error: Error, generation: number) => void;

export interface CodexRequestOptions {
  /** Refuse a protected operation if it would use another native connection. */
  expectedConnectionGeneration?: number;
  requestTimeoutMs?: number;
  /**
   * Wait for the answer for as long as this connection lives. For a request the App Server
   * keeps working on after any deadline (a cold thread/resume loads the whole rollout), giving
   * up and asking again only stacks another load; a disconnect still rejects it.
   */
  untilDisconnect?: boolean;
  onAccepted?: (value: any) => void;
  /** Durable owner identity used by the custody forwarding policy. */
  custodyOwnerSessionId?: number;
}

export type CodexCustodyForwardScope = {
  nativeEndpoint?:CodexAppServerClientLike['nativeEndpoint'];
  senderId: string;
  generation: number;
  method: string;
  params: unknown;
  ownerSessionId: number | null;
  threadId: string | null;
  serializationKey:string|null;
  classification: "known-thread" | "thread-path" | "unkeyed-thread" | "other";
};
export type CodexCustodyForwardRecord=Omit<CodexCustodyForwardScope,"params"> & {completed:boolean};

let custodyForwardGuard: ((scope: CodexCustodyForwardScope) => void) | null = null;
export function installCodexCustodyForwardGuard(guard: ((scope: CodexCustodyForwardScope) => void) | null) {
  custodyForwardGuard = guard;
}

function forwardedScope(senderId:string,generation:number,method:string,params:unknown,ownerSessionId:number|null):CodexCustodyForwardScope {
  const row=params&&typeof params==="object"?params as Record<string,unknown>:{};
  const id=typeof row.threadId==="string"?row.threadId:null;
  const path=(typeof row.path==="string"&&row.path.length>0)||row.history!==undefined&&row.history!==null;
  const classification=method==="thread/start"?"unkeyed-thread":path?"thread-path":id?"known-thread":"other";
  const serializationKey=method==="thread/start"?`unkeyed:${method}`:
    (method==="thread/resume"||method==="thread/fork")&&(!id||id.length===0)?path?`thread-path:${String(row.path??row.history??"")}`:`thread:`:
    id?`thread:${id}`:null;
  return {senderId,generation,method,params,ownerSessionId,threadId:id,serializationKey,classification};
}

export interface CodexAppServerClientLike {
  readonly custodySenderId?:string;
  readonly nativeEndpoint?:{socketPath:string;relayRunner:string|null;serverInfo:unknown;relayAssociation?:CodexRelayAssociation};
  connect(): Promise<number>;
  request(
    method: string,
    params: unknown,
    options?: CodexRequestOptions,
  ): Promise<any>;
  notify(method: string, params?: unknown, options?:Pick<CodexRequestOptions,'expectedConnectionGeneration'|'custodyOwnerSessionId'>): Promise<void>;
  onNotification(listener: NotificationListener): () => boolean;
  onDisconnect(listener: DisconnectListener): () => boolean;
  waitForDisconnect(generation: number): Promise<void>;
  loseConnectionGeneration?(generation: number): Promise<"observed" | "stale">;
}

export function codexAppServerSocketPath() {
  return process.env.CONCIERGE_CODEX_APP_SERVER_SOCKET?.trim() || DEFAULT_SOCKET_PATH;
}

export class CodexAppServerClient {
  readonly custodySenderId=randomUUID();
  readonly custodyForwardedScopes:CodexCustodyForwardRecord[] = [];
  private active: ActiveConnection | null = null;
  private connecting: Promise<number> | null = null;
  private generation = 0;
  private requestId = 0;
  private closed = false;
  private modelObservationClient:CodexAppServerClient|null=null;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly disconnectListeners = new Set<DisconnectListener>();

  constructor(
    private readonly socketPath = codexAppServerSocketPath(),
    private readonly nodeExecutable = process.env.CONCIERGE_NODE_BIN?.trim() || "/usr/bin/node",
    private readonly options: {
      bridgePath?: string;
      shutdownGraceMs?: number;
      /** A runner whose App Server this client reaches through the owner's relay (socketPath is then the owner's requests.sock). */
      relayRunner?: string | null;
      /** A protected recovery client must never start or tune a shared native daemon. */
      manageDaemon?: boolean;
      protectedRelay?:boolean;
    } = {},
  ) { custodyClients.add(this); }

  get activeGeneration() { return this.active?.generation ?? null; }
  get nativeEndpoint(){return {socketPath:this.socketPath,relayRunner:this.options.relayRunner??null,serverInfo:this.active?.serverInfo??null,
    ...(this.active?.relayAssociation?{relayAssociation:this.active.relayAssociation}:{})};}

  /** Keep maintenance reads on this owner's endpoint without disturbing ordinary pending RPCs.
   * Both this client and its receiver lack daemon-management authority on the retained proof lane. */
  observeModels(options:Pick<CodexRequestOptions,'requestTimeoutMs'>={}):Promise<any>{
    if(this.closed)return Promise.reject(new CodexAppServerClientError('Codex app-server client is closed.','ambiguous'));
    this.modelObservationClient??=new CodexAppServerClient(this.socketPath,this.nodeExecutable,
      {...this.options,manageDaemon:false,protectedRelay:true});
    return this.modelObservationClient.request('model/list',{},options);
  }

  connect(): Promise<number> {
    if (this.closed) {
      return Promise.reject(new CodexAppServerClientError("Codex app-server client is closed.", "ambiguous"));
    }
    if (this.connecting) return this.connecting;
    if (this.active) return Promise.resolve(this.active.generation);
    const connection = this.createConnection();
    this.active = connection;
    const connecting = this.initializeConnection(connection).finally(() => {
      if (this.connecting === connecting) this.connecting = null;
    });
    this.connecting = connecting;
    return connecting;
  }

  async request(
    method: string,
    params: unknown,
    options: CodexRequestOptions = {},
  ): Promise<any> {
    if (options.expectedConnectionGeneration !== undefined
      && this.active?.generation !== options.expectedConnectionGeneration)
      throw new CodexAppServerClientError(`Native connection changed before ${method}; protected operation remains held.`, "rejected");
    const generation = await this.connect();
    const connection = this.active;
    if (!connection || connection.generation !== generation
      || options.expectedConnectionGeneration !== undefined && generation !== options.expectedConnectionGeneration) {
      throw new CodexAppServerClientError(`Codex app-server disconnected before ${method}.`, "ambiguous");
    }
    const id = ++this.requestId;
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<any>((resolve, reject) => {
      const timeout = options.untilDisconnect ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerUnansweredError(
          `Codex app-server ${method} timed out after ${requestTimeoutMs}ms.`,
        ));
      }, requestTimeoutMs);
      this.pending.set(id, {
        connectionGeneration: connection.generation,
        method,
        resolve,
        reject,
        timeout,
        onAccepted: options.onAccepted,
      });
      if (isCustodyMutation(method)) {
        try {
          const scope={...forwardedScope(this.custodySenderId,connection.generation,method,params,options.custodyOwnerSessionId??null),nativeEndpoint:this.nativeEndpoint};
          refuseFrozenCustodyTarget(scope);
          custodyForwardGuard?.(scope);
          const {params:_params,...metadata}=scope;
          const recorded={...metadata,completed:false}; this.custodyForwardedScopes.push(recorded);
          const pending=this.pending.get(id); if(pending) pending.onCompleted=()=>{recorded.completed=true;};
        }
        catch(error) { clearTimeout(timeout); this.pending.delete(id); reject(error as Error); return; }
      }
      void this.send(connection, { type: "request", id, method, params }).catch((error) => {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async notify(method: string, params: unknown = {},options:Pick<CodexRequestOptions,'expectedConnectionGeneration'|'custodyOwnerSessionId'>={}) {
    if(options.expectedConnectionGeneration!==undefined&&this.active?.generation!==options.expectedConnectionGeneration)
      throw new CodexAppServerClientError(`Native connection changed before ${method}; protected notification remains held.`, "rejected");
    const generation = await this.connect();
    const connection = this.active;
    if (!connection || connection.generation !== generation
      ||options.expectedConnectionGeneration!==undefined&&generation!==options.expectedConnectionGeneration) {
      throw new CodexAppServerClientError(`Codex app-server disconnected before ${method}.`, "ambiguous");
    }
    if (isCustodyMutation(method)) {
      try {
        const scope={...forwardedScope(this.custodySenderId,connection.generation,method,params,options.custodyOwnerSessionId??null),nativeEndpoint:this.nativeEndpoint};
        refuseFrozenCustodyTarget(scope);
        custodyForwardGuard?.(scope);
        const {params:_params,...metadata}=scope;
        this.custodyForwardedScopes.push({...metadata,completed:false});
      }
      catch(error) { throw error; }
    }
    await this.send(connection, { type: "notification", method, params });
  }

  onNotification(listener: NotificationListener) {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onDisconnect(listener: DisconnectListener) {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  waitForDisconnect(generation: number) {
    const connection = this.active;
    return connection?.generation === generation ? connection.disconnected : Promise.resolve();
  }

  /** Lose one captured bridge/socket generation while leaving this client reconnectable. */
  async loseConnectionGeneration(generation: number): Promise<"observed" | "stale"> {
    const connection = this.active;
    if (!connection || connection.generation !== generation || this.closed) return "stale";
    // SIGKILL is sent only to this client's owned bridge, whose bridge owns this socket. SIGTERM
    // asks the bridge to perform a WebSocket close handshake, which can wait on an unresponsive
    // server and leave this fault action ambiguous forever. The daemon and every other client are
    // untouched; success still waits for the normal child-exit disconnect path.
    connection.process.kill("SIGKILL");
    await connection.disconnected;
    return "observed";
  }

  async close(options: { immediate?: boolean } = {}) {
    if (this.closed) return;
    this.closed = true;
    const proof=this.modelObservationClient;this.modelObservationClient=null;
    await Promise.all([proof?.close(options),this.closeConnection(options)]);
  }

  private async closeConnection(options: {immediate?:boolean}) {
    const connection = this.active;
    if (!connection) return;
    if (options.immediate) {
      // Observer shutdown discards these reads. Reject them before any bridge I/O,
      // whose stream-write callback can otherwise keep the old owner waiting.
      this.failConnection(connection, new CodexAppServerClientError("Codex app-server observer closed.", "ambiguous"));
      connection.process.kill("SIGTERM");
    } else {
      try {
        await this.send(connection, { type: "close" });
      } catch {}
      this.failConnection(
        connection,
        new CodexAppServerClientError("Codex app-server client closed.", "ambiguous"),
      );
    }
    const shutdownGraceMs = this.options.shutdownGraceMs ?? 1_000;
    if (await this.waitForExit(connection, shutdownGraceMs)) return;
    connection.process.kill("SIGTERM");
    if (await this.waitForExit(connection, shutdownGraceMs)) return;
    connection.process.kill("SIGKILL");
    if (!await this.waitForExit(connection, shutdownGraceMs)) {
      throw new CodexAppServerClientError(
        "Codex app-server bridge did not exit after SIGKILL.",
        "ambiguous",
      );
    }
  }

  private createConnection(): ActiveConnection {
    const generation = ++this.generation;
    const relay = this.options.relayRunner ?? null;
    // The daemon's limits and scope are this machine's business only when it runs here.
    if (!relay && this.options.manageDaemon !== false) {
      void raiseCodexDaemonFileLimit();
      void moveCodexDaemonToOwnScope();
    }
    const bridgePath = this.options.bridgePath || releaseCodexBridgePath();
    const child = spawn(this.nodeExecutable, [bridgePath, this.socketPath,
      ...(relay ? [`/runner/v1/relay/connect?runner=${encodeURIComponent(relay)}&target=${this.options.protectedRelay?'codex-app-server-protected-v1':'codex-app-server'}&challenge=${randomUUID()}`] : [])], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let resolveDisconnected!: () => void;
    const disconnected = new Promise<void>((resolve) => { resolveDisconnected = resolve; });
    let resolveExited!: () => void;
    const exited = new Promise<void>((resolve) => { resolveExited = resolve; });
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const connection: ActiveConnection = {
      generation,
      process: child,
      disconnected,
      resolveDisconnected,
      exited,
      resolveExited,
      ready,
      resolveReady,
      rejectReady,
      stderr: "",
    };
    onJsonLines(child.stdout, (line) => this.receive(connection, line));
    child.stderr.on("data", (chunk) => {
      connection.stderr = `${connection.stderr}${String(chunk)}`.slice(-4_000);
    });
    child.stdin.on("error", (error) => this.failConnection(connection, error));
    child.once("error", (error) => {
      connection.resolveExited();
      this.failConnection(connection, error);
    });
    child.once("exit", (code, signal) => {
      connection.resolveExited();
      this.failConnection(
        connection,
        new CodexAppServerClientError(
          `Codex app-server bridge exited (${signal || (code ?? "unknown")})${connection.stderr ? `: ${connection.stderr.trim()}` : ""}`,
          "ambiguous",
        ),
      );
    });
    return connection;
  }

  private async initializeConnection(connection: ActiveConnection) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        connection.ready,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new CodexAppServerClientError(
            "Codex app-server bridge initialization timed out.",
            "ambiguous",
          )), DEFAULT_REQUEST_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      this.failConnection(connection, error);
      connection.process.kill("SIGTERM");
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (this.active !== connection) {
      throw new CodexAppServerClientError("Codex app-server connection was replaced during initialization.", "ambiguous");
    }
    return connection.generation;
  }

  private send(connection: ActiveConnection, message: unknown): Promise<void> {
    if (this.active !== connection || !connection.process.stdin.writable) {
      return Promise.reject(new CodexAppServerClientError(
        "Codex app-server bridge is not writable.",
        "ambiguous",
      ));
    }
    return new Promise((resolve, reject) => {
      connection.process.stdin.write(jsonLine(message), (error) => {
        if (error) {
          reject(new CodexAppServerClientError(error.message, "ambiguous"));
        } else {
          resolve();
        }
      });
    });
  }

  private waitForExit(connection: ActiveConnection, milliseconds: number) {
    return Promise.race([
      connection.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), milliseconds)),
    ]);
  }

  private receive(connection: ActiveConnection, line: string) {
    if (this.active !== connection) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === "ready") {
      connection.serverInfo=event.serverInfo??null;
      if(this.options.protectedRelay&&this.options.relayRunner&&(!event.relayAssociation||!event.relayAssociation.protected)){
        this.failConnection(connection,new CodexAppServerClientError('Protected runner association missing.','rejected'));connection.process.kill('SIGTERM');return;
      }
      const freeze=(value:any):any=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
      connection.relayAssociation=event.relayAssociation?freeze(event.relayAssociation):undefined;
      connection.resolveReady();
      return;
    }
    if (event.type === "disconnect") {
      this.failConnection(connection, new CodexAppServerClientError(
        event.error || "Codex app-server bridge disconnected.",
        "ambiguous",
      ));
      connection.process.kill("SIGTERM");
      return;
    }
    if (event.type === "response") {
      const id = Number(event.id);
      const pending = this.pending.get(id);
      if (!pending || pending.connectionGeneration !== connection.generation) return;
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      if (event.error) {
        const errorCode = Number(event.error.code);
        pending.onCompleted?.();
        pending.reject(new CodexAppServerClientError(
          `Codex app-server ${pending.method} failed: ${event.error.message || JSON.stringify(event.error)}`,
          errorCode === -32602 || errorCode === -32001 ? "rejected" : "ambiguous",
          errorCode,
          event.error.data,
        ));
        return;
      }
      try {
        pending.onAccepted?.(event.result);
        pending.onCompleted?.();
        pending.resolve(event.result);
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    if (event.type !== "event" || !event.event?.method) return;
    for (const listener of this.notificationListeners) {
      try {
        listener(event.event);
      } catch {}
    }
  }

  private failConnection(connection: ActiveConnection, cause: unknown) {
    if (this.active !== connection) return;
    const error = cause instanceof CodexAppServerClientError
      ? cause
      : new CodexAppServerClientError(
        cause instanceof Error ? cause.message : String(cause),
        "ambiguous",
      );
    this.active = null;
    // The bridge reports the socket's own refusal; only a socket nobody is listening on starts one.
    // Through a runner's relay the runner starts its own App Server; here nothing is started.
    const absent = this.options.relayRunner || this.options.manageDaemon === false
      ? null : /connect (ECONNREFUSED|ENOENT)/.exec(error.message);
    if (absent) startCodexDaemonWhenAbsent(absent[1]!);
    connection.rejectReady(error);
    for (const [id, pending] of this.pending) {
      if (pending.connectionGeneration !== connection.generation) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      pending.reject(error);
    }
    connection.resolveDisconnected();
    for (const listener of this.disconnectListeners) {
      try {
        listener(error, connection.generation);
      } catch {}
    }
  }
}

function refuseFrozenCustodyTarget(scope:CodexCustodyForwardScope) {
  for(const target of frozenCustodyTargets.values()) {
    const sender=[...custodyClients].find(client=>client.custodySenderId===scope.senderId);
    const sameEndpoint=!target.endpoint||sender?.nativeEndpoint.socketPath===target.endpoint.socketPath&&sender.nativeEndpoint.relayRunner===target.endpoint.relayRunner;
    if(scope.ownerSessionId===target.ownerSessionId||sameEndpoint&&(scope.threadId===target.threadId
      ||scope.ownerSessionId===null&&(scope.classification==="thread-path"||scope.classification==="unkeyed-thread")))
      throw new CodexAppServerClientError("Native sender is frozen for custody reconciliation; competing write remains held.","rejected");
  }
}

export type ManagedCodexCustodyCutoff = {
  ownerSessionId:number;
  threadId:string;
  endpoint:CustodyCutoffEndpoint|null;
  sourcePath:string|null;
  bindingGeneration:number|null;
  frozenAt:string;
  captured:Array<{senderId:string;generation:number;endpoint:CodexAppServerClient["nativeEndpoint"]}>;
  barriers:Array<{senderId:string;generation:number;threadId:string;completedAt:string}>;
  unresolved:string[];
  coverage:"managed-client-registry-only";
  externalCoverage:"not-asserted";
  assertCurrentHold():void;
  reconcile():Promise<ManagedCodexCustodyCutoffReceipt>;
};
export type ManagedCodexCustodyCutoffReceipt=Omit<ManagedCodexCustodyCutoff,"assertCurrentHold"|"reconcile">;

/** Install an in-process cutoff synchronously, then acknowledge the exact target on every
 * captured live sender generation. This is not proof for senders outside this managed registry. */
export function freezeManagedCodexTarget(input:{ownerSessionId:number;threadId:string;timeoutMs?:number;endpoint?:CustodyCutoffEndpoint;sourcePath?:string;bindingGeneration?:number}):ManagedCodexCustodyCutoff {
  assertCustodyEndpoint(input.endpoint,false);
  const key=`${input.ownerSessionId}:${input.threadId}`;
  const priorHold=frozenCustodyTargets.get(key);
  if(priorHold?.endpoint&&input.endpoint
    &&(priorHold.endpoint.socketPath!==input.endpoint.socketPath||priorHold.endpoint.relayRunner!==input.endpoint.relayRunner))
    throw new CodexAppServerClientError('The protected target already has a cutoff on another native endpoint; re-establish its association before use.','rejected');
  if(priorHold?.endpoint&&!input.endpoint)
    throw new CodexAppServerClientError('A protected target cannot discard its exact native endpoint association.','rejected');
  frozenCustodyTargets.set(key,{ownerSessionId:input.ownerSessionId,threadId:input.threadId,endpoint:input.endpoint});
  const captured=[...custodyClients].filter(c=>c.activeGeneration!==null&&(!input.endpoint
    ||c.nativeEndpoint.socketPath===input.endpoint.socketPath&&c.nativeEndpoint.relayRunner===input.endpoint.relayRunner)
    &&c.custodyForwardedScopes.some(scope=>scope.threadId===input.threadId||scope.ownerSessionId===input.ownerSessionId
      ||scope.ownerSessionId===null&&(scope.classification==="thread-path"||scope.classification==="unkeyed-thread")))
    .map(client=>({client,generation:client.activeGeneration!,senderId:client.custodySenderId,endpoint:client.nativeEndpoint}));
  const incompatibleTargetWriters=[...custodyClients].filter(c=>c.activeGeneration!==null&&input.endpoint
    &&(c.nativeEndpoint.socketPath!==input.endpoint.socketPath||c.nativeEndpoint.relayRunner!==input.endpoint.relayRunner)
    &&c.custodyForwardedScopes.some(scope=>scope.threadId===input.threadId||scope.ownerSessionId===input.ownerSessionId));
  const barriers:ManagedCodexCustodyCutoff["barriers"]=[];
  const unresolved:string[]=[];
  let reconciled=false;
  const cutoff:ManagedCodexCustodyCutoff={ownerSessionId:input.ownerSessionId,threadId:input.threadId,endpoint:input.endpoint??null,sourcePath:input.sourcePath??null,bindingGeneration:input.bindingGeneration??null,frozenAt:new Date().toISOString(),captured:captured.map(({senderId,generation,endpoint})=>({senderId,generation,endpoint})),barriers,unresolved,coverage:"managed-client-registry-only",externalCoverage:"not-asserted",
    assertCurrentHold(){
      assertCustodyEndpoint(input.endpoint,false);
      const held=frozenCustodyTargets.get(key);
      if(!held||held.endpoint&&(held.endpoint.socketPath!==input.endpoint?.socketPath||held.endpoint.relayRunner!==input.endpoint?.relayRunner))
        throw new Error("Managed native target cutoff no longer covers its exact endpoint.");
    },
    async reconcile(){
      cutoff.assertCurrentHold();
      if(reconciled)return JSON.parse(JSON.stringify(cutoff)) as ManagedCodexCustodyCutoffReceipt;
      if(captured.length===0)unresolved.push("No managed active sender generation was captured; absence is not coverage.");
      if(incompatibleTargetWriters.length) unresolved.push(`Matching target writes exist on ${incompatibleTargetWriters.length} incompatible native endpoint(s).`);
      for(const client of custodyClients){
        const relevant=client.custodyForwardedScopes.map((scope,index)=>({scope,index})).filter(({scope})=>scope.threadId===input.threadId||scope.ownerSessionId===input.ownerSessionId
          ||scope.ownerSessionId===null&&(scope.classification==="thread-path"||scope.classification==="unkeyed-thread"));
        const covered=custodyBarrierGenerations.get(client.custodySenderId)??new Map<number,Map<string,number>>();
        for(const {scope,index} of relevant) if(client.activeGeneration!==scope.generation
          &&((covered.get(scope.generation)?.get(scope.serializationKey??'unknown')??-1)<=index))
          unresolved.push(`Sender ${client.custodySenderId} has relevant writes at/after the last barrier on ended generation ${scope.generation}.`);
      }
      for(const row of captured){
        const prior=row.client.custodyForwardedScopes.filter(scope=>scope.generation===row.generation
          && (scope.threadId===input.threadId || scope.ownerSessionId===input.ownerSessionId
            ||scope.ownerSessionId===null&&(scope.classification==="thread-path"||scope.classification==="unkeyed-thread")));
        for(const scope of prior) if(scope.classification==="thread-path"||scope.classification==="unkeyed-thread"
          ||scope.serializationKey!==`thread:${input.threadId}`)
          unresolved.push(`Sender ${row.senderId} has ${scope.classification} ${scope.method} on ${scope.serializationKey??'unknown key'}; the target thread/read cannot establish its complete disposition (RPC completed=${scope.completed}).`);
        if(row.client.activeGeneration!==row.generation){unresolved.push(`Sender ${row.senderId} lost captured generation ${row.generation} before its same-generation barrier.`);continue;}
        try {
          assertCustodyEndpoint(row.endpoint,false);
          if(JSON.stringify(row.endpoint)!==JSON.stringify(row.client.nativeEndpoint))
            throw new Error('The captured sender changed its exact native endpoint association.');
          if(input.endpoint?.relayRunner&&JSON.stringify(row.endpoint.relayAssociation?.nativePeer)!==JSON.stringify(input.endpoint.relayAssociation?.nativePeer))
            throw new Error('The captured relay pair reaches a different native process incarnation.');
          const result=await row.client.request("thread/read",{threadId:input.threadId},{expectedConnectionGeneration:row.generation,requestTimeoutMs:input.timeoutMs??30_000});
          assertCustodyEndpoint(row.endpoint,false);
          if(row.client.activeGeneration!==row.generation||JSON.stringify(row.endpoint)!==JSON.stringify(row.client.nativeEndpoint))
            throw new Error('The captured sender lost its exact native association during its barrier.');
          const returned=result?.thread?.id;
          if(returned!==input.threadId){unresolved.push(`Sender ${row.senderId} returned a nonmatching thread/read identity.`);continue;}
          const covered=custodyBarrierGenerations.get(row.senderId)??new Map<number,Map<string,number>>();
          const byKey=covered.get(row.generation)??new Map<string,number>();
          byKey.set(`thread:${input.threadId}`,row.client.custodyForwardedScopes.length);
          covered.set(row.generation,byKey);custodyBarrierGenerations.set(row.senderId,covered);
          barriers.push({senderId:row.senderId,generation:row.generation,threadId:input.threadId,completedAt:new Date().toISOString()});
        } catch(error) { unresolved.push(`Sender ${row.senderId} generation ${row.generation} barrier failed: ${error instanceof Error?error.message:String(error)}`); }
      }
      reconciled=true;
      return JSON.parse(JSON.stringify(cutoff)) as ManagedCodexCustodyCutoffReceipt;
    }};
  return cutoff;
}

let sharedClient: CodexAppServerClient | null = null;

/**
 * The App Server every Codex turn uses. With `CONCIERGE_CODEX_RUNNER` set it is that runner's,
 * reached through this owner's relay (docs/architecture/RUNNERS.md); otherwise this machine's.
 */
export function sharedCodexAppServerClient() {
  sharedClient ??= ownerCodexAppServerClient();
  return sharedClient;
}

/** A new connection to the App Server Concierge's turns use, wherever it runs (the observer keeps its own). */
export function ownerCodexAppServerClient(options:{protectedRelay?:boolean;manageDaemon?:boolean;relayRunner?:string|null}={}): CodexAppServerClient {
  const runner = options.relayRunner===undefined?codexRelayRunner():options.relayRunner;
  return runner
    ? new CodexAppServerClient(join(process.env.CONCIERGE_STATE_DIR?.trim() || join(homedir(), ".local/state/concierge"), "requests.sock"),
      undefined, { ...options,relayRunner: runner })
    : new CodexAppServerClient(undefined,undefined,options);
}

export function codexRelayRunner(): string | null {
  return process.env.CONCIERGE_CODEX_RUNNER?.trim() || null;
}

let codexAppServerReadiness: Promise<void> | null = null;

/**
 * Settles once the App Server Concierge's turns use has answered in this process. Codex turns, new
 * and adopted, wait here before connecting, so an unreachable App Server or runner relay holds them
 * instead of failing them, and never stops Concierge itself from starting. The first caller starts
 * the probe, so every process that runs Codex turns has one.
 */
export function codexAppServerReady(): Promise<void> {
  codexAppServerReadiness ??= probeCodexAppServerUntilReady(
    () => sharedCodexAppServerClient().request("model/list", {}, { requestTimeoutMs: 10_000 }));
  return codexAppServerReadiness;
}

/** A turn's wait ends with its owner; the shared readiness probe may keep running for other work. */
export async function waitForCodexAppServerOrDrain(
  readiness: Promise<void>, drainStarted: Promise<void>, isDraining: () => boolean,
): Promise<void> {
  if (isDraining()) throw new OwnerDrainBeforeProviderAdmissionError();
  await Promise.race([readiness, drainStarted.then(() => { throw new OwnerDrainBeforeProviderAdmissionError(); })]);
  if (isDraining()) throw new OwnerDrainBeforeProviderAdmissionError();
}

/** Startup's readiness phase: the same probe, which never gives up and never throws. */
export function verifySharedCodexAppServerReady(): Promise<void> {
  return codexAppServerReady();
}

/**
 * Probes until the App Server answers. It never gives up: on 2026-11-04 a fatal startup probe took
 * the whole owner down three times while only Codex was unreachable
 * (docs/incidents/2026-11-04-codex-runner-relay-startup-order.md).
 */
export async function probeCodexAppServerUntilReady(probe: () => Promise<unknown>,
  sleep: (ms: number) => Promise<unknown> = ms => Bun.sleep(ms)): Promise<void> {
  let failures = 0;
  let loggedAt = 0;
  for (;;) {
    try {
      await probe();
      if (failures > 0) log("info", "codex_app_server_ready", { failed_probes: failures });
      return;
    } catch (error) {
      failures++;
      if (Date.now() - loggedAt >= 60_000) {
        loggedAt = Date.now();
        log("error", "codex_app_server_unready", { failed_probes: failures,
          relay_runner: codexRelayRunner(), ...errorFields(error) });
      }
      await sleep(Math.min(1_000 * failures, 15_000));
    }
  }
}

export async function closeSharedCodexAppServerClient() {
  await sharedClient?.close();
  sharedClient = null;
}
