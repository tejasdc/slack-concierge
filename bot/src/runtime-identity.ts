import { readFileSync } from "node:fs";
import { execFile,spawnSync } from "node:child_process";
import {promisify} from 'node:util';

export interface ProcessIdentity { pid: number; bootId: string; startTicks: string }
/** Capture ingress has one process-identity wire shape for every claiming worker. */
export function processIdentityPayload(owner:ProcessIdentity){
  return {pid:owner.pid,boot_id:owner.bootId,start_ticks:owner.startTicks};
}

const darwin = process.platform === "darwin";
let darwinBootId: string | null = null;

function command(executable: string, args: string[]): string {
  const result = spawnSync(executable, args, { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`${executable} ${args.join(" ")} failed with ${result.status}`);
  return result.stdout.trim();
}

export function readBootId(): string {
  if (!darwin) return readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
  // A per-boot UUID the kernel keeps until the next boot, the same fact Linux exposes.
  return darwinBootId ??= command("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]);
}

export function readProcessStartTicks(pid: number): string {
  if (darwin) {
    const started = command("/bin/ps", ["-o", "lstart=", "-p", String(pid)]);
    if (!started) throw new Error(`process ${pid} is not running`);
    return started;
  }
  const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
  const fieldsAfterCommand = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  return fieldsAfterCommand[19]; // field 22; this array begins at field 3
}

function parentPid(pid: number): number | null {
  if (darwin) {
    const parent = command("/bin/ps", ["-o", "ppid=", "-p", String(pid)]);
    return parent ? Number(parent) : null;
  }
  const status = readFileSync(`/proc/${pid}/status`, "utf-8");
  const parent = status.match(/^PPid:\s+(\d+)$/m)?.[1];
  return parent ? Number(parent) : null;
}

export function currentProcessIdentity(): ProcessIdentity {
  return processIdentity(process.pid);
}

export function processIdentity(pid: number): ProcessIdentity {
  return { pid, bootId: readBootId(), startTicks: readProcessStartTicks(pid) };
}

export function isAncestorProcess(candidatePid: number, childPid = process.pid): boolean {
  let pid = childPid;
  const visited = new Set<number>();
  while (pid > 1 && !visited.has(pid)) {
    if (pid === candidatePid) return true;
    visited.add(pid);
    try {
      const parent = parentPid(pid);
      if (!parent) return false;
      pid = parent;
    } catch {
      return false;
    }
  }
  return pid === candidatePid;
}

export function isProcessIdentityAlive(identity: ProcessIdentity): boolean {
  if (!identity.pid || !identity.bootId || !identity.startTicks) return false;
  if (identity.bootId !== readBootId()) return false;
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    // An unprivileged service gets EPERM for a live root-owned deploy process.
    // Existence is still proven by the matching, readable proc start time.
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  try {
    return readProcessStartTicks(identity.pid) === identity.startTicks;
  } catch {
    return false;
  }
}

const inspectNative=promisify(execFile);
const nativeExitInspection=`import json,os,select,sys
identities=json.loads(sys.argv[1])
boot=open('/proc/sys/kernel/random/boot_id').read().strip()
def ticks(pid):
 text=open('/proc/%d/stat'%pid).read()
 return text[text.rfind(')')+2:].split()[19]
def ended(identity):
 pid=identity['pid']; expected=identity['startTicks']
 if not isinstance(pid,int) or pid<=0 or not expected or not identity['bootId']: raise ValueError('exact native identity required')
 if identity['bootId']!=boot:return True
 try:
  if ticks(pid)!=expected:return True
  descriptor=os.pidfd_open(pid,0)
 except (FileNotFoundError,ProcessLookupError):return True
 try:
  try:
   if ticks(pid)!=expected:return True
  except (FileNotFoundError,ProcessLookupError):return True
  poller=select.poll();poller.register(descriptor,select.POLLIN)
  return any(events&select.POLLIN for _,events in poller.poll(0))
 finally:os.close(descriptor)
print(json.dumps(all(ended(identity) for identity in identities)))
`;

/** pidfd_open(flags=0) becomes readable after the last thread exits. Bind that
 * kernel witness to boot/start identity around open, rather than treating a
 * zombie leader or one task-directory snapshot as completed native cleanup. */
export async function processNativeLifetimesEnded(identities:ProcessIdentity[]):Promise<boolean>{
 if(!identities.length)return true;
 if(process.platform!=='linux')throw Error('Native release lifetime inspection requires Linux pidfd support.');
 const {stdout}=await inspectNative('/usr/bin/python3',['-I','-S','-c',nativeExitInspection,JSON.stringify(identities)]);
 const result=JSON.parse(stdout.trim());
 if(typeof result!=='boolean')throw Error('Native lifetime inspection returned no kernel proof.');
 return result;
}
export function processNativeLifetimeEnded(identity:ProcessIdentity):Promise<boolean>{return processNativeLifetimesEnded([identity]);}
