import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { log, errorFields } from "./log";
import type { HumanCommand } from "./human-command-state";
import {currentProcessIdentity,processIdentityPayload} from './runtime-identity';
import {nextRetry} from './retry-core';
import {RETRY_POLICIES} from './retry-policies';

export type CommandDelivery = Readonly<{status:number;value:unknown}>;

/** The already root-private Thinkering capability socket runs its existing mutation preparation. */
export function callThinkeringCommand(path:string,command:unknown,socketPath:string):Promise<CommandDelivery>{
  return new Promise((resolve,reject)=>{
    const bytes=Buffer.from(JSON.stringify(command));
    const request=httpRequest({socketPath,path,method:"POST",timeout:30_000,
      headers:{"content-type":"application/json","content-length":bytes.length}},response=>{
      const chunks:Buffer[]=[];let size=0;
      response.on("data",chunk=>{
        const part=Buffer.from(chunk as Uint8Array);size+=part.length;
        if(size>1_048_576){response.destroy(new Error("Command owner response is too large."));return;}
        chunks.push(part);
      });
      response.once("error",reject);
      response.once("end",()=>{
        try{resolve({status:response.statusCode??503,value:JSON.parse(Buffer.concat(chunks).toString("utf8"))});}
        catch(error){reject(error);}
      });
    });
    request.once("timeout",()=>request.destroy(new Error("Thinkering command gateway timed out.")));
    request.once("error",reject);
    request.end(bytes);
  });
}

/**
 * The capture service keeps custody. This replaceable worker only transfers a retained command
 * to the existing owner route. An unconfirmed response is retried with its original action ID.
 */
export class HumanCommandWorker {
  private running=false;
  private timer:ReturnType<typeof setTimeout>|null=null;
  private active:Promise<void>|null=null;
  private nextPollMs=250;
  private queueFailures=0;
  private queueFailureSince=0;
  private queueNotified=false;
  private readonly workerId=randomUUID();
  private readonly owner=currentProcessIdentity();
  constructor(private readonly options:Readonly<{
    queueUrl:string;queueToken:string;
    prepare:(command:HumanCommand)=>Promise<CommandDelivery>;
    deliver:(command:HumanCommand,prepared:unknown)=>Promise<CommandDelivery>;
    refused?:(command:HumanCommand,result:CommandDelivery)=>Promise<void>|void;
    stopped?:(command:HumanCommand,reason:string,stage:"preparation"|"owner")=>Promise<void>|void;
    queueStopped?:(reason:string)=>Promise<void>|void;
    fetch?:typeof fetch;
  }>){ }

  start(){if(this.running)return;this.running=true;this.wake();}
  async stop(){this.running=false;if(this.timer)clearTimeout(this.timer);this.timer=null;await this.active;}
  wake(){if(!this.running||this.active)return;if(this.timer)clearTimeout(this.timer);this.timer=null;this.active=this.drain()
    .catch(error=>{log("error","human_command_worker_failed",errorFields(error));})
    .finally(()=>{this.active=null;if(this.running)this.schedule(this.nextPollMs);});}
  private schedule(ms:number){if(!this.running||this.timer)return;this.timer=setTimeout(()=>{this.timer=null;this.wake();},ms);}
  private async queue(path:string,body:unknown):Promise<Response>{
    const response=await (this.options.fetch??fetch)(`${this.options.queueUrl}${path}`,{
      method:"POST",headers:{authorization:`Bearer ${this.options.queueToken}`,"content-type":"application/json"},
      body:JSON.stringify(body),signal:AbortSignal.timeout(10_000),
    });
    if(response.status===204)return response;
    if(!response.ok)throw new Error(`Command queue ${path} answered ${response.status}`);
    return response;
  }
  private async drain(){
    while(this.running){
      const claimId=randomUUID();
      let claimed:Response;
      try{claimed=await this.queue("/commands/claim",{claimId,
        owner:processIdentityPayload(this.owner),workerId:this.workerId});}
      catch(error){
        this.queueFailures++;
        this.queueFailureSince ||=Date.now();
        const next=nextRetry({policy:RETRY_POLICIES.humanCommandQueue,attempt:this.queueFailures,
          startedAtMs:this.queueFailureSince,nowMs:Date.now(),classification:'transient'});
        this.nextPollMs=next.action==='retry'?Math.max(0,next.atMs-Date.now()):RETRY_POLICIES.humanCommandQueue.capDelayMs;
        if(next.action==='stop'&&!this.queueNotified){
          await this.options.queueStopped?.('The command custody queue stopped answering; retained commands remain pending.');
          this.queueNotified=true;
        }
        if(this.queueFailures===1||this.queueFailures%10===0)
          log("warn","human_command_claim_unavailable",{attempts:this.queueFailures,...errorFields(error)});
        return;
      }
      this.queueFailures=0;this.queueFailureSince=0;this.queueNotified=false;this.nextPollMs=250;
      if(claimed.status===204)return;
      const payload=await claimed.json() as {command:HumanCommand;prepared:unknown|null;attempts:number;createdAt:string;retryWindowStartedMs:number|null};
      const command=payload.command;
      const deliveryStarted=performance.now();
      let result:CommandDelivery;
      let decisionStage:"preparation"|"owner"="owner";
      let prepared=payload.prepared;
      if(!prepared){
        let preparation:CommandDelivery;
        try{preparation=await this.options.prepare(command);}
        catch(error){
          await this.retryOrStop(command,claimId,payload.attempts,payload.retryWindowStartedMs,payload.createdAt,
            `Preparation gateway unavailable: ${String(error)}`,'preparation');
          continue;
        }
        if(preparation.status>=500){
          await this.retryOrStop(command,claimId,payload.attempts,payload.retryWindowStartedMs,payload.createdAt,
            `Preparation gateway answered ${preparation.status}; delivery has not started.`,'preparation');
          continue;
        }
        if(preparation.status>=400){result=preparation;decisionStage="preparation";}
        else {
          prepared=preparation.value;
          let bytes:number;
          try{bytes=Buffer.byteLength(JSON.stringify({claimId,prepared}));}catch{bytes=Infinity;}
          if(!prepared||typeof prepared!=="object"||Array.isArray(prepared)||bytes>1_048_576){
            result={status:422,value:{error:{code:"INVALID_PREPARED_COMMAND",
              message:"The command could not be prepared for delivery."}}};
            decisionStage="preparation";
          }else {
            try{await this.queue(`/commands/${encodeURIComponent(command.actionId)}/prepare`,{claimId,prepared});}
            catch(error){
              await this.retryOrStop(command,claimId,payload.attempts,payload.retryWindowStartedMs,payload.createdAt,
                `Prepared command custody unavailable: ${String(error)}`,'preparation');
              continue;
            }
          }
        }
      }
      if(decisionStage==="owner")try{result=await this.options.deliver(command,prepared);}
      catch(error){
        log("warn","human_command_owner_unavailable",{action_id:command.actionId,attempts:payload.attempts,...errorFields(error)});
        await this.retryOrStop(command,claimId,payload.attempts,payload.retryWindowStartedMs,payload.createdAt,String(error));
        continue;
      }
      if(result.status>=500){
        await this.retryOrStop(command,claimId,payload.attempts,payload.retryWindowStartedMs,payload.createdAt,`Owner answered ${result.status}; acceptance is not proven.`);
        continue;
      }
      // A notification can close after transport custody. A later semantic refusal must
      // still reach its human; publish idempotently before settling that retained command.
      if(result.status>=400)await this.options.refused?.(command,result);
      await this.queue(`/commands/${encodeURIComponent(command.actionId)}/settle`,{
        claimId,ownerStatus:result.status,ownerResponse:result.value,decisionStage,
      });
      log(result.status<300?"info":"warn","human_command_owner_settled",{
        action_id:command.actionId,owner_status:result.status,attempts:payload.attempts,
        delivery_ms:Math.round(performance.now()-deliveryStarted),
      });
    }
  }
  private async retryOrStop(command:HumanCommand,claimId:string,attempts:number,retryWindowStartedMs:number|null,createdAt:string,reason:string,
    stage:"preparation"|"owner"="owner"){
    const startedAtMs=retryWindowStartedMs??Date.parse(createdAt.replace(' ','T')+'Z');
    const next=nextRetry({policy:RETRY_POLICIES.humanCommandDelivery,attempt:attempts,
      startedAtMs:Number.isFinite(startedAtMs)?startedAtMs:Date.now(),nowMs:Date.now(),classification:'transient'});
    const address=`/commands/${encodeURIComponent(command.actionId)}`;
    if(next.action==='retry'){
      await this.queue(address+'/retry',{claimId,nextAttemptMs:next.atMs});
      return;
    }
    await this.options.stopped?.(command,reason,stage);
    if(stage==='preparation'){
      // No owner exchange was attempted; this can settle as a preparation refusal.
      const refused={status:503,value:{error:{code:'COMMAND_PREPARATION_UNAVAILABLE',message:reason}}};
      await this.options.refused?.(command,refused);
      await this.queue(address+'/settle',{claimId,ownerStatus:503,ownerResponse:refused.value,decisionStage:'preparation'});
      return;
    }
    // A 5xx or lost acknowledgement does not prove the owner refused or skipped it.
    // Keep the exact command, halt this ordered stream, and let other streams proceed.
    await this.queue(address+'/exhaust',{claimId,reason});
    log('error','human_command_delivery_unconfirmed',{action_id:command.actionId,attempts,reason});
  }
}
