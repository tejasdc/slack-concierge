import {historyDetailPart} from './history-message-preview';

/** One selected message, never a session history. Repeated part reads cannot reparse it. */
export class HistoryDetailCache {
  private held:{key:string;full:string;at:number}|null=null;
  private readonly retainedBytes=32*1024*1024;
  async part(key:string,part:number,load:()=>Promise<string>):Promise<ReturnType<typeof historyDetailPart>> {
    const now=Date.now();
    const cached=this.held?.key===key&&now-this.held.at<60_000?this.held.full:null;
    const full=cached??await load();
    if(cached===null)this.held=Buffer.byteLength(full)<=this.retainedBytes?{key,full,at:now}:null;
    return historyDetailPart(full,part);
  }
}
