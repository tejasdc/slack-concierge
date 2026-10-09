import {strict as assert} from 'node:assert';
import {mkdtemp,rm,chmod,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ForegroundReadPool} from '../src/foreground-read-pool';

if(process.env.CONCIERGE_READ_SOCKET&&process.argv.includes('--executor')) {
  // A private synthetic executor, never imported by an application entry point.
  const server=Bun.serve({unix:process.env.CONCIERGE_READ_SOCKET,idleTimeout:0,async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/internal/ready')return Response.json({ok:true,pid:process.pid});
    if(path==='/block'){
      await writeFile(process.env.CONCIERGE_READ_SOCKET!+'.entered','entered');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,35_000);
    }
    return Response.json({ok:true,pid:process.pid,path});
  }});
  await chmod(process.env.CONCIERGE_READ_SOCKET,0o600);
  process.on('disconnect',()=>{server.stop(true);process.exit(0);});
  process.on('SIGTERM',()=>{server.stop(true);process.exit(0);});
} else {
  const root=await mkdtemp(join(tmpdir(),'concierge-foreground-pool-'));
  // The entry is a tiny wrapper inside this fixture's exclusively owned directory.
  const entry=join(root,'executor.ts');
  await Bun.write(entry,`process.argv.push('--executor'); await import(${JSON.stringify(import.meta.path)});`);
  const pool=new ForegroundReadPool(root,join(root,'unused-owner.sock'),entry);
  const request=(path:string,signal?:AbortSignal)=>pool.request(new Request('http://fixture'+path,{signal}),path,crypto.randomUUID());
  try {
    await pool.start();
    const abort=new AbortController();
    const blocked=request('/block',abort.signal);
    const until=Date.now()+5000;
    while(true){
      try {await stat(join(root,'request-read-0.sock.entered'));break;}catch{}
      assert.ok(Date.now()<until,'Blocked executor did not enter the controlled wait.');
      await Bun.sleep(10);
    }
    const started=performance.now();
    const latencies:number[]=[];
    for(let i=0;i<8;i++){
      const before=performance.now();
      const response=await request('/independent');
      assert.equal(response.status,200);
      const body=await response.json() as any;assert.equal(body.path,'/independent');
      latencies.push(performance.now()-before);
    }
    assert.ok(Math.max(...latencies)<1000,`Independent reads stalled: ${latencies}`);
    assert.ok(performance.now()-started<3000,'The other executor must not wait for a 35-second synchronous block.');
    abort.abort();assert.equal((await blocked).status,503);
    const after=await request('/after-cancel');assert.equal(after.status,200);await after.body?.cancel();
    console.log(JSON.stringify({fixture:'foreground-pool',status:'passed',blocked_executor_requested_ms:35000,
      independent_reads:latencies.length,independent_max_ms:Math.max(...latencies),independent_total_ms:performance.now()-started}));
  } finally {await pool.stop();await rm(root,{recursive:true,force:true});}
}
