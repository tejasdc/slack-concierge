import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {onJsonLines,jsonLine} from './json-lines';
import {rewriteRelayedCodexRequest,runnerMachineEnvironment,type RunnerMachine} from './runner-machine';

export type CodexRelayProcessIdentity={pid:number;startTicks:string;bootId:string;namespaces:Record<'mnt'|'pid'|'user'|'cgroup',string>};
export type CodexRelayRunnerIdentity=CodexRelayProcessIdentity&{implementationSha256:string;helperSha256:string;nativeTransportSha256:string;botDir:string};
export type CodexRelayAssociation={version:1;pairId:string;challenge:string;runner:string;protected:boolean;
  runnerIdentity:CodexRelayRunnerIdentity;nativePeer:CodexRelayProcessIdentity&{uid:number;gid:number;socketPath:string};
  preparation:{machine:RunnerMachine;environment:Record<string,string>;connectionFile:string;helperSha256:string}};

function digest(paths:string[]){const hash=createHash('sha256');for(const path of paths)hash.update(path).update('\0').update(readFileSync(path));return hash.digest('hex');}
function nativeBridgeFiles(machine:RunnerMachine):string[] {
  // A hybrid's runner uses its CONTROL bridge. An independently older application bridge
  // must not replace the runner helper selected by this loaded control implementation.
  return existsSync(join(machine.botDir,'scripts/runner.js'))
    ?[join(machine.botDir,'..','codex-app-server-bridge.mjs')]
    :[join(machine.botDir,'src/codex-app-server-bridge.mjs'),join(machine.botDir,'src/runner-codex-native-bridge.mjs')];
}
function nativeBridgeDigest(machine:RunnerMachine){const hash=createHash('sha256');for(const path of nativeBridgeFiles(machine))hash.update(readFileSync(path)).update('\0');return hash.digest('hex');}
function runnerHelperDigest(machine:RunnerMachine) {
  const helper=(name:string)=>{const js=join(machine.botDir,`scripts/${name}.js`);return existsSync(js)?js:join(machine.botDir,`scripts/${name}.ts`);};
  return digest([...nativeBridgeFiles(machine),helper('router-sessions'),helper('router-request-client')]);
}
export function loadedRunnerIdentity(machine:RunnerMachine):CodexRelayRunnerIdentity {
  const stat=readFileSync(`/proc/${process.pid}/stat`,'utf8');
  const bundled=join(machine.botDir,'scripts/runner.js');
  const implementation=existsSync(bundled)?[bundled]:[join(machine.botDir,'scripts/runner.ts'),join(machine.botDir,'src/runner-codex-relay.ts'),join(machine.botDir,'src/runner-machine.ts')];
  return Object.freeze({pid:process.pid,startTicks:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]!,
    bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),
    namespaces:Object.freeze(Object.fromEntries(['mnt','pid','user','cgroup'].map(key=>{const stat=statSync(`/proc/${process.pid}/ns/${key}`);return [key,`${stat.dev}:${stat.ino}`];}))) as CodexRelayProcessIdentity['namespaces'],
    botDir:machine.botDir,implementationSha256:digest(implementation),nativeTransportSha256:nativeBridgeDigest(machine),
    helperSha256:runnerHelperDigest(machine)});
}

/** One native helper belongs to one relay pair, including when its runner listen channel is replaced.
 * It never reconnects. Protected failures close the pair without starting or changing the daemon. */
export function serveCodexRelayPair(options:{id:string;challenge:string;protected:boolean;remote:WebSocket;socketPath:string;
  machine:RunnerMachine;identity:CodexRelayRunnerIdentity;nodeExecutable:string;pinThread:(threadId:string,required:boolean)=>void;
  onOrdinaryOpen:()=>void;onOrdinaryError:()=>void;onClosed?:(why:string)=>void}) {
  const {remote,machine,identity}=options;
  const child=spawn(options.nodeExecutable,[nativeBridgeFiles(machine)[0]!,options.socketPath,'--runner-native-pair'],{stdio:['pipe','pipe','pipe']});
  let ended=false,peer:CodexRelayAssociation['nativePeer']|null=null,announced=false,stderr='';
  const waiting:Array<{data:string;binary:boolean}>=[];
  const end=(why:string)=>{if(ended)return;ended=true;options.onClosed?.(why);try{remote.close(1011,why.slice(0,120));}catch{}child.kill('SIGKILL');};
  const announce=()=>{
    if(ended||announced||!peer||remote.readyState!==WebSocket.OPEN)return;
    announced=true;
    const association:CodexRelayAssociation={version:1,pairId:options.id,challenge:options.challenge,runner:machine.runnerName,protected:options.protected,
      runnerIdentity:identity,nativePeer:peer,preparation:{machine:{...machine},environment:runnerMachineEnvironment(machine),connectionFile:join(machine.stateDir,'connection.env'),helperSha256:identity.helperSha256}};
    remote.send(JSON.stringify({conciergeRelay:'association-v1',association}));
    for(const frame of waiting.splice(0))child.stdin.write(jsonLine({type:'data',...frame}));
  };
  remote.binaryType='arraybuffer';
  remote.onopen=announce;
  remote.onmessage=event=>{
    if(ended)return;
    try {
      const binary=typeof event.data!=='string',text=binary?new TextDecoder().decode(event.data):event.data;
      const rewritten=rewriteRelayedCodexRequest(text,machine);
      // Construction binds shell helpers; turn start installs the corresponding hook pin.
      // Observations and exact Stop do not depend on rereading helper files.
      const method=options.protected?JSON.parse(text)?.method:null;
      if(options.protected&&(method==='thread/start'||method==='turn/start')&&runnerHelperDigest(machine)!==identity.helperSha256)throw new Error('protected helper release changed');
      if(rewritten.pinThread)options.pinThread(rewritten.pinThread,options.protected);
      const frame={data:Buffer.from(rewritten.text).toString('base64'),binary};
      if(announced)child.stdin.write(jsonLine({type:'data',...frame}));else waiting.push(frame);
    }catch(error){end(`native preparation failed: ${String(error)}`);}
  };
  onJsonLines(child.stdout,line=>{
    try {
      const frame=JSON.parse(line);
      if(frame.type==='native-peer'){
        if(frame.implementationSha256!==identity.nativeTransportSha256)throw new Error('loaded native transport differs from runner identity');
        peer=frame.peer;
        if(!options.protected)options.onOrdinaryOpen();
        announce();
      }else if(frame.type==='data'){
        if(!announced)throw new Error('native data preceded association');
        const bytes=Buffer.from(frame.data,'base64');remote.send(frame.binary?bytes:bytes.toString('utf8'));
      }else if(frame.type==='disconnect'){
        if(!peer&&!options.protected)options.onOrdinaryError();
        end(String(frame.error));
      }
    }catch(error){end(String(error));}
  });
  child.stderr.on('data',data=>{stderr=(stderr+String(data)).slice(-2000);});
  child.stdin.on('error',error=>end(String(error)));
  child.on('error',error=>end(String(error)));
  child.on('exit',()=>end(`native transport exited${stderr?`: ${stderr}`:''}`));
  remote.onclose=()=>end('owner side closed');remote.onerror=()=>end('owner side failed');
  return {close:end,exited:new Promise<void>(resolve=>child.once('exit',()=>resolve()))};
}
