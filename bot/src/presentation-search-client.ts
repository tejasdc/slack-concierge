import {releaseWorkerPath} from "./release-worker";
import type {RouterSearchRequest} from './router-search';

async function readSearchWorker(body:unknown) {
  const script=releaseWorkerPath("presentation-search-read");
  const child=Bun.spawn([process.execPath,script],{env:process.env,stdin:'pipe',stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>child.kill(),10_000);
  try {
    child.stdin.write(JSON.stringify(body));child.stdin.end();
    const output=await new Response(child.stdout).text(),code=await child.exited;
    if(code!==0)throw new Error('Search read failed.');
    return JSON.parse(output);
  } finally {clearTimeout(timer);if(child.exitCode===null)child.kill();}
}

/** Search work runs outside the one-request-at-a-time owner loop. Query text uses stdin. */
export async function searchPrepared(query:string,limit:number,includeTools:boolean) {
  return readSearchWorker({query,limit,includeTools}) as Promise<{hits:any[];examined:number;hasMore:boolean;omissions:string[];
      coverage:{complete:boolean;appliedSequence:number;sourceHead:number}}>;
}

/** Historical routing evidence is read with a separate read-only connection, off the owner loop. */
export async function searchRouterThreadsRead(request:RouterSearchRequest) {
  return readSearchWorker({kind:'routing',request}) as Promise<ReturnType<typeof import('./router-search').searchRouterThreads>>;
}
