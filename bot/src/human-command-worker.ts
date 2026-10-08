import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { log, errorFields } from "./log";
import type { HumanCommand } from "./human-command-state";
import {currentProcessIdentity} from './runtime-identity';

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
  private readonly workerId=randomUUID();
  private readonly owner=currentProcessIdentity();
  constructor(private readonly options:Readonly<{
    queueUrl:string;queueToken:string;
    prepare:(command:HumanCommand)=>Promise<CommandDelivery>;
    deliver:(command:HumanCommand,prepared:unknown)=>Promise<CommandDelivery>;
    refused?:(command:HumanCommand,result:CommandDelivery)=>Promise<void>|void;
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
      try{claimed=await this.queue("/commands/claim",{claimId,owner:this.owner,workerId:this.workerId});}
      catch(error){
        this.queueFailures++;
        this.nextPollMs=Math.min(30_000,500*Math.pow(2,Math.min(this.queueFailures,6)));
        if(this.queueFailures===1||this.queueFailures%10===0)
          log("warn","human_command_claim_unavailable",{attempts:this.queueFailures,...errorFields(error)});
        return;
      }
      this.queueFailures=0;this.nextPollMs=250;
      if(claimed.status===204)return;
      const payload=await claimed.json() as {command:HumanCommand;prepared:unknown|null;attempts:number};
      const command=payload.command;
      const deliveryStarted=performance.now();
      let result:CommandDelivery;
      let decisionStage:"preparation"|"owner"="owner";
      try{
        let prepared=payload.prepared;
        if(!prepared){
          const preparation=await this.options.prepare(command);
          if(preparation.status>=400){result=preparation;decisionStage="preparation";}
          else {
            prepared=preparation.value;
            if(!prepared||typeof prepared!=="object")throw new Error("Thinkering did not return a prepared command.");
            await this.queue(`/commands/${encodeURIComponent(command.actionId)}/prepare`,{claimId,prepared});
            result=await this.options.deliver(command,prepared);
          }
        }else result=await this.options.deliver(command,prepared);
      }
      catch(error){
        const delay=Math.min(60_000,1000*Math.pow(2,Math.min(payload.attempts,6)));
        log("warn","human_command_owner_unavailable",{action_id:command.actionId,attempts:payload.attempts,...errorFields(error)});
        try{await this.queue(`/commands/${encodeURIComponent(command.actionId)}/retry`,{claimId,nextAttemptMs:Date.now()+delay});}
        catch(retryError){log("error","human_command_retry_record_failed",{action_id:command.actionId,...errorFields(retryError)});}
        return;
      }
      if(result.status>=500){
        const delay=Math.min(60_000,1000*Math.pow(2,Math.min(payload.attempts,6)));
        await this.queue(`/commands/${encodeURIComponent(command.actionId)}/retry`,{claimId,nextAttemptMs:Date.now()+delay});
        return;
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
}
