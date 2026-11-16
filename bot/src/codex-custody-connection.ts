import {randomUUID} from 'node:crypto';
import type {CodexAppServerClientLike,CodexRequestOptions} from './codex-app-server-client';
import {isCodexNativeObservation} from './codex-native-observations';
import {assertCustodyEndpoint} from './codex-custody-colocation';

export type CustodyNativeConnection={clientId:string;senderId:string|null;generation:number;endpoint:CodexAppServerClientLike['nativeEndpoint']|null};
const clients=new WeakMap<CodexAppServerClientLike,CustodyConnection>();

/** A connection is association evidence, never a certificate of writer exclusion. A new
 * connection may reconcile history, but must re-establish the boundary before mutations. */
class CustodyConnection implements CodexAppServerClientLike {
  private generation:number|null=null;
  private readonly clientId=randomUUID();
  private expected:CustodyNativeConnection|undefined;
  private protectionRequired=false;
  constructor(private readonly client:CodexAppServerClientLike & {close?:()=>Promise<void>}){}
  get custodySenderId(){return this.client.custodySenderId;}
  get nativeEndpoint(){return this.client.nativeEndpoint;}
  async connect(){
    const generation=await this.client.connect();
    this.generation??=generation;
    return generation;
  }
  protect(witness:CustodyNativeConnection|undefined){this.expected=witness;this.protectionRequired=true;}
  async witness():Promise<CustodyNativeConnection>{
    const generation=await this.connect();
    if(generation!==this.generation)
      throw new Error('Protected native connection changed; custody remains held pending boundary reconciliation.');
    assertCustodyEndpoint(this.client.nativeEndpoint);
    return {clientId:this.clientId,senderId:this.client.custodySenderId??null,generation,
      endpoint:this.client.nativeEndpoint?structuredClone(this.client.nativeEndpoint):null};
  }
  async assert(witness:CustodyNativeConnection|undefined){
    const current=await this.witness();
    if(!witness||witness.clientId!==current.clientId||witness.senderId!==current.senderId||witness.generation!==current.generation
      ||JSON.stringify(witness.endpoint)!==JSON.stringify(current.endpoint))
      throw new Error('Protected construction belongs to another native connection; custody remains held.');
  }
  async request(method:string,params:unknown,options:CodexRequestOptions={}){
    const generation=await this.connect();
    if(!isCodexNativeObservation(method)){
      if(this.protectionRequired)await this.assert(this.expected);
      else await this.witness();
    }
    return this.client.request(method,params,{...options,expectedConnectionGeneration:generation});
  }
  async notify(method:string,params?:unknown,options:Pick<CodexRequestOptions,'custodyOwnerSessionId'>={}){
    if(this.protectionRequired)await this.assert(this.expected);else await this.witness();
    return this.client.notify(method,params,{...options,expectedConnectionGeneration:this.generation!});
  }
  onNotification:CodexAppServerClientLike['onNotification']=(listener)=>this.client.onNotification(listener);
  onDisconnect:CodexAppServerClientLike['onDisconnect']=(listener)=>this.client.onDisconnect(listener);
  waitForDisconnect:CodexAppServerClientLike['waitForDisconnect']=(generation)=>this.client.waitForDisconnect(generation);
  async close(){await this.client.close?.();}
}

export function custodyConnection(client:CodexAppServerClientLike):CustodyConnection {
  let bound=clients.get(client);
  if(!bound){bound=new CustodyConnection(client);clients.set(client,bound);clients.set(bound,bound);}
  return bound;
}
