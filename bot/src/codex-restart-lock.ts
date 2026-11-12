/** Serialize owner-side Codex account switches and App Server re-homes. */
let restartQueue:Promise<unknown>=Promise.resolve();

export function withCodexRestartLock<T>(operation:()=>Promise<T>):Promise<T>{
  const next=restartQueue.then(operation,operation);
  restartQueue=next.catch(()=>undefined);
  return next;
}
