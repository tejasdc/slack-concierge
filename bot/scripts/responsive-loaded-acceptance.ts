/** Loaded, isolated acceptance of execution-host adoption and owner responsiveness.
 * Usage: CONCIERGE_TEST_AUTHORIZATION=native-attribution-5eaa0768 bun run bot/scripts/responsive-loaded-acceptance.ts
 * All provider output and owner state are generated under /tmp; no user/provider effects. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const AUTH="native-attribution-5eaa0768";
if(process.env.CONCIERGE_TEST_AUTHORIZATION!==AUTH)throw new Error("Scoped native acceptance authorization required");
const base=resolve(import.meta.dir,"../..");
type Fixture={root:string;ids:string[];directories:string[];gates:string[]};
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
  const [{HostedClaudeCodeTransport},{ClaudeOutputAccumulator},{SessionOwner},{createNativeSession},{retainHumanCommand}]=await Promise.all([
    import("../src/execution-host-client"),import("../src/claude-code"),import("../src/session-owner"),import("../src/session-inputs"),
    import("../src/human-command-state")]);
  const session=createNativeSession("claude-code",{title:"Loaded acceptance",cwd:fixture.root,project:"slack-concierge"});
  const owner=new SessionOwner({wake:()=>{},steer:()=>false,stop:async()=>false,available:()=>true,
    history:async()=>({messages:[{id:"fixture-message",role:"assistant",content:"prepared",tool:null,phase:null}],nextCursor:null})},fixture.root);
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
  for(const gate of fixture.gates)await writeFile(gate,"continue");
  const baseUrl=`http://127.0.0.1/sessions/v1/sessions/concierge%3A${session.id}`;
  const read=async(kind:"page"|"history",url:string)=>{
    const start=performance.now();const response=await owner.handle(new Request(url));
    delays[kind].push(performance.now()-start);
    if(!response || response.status!==200)throw new Error(`${kind} returned ${response?.status}`);
    await response.text();
  };
  const send=async(actionId:string,text:string)=>{
    const start=performance.now();const response=await owner.handle(new Request(`${baseUrl}/inputs`,{method:"POST",
      headers:{"content-type":"application/json"},body:JSON.stringify({clientActionId:actionId,text,delivery:"queue"})}));
    delays.send.push(performance.now()-start);
    if(!response || ![200,202].includes(response.status))throw new Error(`send returned ${response?.status}`);
    return response.json() as Promise<any>;
  };
  const start=performance.now();
  let lastAction="";let accepted:any;
  for(let index=0;index<40;index++){
    await read("page",baseUrl);
    await read("history",`${baseUrl}/history?limit=20`);
    lastAction=`loaded-${index}`;
    const body={clientActionId:lastAction,text:`Synthetic input ${index}`,delivery:"queue"};
    const custodyStart=performance.now();
    const retained=retainHumanCommand({version:1,clientId:"loaded-client",sessionId:`concierge:${session.id}`,
      sequence:index+1,actionId:lastAction,door:"web",method:"POST",path:`/sessions/v1/sessions/concierge%3A${session.id}/inputs`,body});
    delays.custody.push(performance.now()-custodyStart);
    if(retained.status!=="pending")throw new Error("Human command custody was not retained");
    accepted=await send(lastAction,`Synthetic input ${index}`);
    if(index===19)await pause(250); // browser background/close gap; durable state stays server-side
    await pause(10);
  }
  console.log(JSON.stringify({kind:"stage",name:"interaction_done",count:40,ms:Math.round(performance.now()-start)}));
  const repeated=retainHumanCommand({version:1,clientId:"loaded-client",sessionId:`concierge:${session.id}`,
    sequence:40,actionId:lastAction,door:"web",method:"POST",
    path:`/sessions/v1/sessions/concierge%3A${session.id}/inputs`,
    body:{clientActionId:lastAction,text:"Synthetic input 39",delivery:"queue"}});
  if(repeated.action_id!==lastAction)throw new Error("Duplicate custody changed action identity");
  const duplicate=await send(lastAction,"Synthetic input 39");
  if(JSON.stringify(accepted)!==JSON.stringify(duplicate))throw new Error("Duplicate client action changed acceptance");
  await Promise.allSettled(pending);
  console.log(JSON.stringify({kind:"stage",name:"hosts_settled"}));
  clearInterval(tick);
  const cpu=process.cpuUsage();
  const status=await readFile("/proc/self/status","utf8").catch(()=>"");
  const swap=Number(status.match(/^VmSwap:\s*(\d+)/m)?.[1]||0)*1024;
  console.log(JSON.stringify({kind:"result",pid:process.pid,replayMs:Math.round(replayDone-adoptionStarted),
    interactionMs:Math.round(performance.now()-start),events,hostCount:fixture.ids.length,
    page:summary(delays.page),history:summary(delays.history),send:summary(delays.send),custody:summary(delays.custody),
    loopLag:summary(lag),peakRssBytes:peak.rss,peakHeapBytes:peak.heap,swapBytes:swap,
    cpuUserMs:cpu.user/1000,cpuSystemMs:cpu.system/1000,duplicateAccepted:true}));
  await pause(30); // flush the result; the owner monitor's interval otherwise keeps this fixture alive
  process.exit(0);
}

async function main(){
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
for(let i=2000;i<2400;i++)process.stdout.write(frame(i));
process.stdout.write(JSON.stringify({type:'result',session_id:session,result:'complete',is_error:false})+'\\n');`);
  const ids=Array.from({length:6},(_,index)=>`loaded-${index}`);
  const directories=ids.map(id=>join(root,"exec",id));
  const gates=directories.map(directory=>join(directory,"continue"));
  const hosts=[] as ReturnType<typeof spawn>[];
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
    await writeFile(configPath,JSON.stringify({root,ids,directories,gates} satisfies Fixture));
    const first=spawn(process.execPath,["run",import.meta.path,"--probe","pre",configPath],{env:environment,stdio:["ignore","pipe","pipe"]});
    let firstOutput="";first.stdout.on("data",chunk=>{firstOutput+=chunk.toString();});
    const attachedBy=Date.now()+20_000;
    while(!firstOutput.includes('"kind":"pre_attached"')&&Date.now()<attachedBy&&first.exitCode===null)await pause(25);
    if(!firstOutput.includes('"kind":"pre_attached"'))throw new Error("Predecessor did not attach all hosts");
    first.kill("SIGKILL");await new Promise(resolve=>first.once("exit",resolve));
    const measured=spawn(process.execPath,["run",import.meta.path,"--probe","measure",configPath],{env:environment,stdio:["ignore","pipe","pipe"]});
    let output="",errors="";
    measured.stdout.on("data",chunk=>{output+=chunk.toString();});
    measured.stderr.on("data",chunk=>{errors+=chunk.toString();});
    const exit=await new Promise<number|null>((resolve,reject)=>{
      const timer=setTimeout(()=>{measured.kill("SIGKILL");reject(new Error(`Loaded coordinator timed out: ${output.slice(-2200)} ${errors.slice(-1000)}`));},30_000);
      measured.once("exit",code=>{clearTimeout(timer);resolve(code);});
    });
    if(exit!==0)throw new Error(`Loaded coordinator exited ${exit}: ${errors.slice(-1500)}`);
    const observed=output.split("\n").filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return null;}});
    const result=observed.find(row=>row?.kind==="result");
    if(!result)throw new Error(`No measured result: ${output.slice(-1500)}`);
    const routeWork=Object.fromEntries([...new Set(observed.filter(row=>row?.event==="owner_request_completed").map(row=>row.route))]
      .map(route=>{const rows=observed.filter(row=>row?.event==="owner_request_completed"&&row.route===route);
        return [route,{durationMs:summary(rows.map(row=>row.duration_ms)),dbCalls:summary(rows.map(row=>row.db_calls)),
          maxReturnedRows:Math.max(...rows.map(row=>row.db_rows)),maxResultValueBytes:Math.max(...rows.map(row=>row.db_result_bytes))}];}));
    const finalJournals=await Promise.all(directories.map(directory=>stat(join(directory,"journal")).then(file=>file.size)));
    const hostRssAtEnd=await Promise.all(hosts.map(async host=>{
      const status=await readFile(`/proc/${host.pid}/status`,"utf8").catch(()=>"");
      return Number(status.match(/^VmRSS:\s*(\d+)/m)?.[1]||0)*1024;
    }));
    const report={...result,predecessorPid:JSON.parse(firstOutput.trim()).pid,hostPids:hosts.map(host=>host.pid),
      initialJournalBytes:journals,finalJournalBytes:finalJournals,
      liveBytes:finalJournals.reduce((sum,size,index)=>sum+size-journals[index]!,0),hostRssAtEnd,
      routeWork,queueAgeMs:null,providerObservationMs:null,browserPaintMs:null,isolatedState:true};
    console.log(JSON.stringify(report));
  } finally {
    for(const host of hosts)if(host.exitCode===null)host.kill("SIGKILL");
    await Promise.all(hosts.map(host=>host.exitCode===null?new Promise(resolve=>host.once("exit",resolve)):Promise.resolve()));
    await rm(root,{recursive:true,force:true});
  }
}

if(process.argv[2]==="--probe")await probe(process.argv[3] as "pre"|"measure",process.argv[4]!);
else await main();
