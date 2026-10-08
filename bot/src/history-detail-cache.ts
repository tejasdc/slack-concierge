import {prepareHistoryDetail} from './history-message-preview';

/** One selected message, never a session history. Repeated part reads cannot reparse it. */
export class HistoryDetailCache {
  private held:{key:string;value:ReturnType<typeof prepareHistoryDetail>}|null=null;
  private pending:{key:string;value:Promise<ReturnType<typeof prepareHistoryDetail>>}|null=null;
  private timer:ReturnType<typeof setTimeout>|null=null;
  private async selected(key:string,expectedDigest:string,load:()=>Promise<string>) {
    if(this.held?.key===key)return this.held.value;
    if(this.pending?.key!==key){
      const value=load().then(full=>{
        const prepared=prepareHistoryDetail(full);
        if(prepared.digest!==expectedDigest)throw new Error('HISTORY_DETAIL_RESET_REQUIRED');
        return prepared;
      });
      this.pending={key,value};
      void value.then(prepared=>{
        if(this.pending?.key!==key)return;
        this.held={key,value:prepared};this.pending=null;
        if(this.timer)clearTimeout(this.timer);
        this.timer=setTimeout(()=>{if(this.held?.key===key)this.held=null;this.timer=null;},60_000);
        this.timer.unref?.();
      },()=>{if(this.pending?.key===key)this.pending=null;});
    }
    return this.pending!.value;
  }
  async part(key:string,expectedDigest:string,part:number,load:()=>Promise<string>){return (await this.selected(key,expectedDigest,load)).part(part);}
  async body(key:string,expectedDigest:string,load:()=>Promise<string>){return (await this.selected(key,expectedDigest,load)).body();}
}
