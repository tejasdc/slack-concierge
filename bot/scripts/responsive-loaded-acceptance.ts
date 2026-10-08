/** Loaded, isolated acceptance of execution-host adoption and owner responsiveness.
 * Usage: CONCIERGE_TEST_AUTHORIZATION=responsive-system-b1eed622 bun run bot/scripts/responsive-loaded-acceptance.ts
 * All provider output and owner state are generated under /tmp; no user/provider effects. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const AUTH="responsive-system-b1eed622";
if(process.env.CONCIERGE_TEST_AUTHORIZATION!==AUTH)throw new Error("Scoped native acceptance authorization required");
const base=resolve(import.meta.dir,"../..");
type Fixture={root:string;ids:string[];directories:string[];gates:string[];catalogueSize:number};
const percentile=(values:number[],p:number)=>values.length?values.slice().sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)]!:null;
const summary=(values:number[])=>({count:values.length,p50:percentile(values,.5),p95:percentile(values,.95),max:values.length?Math.max(...values):null});
const memory=()=>{const usage=process.memoryUsage();return {rss:usage.rss,heap:usage.heapUsed};};
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

async function probe(mode:"pre"|"measure",configPath:string){
  const fixture=JSON.parse(await readFile(configPath,"utf8")) as Fixture;
  if(mode==="pre"){
    const {HostConnection}=await import("../src/execution-host-client");
    const connections=[] as InstanceType<typeof HostConnection>[];
    for(const directory of fixture.directories){
      const connection=await HostConnection.connect(join(directory,"host.sock"));
      await connection.attach(1,()=>{});
      connections.push(connection);
    }
    console.log(JSON.stringify({kind:"pre_attached",count:connections.length,pid:process.pid}));
    await new Promise(()=>{});
    return;
  }
  const [{HostedClaudeCodeTransport},{ClaudeOutputAccumulator},{SessionOwner},{createNativeSession},{retainHumanCommand,commandStatus}]=await Promise.all([
    import("../src/execution-host-client"),import("../src/claude-code"),import("../src/session-owner"),import("../src/session-inputs"),
    import("../src/human-command-state")]);
  const {db}=await import('../src/state');
  const existing=db.query('SELECT id FROM sessions ORDER BY id LIMIT 1').get() as {id:number}|null;
  const session=existing??createNativeSession("claude-code",{title:"Loaded acceptance",cwd:fixture.root,project:"slack-concierge"});
  if(!existing)db.transaction(()=>{for(let index=1;index<fixture.catalogueSize;index++)createNativeSession("claude-code",{
    title:`Unrelated fixture ${index}`,cwd:fixture.root,project:"slack-concierge"});})();
  const owner=new SessionOwner({wake:()=>{},steer:()=>false,stop:async()=>false,available:()=>true,
    history:async()=>({messages:[{id:"fixture-message",role:"assistant",content:"prepared",tool:null,phase:null}],nextCursor:null})},fixture.root);
  const projector=spawn('setpriv',['--pdeathsig','KILL',process.execPath,join(base,'bot/src/presentation-message-worker.ts')],{
    env:process.env,stdio:['ignore','ignore','pipe']});
  let projectorErrors='';projector.stderr.on('data',chunk=>{projectorErrors=(projectorErrors+String(chunk)).slice(-4000);});
  process.once('exit',()=>projector.kill('SIGKILL'));
  const catalogueUrl='http://127.0.0.1/sessions/v1/presentation/sessions/window?space=everyday&limit=20';
  const readyBy=Date.now()+30_000;let preparedReady=false;
  while(Date.now()<readyBy){
    if(projector.exitCode!==null)throw new Error(`Projector exited: ${projectorErrors}`);
    const response=await owner.handle(new Request(catalogueUrl));
    const page=await response?.json() as any;
    if(response?.status===200&&page.coverage?.complete&&page.cards?.length===20){preparedReady=true;break;}
    await pause(25);
  }
  if(!preparedReady)throw new Error(`Catalogue preparation did not finish: ${projectorErrors}`);
  const delays={page:[] as number[],history:[] as number[],send:[] as number[],custody:[] as number[]};
  const lag:number[]=[];let lastTick=performance.now(),peak=memory(),events=0,replayEnded=0;
  const tick=setInterval(()=>{const now=performance.now();lag.push(Math.max(0,now-lastTick-50));lastTick=now;
    const used=memory();if(used.rss>peak.rss)peak=used;},50);
  const decoders=fixture.ids.map(()=>new ClaudeOutputAccumulator());
  const adoptionStarted=performance.now();
  const pending=fixture.ids.map((id,index)=>{
    let partial="";
    const transport=new HostedClaudeCodeTransport({mode:"adopt",executionId:id,executable:process.execPath,stateDir:fixture.root},
      {inactivityMs:30_000,shutdownGraceMs:200});
    return transport.run({args:[],cwd:fixture.root,stdin:"fixture",onStderr:()=>{},
      onStdout:chunk=>{
        const lines=(partial+chunk).split("\n");partial=lines.pop()||"";
        for(const line of lines){if(!line)continue;decoders[index]!.push(JSON.parse(line));events++;}
      },onReplayEnd:()=>{replayEnded++;}});
  });
  const replayDeadline=Date.now()+30_000;
  while(replayEnded<fixture.ids.length && Date.now()<replayDeadline)await pause(20);
  if(replayEnded!==fixture.ids.length)throw new Error(`Only ${replayEnded}/6 hosts replayed`);
  const replayDone=performance.now();
  console.log(JSON.stringify({kind:"stage",name:"replay_done",ms:Math.round(replayDone-adoptionStarted)}));
  let beginBrowser!:()=>void,finishBrowser!:()=>void;
  const browserStart=new Promise<void>(resolve=>{beginBrowser=resolve;});
  const browserFinished=new Promise<void>(resolve=>{finishBrowser=resolve;});
  if(process.env.CONCIERGE_ACCEPTANCE_EXTERNAL_BROWSER==='1'){
   const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>{
    const path=new URL(request.url).pathname;
    if(path==='/fixture/start'){beginBrowser();return Response.json({ok:true});}
    if(path==='/fixture/finish'){finishBrowser();return Response.json({ok:true});}
    return owner.handle(request).then(response=>response??new Response('Not found',{status:404}));
   }});
   console.log(JSON.stringify({kind:'owner_ready',port:server.port,pid:process.pid,sessionId:session.id}));
   await browserStart;
  }
  for(const gate of fixture.gates)await writeFile(gate,"continue");
  const baseUrl=`http://127.0.0.1/sessions/v1/sessions/concierge%3A${session.id}`;
  const read=async(kind:"page"|"history",url:string)=>{
    const start=performance.now();const response=await owner.handle(new Request(url));
    delays[kind].push(performance.now()-start);
    if(!response || response.status!==200)throw new Error(`${kind} returned ${response?.status}`);
    const value=await response.json() as any;
    if(kind==='page'&&value.cards?.length!==20)throw new Error('Prepared catalogue did not return the requested page');
  };
  // This direct owner sample uses the exact body that the real preparation adapter
  // produces for the fixture's empty-context web command. Custody retains the raw body.
  // Omitting door here creates a different payload under the same action identity.
  const send=async(actionId:string,text:string)=>{
    const start=performance.now();const response=await owner.handle(new Request(`${baseUrl}/inputs`,{method:"POST",
      headers:{"content-type":"application/json"},body:JSON.stringify({clientActionId:actionId,text,delivery:"queue",door:"web"})}));
    delays.send.push(performance.now()-start);
    if(!response || ![200,202].includes(response.status))throw new Error(`send returned ${response?.status}`);
    return response.json() as Promise<any>;
  };
  const start=performance.now();
  let lastAction="";let accepted:any;
  for(let index=0;index<40;index++){
    await read("page",catalogueUrl);
    await read("history",`${baseUrl}/history?limit=20`);
    lastAction=`loaded-${process.pid}-${index}`;
    const body={clientActionId:lastAction,text:`Synthetic input ${index}`,delivery:"queue"};
    const custodyStart=performance.now();
    const retained=retainHumanCommand({version:1,clientId:`loaded-client-${process.pid}`,sessionId:`concierge:${session.id}`,
      sequence:index+1,actionId:lastAction,door:"web",method:"POST",path:`/sessions/v1/sessions/concierge%3A${session.id}/inputs`,body});
    delays.custody.push(performance.now()-custodyStart);
    if(retained.status!=="pending")throw new Error("Human command custody was not retained");
    accepted=await send(lastAction,`Synthetic input ${index}`);
    if(index===19)await pause(250); // Transport pause only; real browser closure is a separate check.
    await pause(10);
  }
  console.log(JSON.stringify({kind:"stage",name:"interaction_done",count:40,ms:Math.round(performance.now()-start)}));
  const repeated=retainHumanCommand({version:1,clientId:`loaded-client-${process.pid}`,sessionId:`concierge:${session.id}`,
    sequence:40,actionId:lastAction,door:"web",method:"POST",
    path:`/sessions/v1/sessions/concierge%3A${session.id}/inputs`,
    body:{clientActionId:lastAction,text:"Synthetic input 39",delivery:"queue"}});
  if(repeated.action_id!==lastAction)throw new Error("Duplicate custody changed action identity");
  const duplicate=await send(lastAction,"Synthetic input 39");
  if(JSON.stringify(accepted)!==JSON.stringify(duplicate))throw new Error("Duplicate client action changed acceptance");
  let custodyDelivery:null|{count:number;status:'delivered'}=null;
  if(process.env.CONCIERGE_ACCEPTANCE_EXTERNAL_BROWSER==='1'){
    await browserFinished;
    // The browser journey keeps the real intake worker alive until it completes.
    // Never label direct owner timing as successful custody-to-owner delivery.
    for(let index=0;index<40;index++){
      const retained=commandStatus(`loaded-${process.pid}-${index}`);
      if(retained?.status!=='delivered'||retained.owner_status===null||retained.owner_status>=300)
        throw new Error(`Synthetic custody delivery failed: ${retained?.action_id} ${retained?.status} ${retained?.owner_status} ${retained?.owner_response_json}`);
    }
    custodyDelivery={count:40,status:'delivered'};
  }
  const hostResults=await Promise.allSettled(pending);
  const hostFailure=hostResults.find(result=>result.status==='rejected');
  if(hostFailure?.status==='rejected')throw hostFailure.reason;
  console.log(JSON.stringify({kind:"stage",name:"hosts_settled"}));
  clearInterval(tick);
  const cpu=process.cpuUsage();
  const status=await readFile("/proc/self/status","utf8").catch(()=>"");
  const swap=Number(status.match(/^VmSwap:\s*(\d+)/m)?.[1]||0)*1024;
  console.log(JSON.stringify({kind:"result",pid:process.pid,replayMs:Math.round(replayDone-adoptionStarted),
    interactionMs:Math.round(performance.now()-start),events,hostCount:fixture.ids.length,
    page:summary(delays.page),history:summary(delays.history),send:summary(delays.send),custody:summary(delays.custody),
    loopLag:summary(lag),peakRssBytes:peak.rss,peakHeapBytes:peak.heap,swapBytes:swap,
    cpuUserMs:cpu.user/1000,cpuSystemMs:cpu.system/1000,duplicateAccepted:true,catalogueSize:fixture.catalogueSize,
    historySource:'synthetic provider page',sendScope:'direct owner acceptance of the prepared fixture body; excludes queue/preparation wait',custodyScope:'raw command retention only',custodyDelivery}));
  projector.kill('SIGTERM');
  await pause(30); // flush the result; the owner monitor's interval otherwise keeps this fixture alive
  process.exit(0);
}

async function main(){
  const catalogueSize=Number(process.argv.find(value=>value.startsWith('--sessions='))?.split('=')[1]??1000);
  if(!Number.isSafeInteger(catalogueSize)||catalogueSize<20||catalogueSize>10_000)throw new Error('Use --sessions=20..10000');
  const root=await mkdtemp(join(tmpdir(),"concierge-loaded-"));
  const environment={...process.env,CONCIERGE_STATE_DIR:root,CONCIERGE_CAPTURE_STATE_DIR:join(root,"capture"),
    CONCIERGE_TEST_MODE:"1",CONCIERGE_TEST_AUTHORIZATION:AUTH};
  const hostScript=join(base,"bot/scripts/execution-host.ts");
  const provider=join(root,"synthetic-provider.ts");
  await writeFile(provider,`import {existsSync} from 'node:fs';
const [gate,session]=process.argv.slice(2);
const frame=(index:number)=>JSON.stringify({type:'assistant',session_id:session,message:{model:'synthetic',content:[{type:'text',text:'x'.repeat(3900)+index}]}})+'\\n';
for(let i=0;i<2000;i++)process.stdout.write(frame(i));
while(!existsSync(gate))await Bun.sleep(20);
for(let i=2000;i<2450;i++){process.stdout.write(frame(i));await Bun.sleep(20);}
process.stdout.write(JSON.stringify({type:'result',session_id:session,result:'complete',is_error:false})+'\\n');`);
  const ids=Array.from({length:6},(_,index)=>`loaded-${index}`);
  const directories=ids.map(id=>join(root,"exec",id));
  const gates=directories.map(directory=>join(directory,"continue"));
  const hosts=[] as ReturnType<typeof spawn>[];
  const coordinators=[] as ReturnType<typeof spawn>[];
  const coordinatorMemory=new Map<number,{pid:number;peakRssBytes:number;peakSwapBytes:number}>();
  const sampleCoordinator=async(child:ReturnType<typeof spawn>)=>{
   if(!child.pid)return;const status=await readFile(`/proc/${child.pid}/status`,'utf8').catch(()=>'');if(!status)return;
   const old=coordinatorMemory.get(child.pid);
   coordinatorMemory.set(child.pid,{pid:child.pid,peakRssBytes:Math.max(old?.peakRssBytes??0,Number(status.match(/^VmHWM:\s*(\d+)/m)?.[1]??0)*1024),
    peakSwapBytes:Math.max(old?.peakSwapBytes??0,Number(status.match(/^VmSwap:\s*(\d+)/m)?.[1]??0)*1024)});
  };
  const sampling=setInterval(()=>{for(const child of coordinators)void sampleCoordinator(child);},200);
  try {
    for(let index=0;index<ids.length;index++){
      const directory=directories[index]!;await mkdir(directory,{recursive:true,mode:0o700});
      await writeFile(join(directory,"manifest.json"),JSON.stringify({version:1,executionId:ids[index],
        executable:process.execPath,args:[provider,gates[index],`fixture-${index}`],cwd:root,
        environment:{PATH:process.env.PATH||"/usr/bin"},initialInput:"fixture"}),{mode:0o600});
      hosts.push(spawn(process.execPath,["run",hostScript,directory],{stdio:"ignore",env:environment}));
    }
    const readyBy=Date.now()+30_000;
    while(Date.now()<readyBy){
      const sizes=await Promise.all(directories.map(directory=>stat(join(directory,"journal")).then(file=>file.size).catch(()=>0)));
      if(sizes.every(size=>size>=8_000_000))break;
      await pause(50);
    }
    const journals=await Promise.all(directories.map(directory=>stat(join(directory,"journal")).then(file=>file.size)));
    if(journals.some(size=>size<8_000_000))throw new Error(`Journals did not reach 8 MB: ${journals}`);
    const configPath=join(root,"fixture.json");
    await writeFile(configPath,JSON.stringify({root,ids,directories,gates,catalogueSize} satisfies Fixture));
    const first=spawn(process.execPath,["run",import.meta.path,"--probe","pre",configPath],{env:environment,stdio:["ignore","pipe","pipe"]});
    let firstOutput="";first.stdout.on("data",chunk=>{firstOutput+=chunk.toString();});
    const attachedBy=Date.now()+20_000;
    while(!firstOutput.includes('"kind":"pre_attached"')&&Date.now()<attachedBy&&first.exitCode===null)await pause(25);
    if(!firstOutput.includes('"kind":"pre_attached"'))throw new Error("Predecessor did not attach all hosts");
    first.kill("SIGKILL");await new Promise(resolve=>first.once("exit",resolve));
    let output="",errors="";
    let currentUrl='';
    const externalBrowser=!!process.env.THINKERING_ACCEPTANCE_REPO;
    const startMeasured=()=>{
     const child=spawn(process.execPath,["run",import.meta.path,"--probe","measure",configPath],{
      env:{...environment,...(externalBrowser?{CONCIERGE_ACCEPTANCE_EXTERNAL_BROWSER:'1'}:{})},stdio:["ignore","pipe","pipe"]});
     coordinators.push(child);let localOutput='',partial='',readyRow:any=null;
     child.stdout.on('data',chunk=>{const value=chunk.toString();output+=value;localOutput=(localOutput+value).slice(-1000);
      const lines=(partial+value).split('\n');partial=lines.pop()??'';
      for(const line of lines){try{const row=JSON.parse(line);if(row.kind==='owner_ready')readyRow=row;}catch{/* Structured output may share a stream with diagnostics. */}}
     });
     child.stderr.on('data',chunk=>{errors+=chunk.toString();});
     const ready=async()=>{
      const deadline=Date.now()+30_000;
      while(Date.now()<deadline){
       const row=readyRow;
       if(row){currentUrl=`http://127.0.0.1:${row.port}`;return row;}
       if(child.exitCode!==null||child.signalCode!==null)throw new Error(`Owner exited before readiness: ${errors.slice(-4000)} ${localOutput.slice(-1000)}`);
       await pause(20);
      }
      throw new Error('Owner readiness timed out');
     };
     return {child,ready};
    };
    let measured=startMeasured();let browser:any=null,restart:any=null;
    if(externalBrowser){
     const initial=await measured.ready();
     // Capture ingress and the web adapter outlive the coordinator, just as their
     // separately supervised production owners do. Only scratch paths enter this process.
     Object.assign(process.env,environment);
     const {startBrowserBoundary}=await import('./responsive-browser-boundary');
     const boundary=startBrowserBoundary({handle:async request=>{
      const url=new URL(request.url);return fetch(currentUrl+url.pathname+url.search,{method:request.method,
       headers:request.headers,...(request.method==='POST'?{body:await request.text()}:{}),signal:request.signal});
     }},initial.sessionId,process.env.THINKERING_ACCEPTANCE_REPO!,{
      startLoad:async()=>{await fetch(currentUrl+'/fixture/start',{method:'POST'});},
      restartOwner:async()=>{
       const prior=measured.child,priorPid=prior.pid;
       await sampleCoordinator(prior);
       const journalBytesAtKill=await Promise.all(directories.map(directory=>stat(join(directory,'journal')).then(file=>file.size)));
       if(!journalBytesAtKill.some((size,index)=>size>journals[index]!))throw new Error('No live host output preceded the restart');
       const gone=new Promise(resolve=>prior.once('exit',resolve));prior.kill('SIGKILL');await gone;
       measured=startMeasured();const resumed=await measured.ready();
       await fetch(currentUrl+'/fixture/start',{method:'POST'});
       if(resumed.pid===priorPid||resumed.sessionId!==initial.sessionId)throw new Error('Coordinator restart did not preserve session identity');
       restart={beforePid:priorPid,afterPid:resumed.pid,sessionId:resumed.sessionId,signal:'SIGKILL',journalBytesAtKill};
       return restart;
      },
     });
     browser=await boundary.finished;
     await fetch(currentUrl+'/fixture/finish',{method:'POST'});
    }
    const exit=await new Promise<number|null>((resolve,reject)=>{
      if(measured.child.exitCode!==null){resolve(measured.child.exitCode);return;}
      const timer=setTimeout(()=>{measured.child.kill("SIGKILL");reject(new Error(`Loaded coordinator timed out: ${output.slice(-2200)} ${errors.slice(-1000)}`));},60_000);
      measured.child.once("exit",code=>{clearTimeout(timer);resolve(code);});
    });
    if(exit!==0)throw new Error(`Loaded coordinator exited ${exit}: ${errors.slice(-6000)}\n${output.slice(-3000)}`);
    const observed=output.split("\n").filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return null;}});
    const result=observed.find(row=>row?.kind==="result");
    if(!result)throw new Error(`No measured result: ${output.slice(-1500)}`);
    const routeWork=Object.fromEntries([...new Set(observed.filter(row=>row?.event==="owner_request_completed").map(row=>row.route))]
      .map(route=>{const rows=observed.filter(row=>row?.event==="owner_request_completed"&&row.route===route);
        return [route,{durationMs:summary(rows.map(row=>row.duration_ms)),dbCalls:summary(rows.map(row=>row.db_calls)),
          maxReturnedRows:Math.max(...rows.map(row=>row.db_rows)),maxResultValueBytes:Math.max(...rows.map(row=>row.db_result_bytes))}];}));
    const finalJournals=await Promise.all(directories.map(directory=>stat(join(directory,"journal")).then(file=>file.size)));
    if(restart&&!finalJournals.some((size,index)=>size>restart.journalBytesAtKill[index]))throw new Error('Host output did not continue after loaded restart');
    const hostRssAtEnd=await Promise.all(hosts.map(async host=>{
      const status=await readFile(`/proc/${host.pid}/status`,"utf8").catch(()=>"");
      return Number(status.match(/^VmRSS:\s*(\d+)/m)?.[1]||0)*1024;
    }));
    const report={...result,coordinatorMemory:[...coordinatorMemory.values()],timingScope:restart?'replacement coordinator, with route work from both processes':'single measured coordinator',browser,browserClosureTested:!!browser,restartWhileBrowserClosed:restart,predecessorPid:JSON.parse(firstOutput.trim()).pid,hostPids:hosts.map(host=>host.pid),
      initialJournalBytes:journals,finalJournalBytes:finalJournals,
      liveBytes:finalJournals.reduce((sum,size,index)=>sum+size-journals[index]!,0),hostRssAtEnd,
      routeWork,queueAgeMs:null,providerObservationMs:browser?.providerObservation?.observedMs??null,browserPaintMs:browser?.paintMs??null,isolatedState:true};
    console.log(JSON.stringify(report));
  } finally {
    clearInterval(sampling);
    await Promise.all(coordinators.map(child=>new Promise<void>(resolve=>{
     if(child.exitCode!==null||child.signalCode!==null){resolve();return;}
     child.once('exit',()=>resolve());child.kill('SIGKILL');
    })));
    // Hosts own separate provider process groups. Let their shutdown handler end those
    // first; killing only the host would leave a waiting synthetic provider behind.
    await Promise.all(hosts.map(host=>new Promise<void>(resolve=>{
      if(host.exitCode!==null||host.signalCode!==null){resolve();return;}
      const force=setTimeout(()=>host.kill('SIGKILL'),3_000);
      host.once('exit',()=>{clearTimeout(force);resolve();});host.kill('SIGTERM');
    })));
    await rm(root,{recursive:true,force:true});
  }
}

if(process.argv[2]==="--probe")await probe(process.argv[3] as "pre"|"measure",process.argv[4]!);
else {await main();process.exit(0);}
