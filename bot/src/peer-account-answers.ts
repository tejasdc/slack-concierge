type View=Record<string,unknown>;
type Answer=Readonly<{view:View;readStartedAt:number}>;

/**
 * Another machine's accounts without making Accounts wait for it. Opening the page used to await
 * every peer (up to 8 seconds, longer for a sleeping Mac) before showing this machine's rows; GPT-6
 * Astra's review of the 2026-10-07 complaint named it. An ordinary read shows the last answer that
 * machine gave, marked `checking`, and reads it again behind; a machine never heard from gets a
 * short wait and is then shown as checking. A `fresh` read asks that machine for a new check
 * the same way and does not wait for it either; the page reads again while a row says
 * `checking` (2026-11-03, when a fresh read took 11 to 20 seconds around a sign-in).
 *
 * An answer read before a sign-in action on that machine finished (`actedAt`) is never handed out
 * as that machine's current word, and a read already running then is not joined. The last answer
 * used to stand unmarked for 30 s whatever happened meanwhile, so a page reading just after starting
 * a sign-in on the Mac could be told nothing was waiting and drop the link he was about to open,
 * and a page could not trust a later reading to say a sign-in had ended (2026-11-04).
 *
 * The owner and the read worker each keep one of these; the owner publishes `actedAt` in its
 * sign-in state, which the worker reads before every accounts read.
 */
export class PeerAccountAnswers {
  private readonly answered=new Map<string,Answer>();
  private readonly latest=new Map<string,Answer>();
  private readonly running=new Map<string,Readonly<{read:Promise<View>;readStartedAt:number}>>();

  /** `read` returns that machine's view and turns any failure into an unreachable view itself. */
  view(name:string,fresh:boolean,actedAt:number,read:()=>Promise<Readonly<{view:View;answered:boolean}>>):Promise<View> {
    const current=(answer:Answer|undefined)=>answer&&answer.readStartedAt>=actedAt?answer:undefined;
    const latest=current(this.latest.get(name));
    // A peer that answered while its own check ran is asked again rather than trusted for 30 s.
    const stillChecking=Array.isArray(latest?.view.providers)&&(latest!.view.providers as any[]).some(row=>row?.checking===true);
    let running=this.running.get(name);
    if(running&&running.readStartedAt<actedAt)running=undefined;
    if(!fresh&&latest&&!running&&Date.now()-latest.readStartedAt<30_000&&!stillChecking)return Promise.resolve(latest.view);
    if(!running){
      const readStartedAt=Date.now();
      const started={readStartedAt,read:(async()=>{
        const result=await read();
        // A read overtaken by a later one never replaces that later answer.
        const keep=(store:Map<string,Answer>)=>{if((store.get(name)?.readStartedAt??-1)<=readStartedAt)store.set(name,{view:result.view,readStartedAt});};
        if(result.answered)keep(this.answered);
        keep(this.latest);
        return result.view;
      })().finally(()=>{if(this.running.get(name)===started)this.running.delete(name);})};
      this.running.set(name,started);
      running=started;
    }
    const answered=this.answered.get(name);
    if(answered)return Promise.resolve({...answered.view,checking:true});
    return Promise.race([running.read,new Promise<View>(resolve=>setTimeout(()=>
      resolve({name,self:false,reachable:true,note:null,providers:[],checking:true}),1_500))]);
  }
}
