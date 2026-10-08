import {releaseWorkerPath} from "./release-worker";

/** Search work runs outside the one-request-at-a-time owner loop. Query text uses stdin. */
export async function searchPrepared(query:string,limit:number,includeTools:boolean) {
  const script=releaseWorkerPath("presentation-search-read");
  const child=Bun.spawn([process.execPath,script],{env:process.env,stdin:'pipe',stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>child.kill(),10_000);
  try {
    child.stdin.write(JSON.stringify({query,limit,includeTools}));child.stdin.end();
    const output=await new Response(child.stdout).text(),code=await child.exited;
    if(code!==0)throw new Error('Prepared search failed.');
    return JSON.parse(output) as {hits:any[];examined:number;hasMore:boolean;omissions:string[];
      coverage:{complete:boolean;appliedSequence:number;sourceHead:number}};
  } finally {clearTimeout(timer);if(child.exitCode===null)child.kill();}
}
