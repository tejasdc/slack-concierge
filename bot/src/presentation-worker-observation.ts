import { writeLogLine } from './log';

/** Numeric-only worker facts. A lease heartbeat is not successful preparation. */
export class PresentationWorkerObservation {
  private emitted = -Infinity;
  private progressAt: number;
  private progress = 0;
  private failures = 0;
  private started: number;
  private checkpoint: {ready:number;source_head:number;generation:number}|null=null;
  constructor(private read:()=>{ready:number;source_head:number;generation:number;target:number},
    private write:(line:string)=>void=line=>writeLogLine('info',line),private now:()=>number=Date.now) {
    this.started=this.progressAt=now();
  }
  advance(){this.progress++;this.progressAt=this.now();this.emit();}
  succeeded(){this.failures=0;this.emit();}
  failed(){this.failures++;this.emit();}
  emit(){
    const at=this.now();if(at-this.emitted<10_000)return;this.emitted=at;
    let state:ReturnType<typeof this.read>|null=null;
    try{state=this.read();}catch{}
    if(state){
      const previous=this.checkpoint;
      // A small catch-up pass may commit without yielding a batch. Its durable
      // checkpoint is progress too; reading the same checkpoint while idle is not.
      if(previous&&state.ready&&(!previous.ready||state.generation>previous.generation
        ||(state.generation===previous.generation&&state.source_head>previous.source_head))){
        this.progress++;this.progressAt=at;
      }
      this.checkpoint={ready:state.ready,source_head:state.source_head,generation:state.generation};
    }
    const base={event:'presentation_worker_health',observed_at_ms:at,worker_pid:process.pid,
      worker_started_at_ms:this.started,progress:this.progress,last_progress_at_ms:this.progressAt,
      consecutive_failures:this.failures};
    this.write(JSON.stringify(state?{...base,available:true,ready:!!state.ready,
      generation:state.generation,applied_sequence:state.source_head,target_sequence:state.target}
      :{...base,available:false}));
  }
}
