import {existsSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {log} from './log';

/** The owner never waits for projection work. A child owns its SQLite file and lease. */
export function startPresentationWorker() {
  const directory=dirname(resolve(process.argv[1]??''));
  const bundled=join(directory,'presentation-message-worker.js');
  const source=join(directory,'presentation-message-worker.ts');
  const workerPath=existsSync(bundled)?bundled:source;
  if(!existsSync(workerPath))throw new Error('The presentation worker is missing from this release.');
  let stopped=false,child:ReturnType<typeof Bun.spawn>|null=null;
  let restart:ReturnType<typeof setTimeout>|null=null;
  const launch=()=>{
    if(stopped)return;
    child=Bun.spawn([process.execPath,workerPath],{env:process.env,stdin:'ignore',stdout:'ignore',stderr:'inherit'});
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
