/** Numeric-only worker facts. A lease heartbeat is not successful preparation. */
export class PresentationWorkerObservation {
  private emitted = -Infinity;
  private progressAt: number;
  private progress = 0;
  private failures = 0;
  private started: number;
  constructor(private read:()=>{ready:number;source_head:number;generation:number;target:number},
    private write:(line:string)=>void=console.log,private now:()=>number=Date.now) {
    this.started=this.progressAt=now();
  }
  advance(){this.progress++;this.progressAt=this.now();this.emit();}
  succeeded(){this.failures=0;this.emit();}
  failed(){this.failures++;this.emit();}
  emit(){
    const at=this.now();if(at-this.emitted<10_000)return;this.emitted=at;
    const base={event:'presentation_worker_health',observed_at_ms:at,worker_pid:process.pid,
      worker_started_at_ms:this.started,progress:this.progress,last_progress_at_ms:this.progressAt,
      consecutive_failures:this.failures};
    try{const state=this.read();this.write(JSON.stringify({...base,available:true,ready:!!state.ready,
      generation:state.generation,applied_sequence:state.source_head,target_sequence:state.target}));}
    catch{this.write(JSON.stringify({...base,available:false}));}
  }
}
