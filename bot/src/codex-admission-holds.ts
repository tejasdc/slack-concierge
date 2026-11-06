/** Admission stays closed until every operation that can replace the shared daemon settles. */
export class CodexAdmissionHolds {
  private readonly holders=new Set<string>();
  set(holder:string,held:boolean):boolean{
    if(!holder.trim())throw new Error('A Codex admission hold needs a stable holder identity.');
    if(held){const before=this.holders.size;this.holders.add(holder);return this.holders.size!==before;}
    return this.holders.delete(holder);
  }
  get isHeld():boolean{return this.holders.size>0;}
}
