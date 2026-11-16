// A pair-owned native socket. The duplicated descriptor below is the connected WebSocket's
// socket, never another connection to its pathname. Node exposes that descriptor; Bun's public
// WebSocket API does not. No daemon management or provider request occurs in this helper.
import {createConnection} from 'node:net';
import {spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import WebSocket from 'ws-node';
export function runRunnerNativeBridge(socketPath) {
const loadedFiles=[...new Set([process.argv[1],fileURLToPath(import.meta.url)])];
const implementationHash=createHash('sha256');
for(const path of loadedFiles)implementationHash.update(readFileSync(path)).update('\0');
const implementationSha256=implementationHash.digest('hex');
const write=value=>process.stdout.write(`${JSON.stringify(value)}\n`);
let ended=false;
const end=error=>{if(ended)return;ended=true;write({type:'disconnect',error:String(error)});socket.terminate();input.close();};
const socket=new WebSocket('ws://localhost/',{createConnection:()=>createConnection(socketPath),perMessageDeflate:false});
const input=createInterface({input:process.stdin});
socket.on('open',()=>{
  try {
    const fd=socket._socket?._handle?.fd;
    if(!Number.isSafeInteger(fd)||fd<0)throw new Error('connected native socket descriptor unavailable');
    // getsockopt on an inherited duplicate of the SAME open socket description.
    const probe=spawnSync('python3',['-c',`import socket,struct,json,os
s=socket.socket(fileno=3)
pid,uid,gid=struct.unpack('3i',s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
stat=open('/proc/%d/stat'%pid).read()
ns={k:'%d:%d'%(os.stat('/proc/%d/ns/%s'%(pid,k)).st_dev,os.stat('/proc/%d/ns/%s'%(pid,k)).st_ino) for k in ['mnt','pid','user','cgroup']}
print(json.dumps(dict(pid=pid,uid=uid,gid=gid,startTicks=stat[stat.rfind(')')+2:].split()[19],bootId=open('/proc/sys/kernel/random/boot_id').read().strip(),namespaces=ns)))`],{stdio:['ignore','pipe','pipe',fd],encoding:'utf8'});
    if(probe.status!==0)throw new Error(`native peer credentials unavailable: ${probe.stderr}`);
    write({type:'native-peer',implementationSha256,peer:{...JSON.parse(probe.stdout),socketPath}});
  }catch(error){end(error);}
});
socket.on('message',(data,binary)=>write({type:'data',data:data.toString('base64'),binary}));
socket.on('error',end);
socket.on('close',()=>{end('native socket closed');process.exit(0);});
input.on('line',line=>{try{const frame=JSON.parse(line);if(frame.type==='close'){socket.close();return;}if(frame.type==='data'&&socket.readyState===WebSocket.OPEN)socket.send(Buffer.from(frame.data,'base64'),{binary:frame.binary});}catch(error){end(error);}});
input.on('close',()=>socket.terminate());
process.on('SIGTERM',()=>{socket.terminate();process.exit(0);});
}
