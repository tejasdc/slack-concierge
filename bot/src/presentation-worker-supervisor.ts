import {releaseWorkerPath} from "./release-worker";
import {log} from './log';

/** The owner never waits for projection work. A child owns its SQLite file and lease. */
export function startPresentationWorker() {
  const workerPath=releaseWorkerPath("presentation-message-worker");
  let stopped=false,child:ReturnType<typeof Bun.spawn>|null=null;
  let restart:ReturnType<typeof setTimeout>|null=null;
  const launch=()=>{
    if(stopped)return;
    child=Bun.spawn([process.execPath,workerPath],{env:process.env,stdin:'ignore',stdout:'inherit',stderr:'inherit'});
    const running=child;
    void running.exited.then(code=>{
      if(child===running)child=null;
      if(stopped)return;
      log('error','presentation_worker_exited',{code});
      restart=setTimeout(launch,2000);
    });
  };
  launch();
  return async()=>{
    stopped=true;
    if(restart){clearTimeout(restart);restart=null;}
    const running=child;if(running){running.kill();await running.exited;child=null;}
  };
}
