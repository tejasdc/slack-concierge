import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import type { Readable } from "node:stream";
import { jsonLines } from "./json-lines";
import type { ProcessIdentity } from "./runtime-identity";
import { fstatSync, readSync } from "node:fs";

// This process becomes the provider via exec: PID, boot and start identity are
// captured while it owns its /proc entry, before a fast provider can be reaped.
// CLOEXEC closes the one-use identity pipe at exec; an exec failure can still be
// reported on that pipe without giving the actual provider a control descriptor.
const IDENTITY_EXEC = (utilityRuntime: boolean) => `import json,os,sys
fd=3
os.set_inheritable(fd,False)
try:
 stat=open('/proc/self/stat',encoding='utf-8').read()
 identity={'pid':os.getpid(),'bootId':open('/proc/sys/kernel/random/boot_id',encoding='utf-8').read().strip(),'startTicks':stat.rsplit(') ',1)[1].split()[19]}
 os.write(fd,(json.dumps({'identity':identity})+'\\n').encode())
 ${utilityRuntime ? "os.set_inheritable(4,True);os.execve(4,sys.argv[1:],os.environ)" : "os.execvpe(sys.argv[1],sys.argv[1:],os.environ)"}
except BaseException as error:
 os.write(fd,(json.dumps({'error':str(error)})+'\\n').encode())
 raise
`;

// This finite guardian is itself the detached group leader. Only it signals the
// group, using its own current membership rather than a remembered numeric PGID.
// Its control/status descriptors are never inherited by the provider.
const GUARDIAN = (utilityRuntime: boolean) => `
const {spawn}=require('node:child_process');
const {writeSync,closeSync}=require('node:fs');
const stop=()=>process.kill(0,'SIGKILL');
const report=value=>{try{writeSync(3,JSON.stringify(value)+'\\n');}catch{stop();}};
process.on('SIGTERM',()=>{});
let exited=false;
const child=spawn('/usr/bin/python3',['-I','-S','-c',${JSON.stringify(IDENTITY_EXEC(utilityRuntime))},...process.argv.slice(1)],{stdio:['ignore',1,2,'pipe'${utilityRuntime ? ",4" : ""}]});
const identityRead=(async()=>{
 let bytes='';for await(const chunk of child.stdio[3])bytes+=String(chunk);
 const records=bytes.trim().split('\\n').filter(Boolean).map(line=>JSON.parse(line));
 const error=records.find(record=>typeof record.error==='string');
 if(error){report(error);return false;}
 const identity=records[0]?.identity;
 if(records.length!==1||!identity||identity.pid!==child.pid)throw Error('Provider did not retain its launch identity.');
 report({identity});
 return true;
})();
identityRead.catch(error=>report({error:String(error)}));
child.once('error',error=>{exited=true;report({error:String(error)});});
child.once('exit',(code,signal)=>{exited=true;identityRead.then(started=>{if(started)report({code,signal});},()=>{});});
// The provider alone owns the output descriptors from now on. Its closed stdio
// must not wait for logical bookkeeping or for this guardian's later release.
closeSync(1);closeSync(2);
process.stdin.on('data',chunk=>{
 for(const byte of chunk){
  if(byte===84)process.kill(0,'SIGTERM');
  else if(byte===75)stop();
  else if(byte===82&&exited)process.exit(0);
  else stop();
 }
});
process.stdin.on('end',stop);
process.stdin.on('error',stop);
process.stdin.resume();
`;

// This descriptor belongs to this child after its explicit stdio mapping. No
// process lookup is involved, even if the original executable was unlinked.
const GUARDIAN_FD_EXEC = `import os,sys
os.set_inheritable(4,True)
os.execve(4,['bun','-e',sys.argv[1],*sys.argv[2:]],os.environ)
`;

/** Finite custody for repair and release-check children; no socket, service or rediscovery. */
export function spawnOwnedProcessGroup(command: string[], options: Pick<SpawnOptions, "cwd" | "env"> & { utilityRuntimeFd?: number },
  fail: (error: unknown) => void) {
  const { utilityRuntimeFd, ...spawnOptions } = options;
  if (utilityRuntimeFd !== undefined) {
    const magic = Buffer.alloc(4);
    if (!Number.isSafeInteger(utilityRuntimeFd) || utilityRuntimeFd < 3 || !fstatSync(utilityRuntimeFd).isFile()
      || readSync(utilityRuntimeFd, magic, 0, 4, 0) !== 4 || !magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
      throw new Error("Owned utility runtime requires a retained ELF file descriptor.");
  }
  // The waiting launcher retains any release-lifetime lock. No inherited marker
  // may attest that our new private fd3 is that original open description.
  const environment = { ...(options.env ?? process.env) };
  delete environment.CONCIERGE_RELEASE_LIFETIME_FD;
  delete environment.CONCIERGE_RELEASE_LIFETIME_GENERATION;
  const guardian = utilityRuntimeFd === undefined
    ? spawn(process.execPath, ["-e", GUARDIAN(false), ...command], {
      ...spawnOptions, env: environment, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"],
    })
    : spawn("/usr/bin/python3", ["-I", "-S", "-c", GUARDIAN_FD_EXEC, GUARDIAN(true), ...command], {
      ...spawnOptions, env: environment, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe", utilityRuntimeFd],
    });
  const control = guardian.stdin!;
  let disposing = false;
  let stopping = false;
  let ended = false;
  let authorityClosed = false;
  let started = false;
  let nativeExited = false;
  let resolveIdentity!: (identity: ProcessIdentity | null) => void;
  let resolveExit!: (code: number) => void;
  let resolveGuardian!: () => void;
  let resolveOutcome!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const identity = new Promise<ProcessIdentity | null>(resolve => { resolveIdentity = resolve; });
  const pid = identity.then(value => value?.pid ?? null);
  const exited = new Promise<number>(resolve => { resolveExit = resolve; });
  const closed = new Promise<void>(resolve => { resolveGuardian = resolve; });
  const outcome = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { resolveOutcome = resolve; });
  guardian.once("exit", (code, signal) => resolveOutcome({ code, signal }));
  guardian.once("error", fail);
  control.on("error", error => { if (!disposing && !ended) fail(error); });
  guardian.once("close", () => {
    ended = true;
    if (!disposing && !stopping) fail(new Error("Owned process-group guardian exited before release."));
    resolveIdentity(null);
    resolveExit(1);
    resolveGuardian();
  });
  const status = (async () => {
    try {
      for await (const line of jsonLines(guardian.stdio[3] as Readable)) {
        const event = JSON.parse(line);
        if (event.identity && Number.isSafeInteger(event.identity.pid) && event.identity.pid > 0
          && typeof event.identity.bootId === "string" && /^[0-9a-f-]{36}$/i.test(event.identity.bootId)
          && typeof event.identity.startTicks === "string" && /^\d+$/.test(event.identity.startTicks) && !started) {
          started = true;
          resolveIdentity(event.identity);
        } else if ((Number.isInteger(event.code) || (event.code === null && typeof event.signal === "string")) && started && !nativeExited) {
          nativeExited = true;
          resolveOutcome({ code: event.code, signal: event.signal });
          resolveExit(event.code ?? 1);
        } else if (typeof event.error === "string") {
          fail(new Error(event.error));
          resolveIdentity(null);
          resolveExit(1);
          resolveOutcome({ code: 1, signal: null });
        } else throw new Error("Invalid owned process-group status.");
      }
    } catch (error) { fail(error); }
    finally {
      authorityClosed = true;
      if (!disposing && !stopping) fail(new Error("Owned process-group control authority closed before release."));
      resolveIdentity(null);
      resolveExit(1);
    }
  })();
  const send = (byte: string) => {
    if (!authorityClosed && !ended && !control.destroyed) control.write(byte);
  };
  return {
    pid, identity, exited, outcome, closed, groupPid: guardian.pid,
    stdout: guardian.stdout!, stderr: guardian.stderr!,
    signal(name: "SIGTERM" | "SIGKILL") { if (name === "SIGKILL") stopping = true; send(name === "SIGTERM" ? "T" : "K"); },
    async dispose(failed: boolean) {
      disposing = true;
      send(failed ? "K" : "R");
      await closed;
      await status;
    },
  };
}
