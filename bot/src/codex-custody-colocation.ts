import {readFileSync,statSync} from 'node:fs';
import type {CodexAppServerClientLike} from './codex-app-server-client';

type Endpoint=Omit<NonNullable<CodexAppServerClientLike['nativeEndpoint']>,'serverInfo'>|undefined;
const namespaceNames=['mnt','pid','user','cgroup'] as const;
type ProcessIdentity={pid:number;startTicks:string;bootId:string;namespaces:Record<typeof namespaceNames[number],string>};

function assertLocalProcess(identity:ProcessIdentity) {
  if(process.platform!=='linux'||!Number.isSafeInteger(identity.pid)||identity.pid<=0)
    throw new Error('Custody relay requires a locally observable Linux process incarnation.');
  const boot=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
  const start=()=>{
    const value=readFileSync(`/proc/${identity.pid}/stat`,'utf8');
    const fields=value.slice(value.lastIndexOf(')')+2).trim().split(/\s+/);
    if(fields[0]==='Z'||fields[0]==='X')throw new Error('Custody relay process has exited.');
    return fields[19];
  };
  if(identity.bootId!==boot||!/^\d+$/.test(identity.startTicks)||start()!==identity.startTicks)
    throw new Error('Custody relay process incarnation is not observable on this host.');
  for(const name of namespaceNames){
    const native=statSync(`/proc/${identity.pid}/ns/${name}`),owner=statSync(`/proc/self/ns/${name}`);
    const key=`${native.dev}:${native.ino}`;
    if(identity.namespaces?.[name]!==key||key!==`${owner.dev}:${owner.ino}`)
      throw new Error(`Custody relay ${name} namespace is not the owner's observation namespace.`);
  }
  if(start()!==identity.startTicks)throw new Error('Custody relay process changed during association validation.');
}

/** Only an actual pair receipt makes a relay locally observable. Listener scans and
 * independent runner-machine answers cannot supply this association. */
export function assertCustodyEndpoint(endpoint:Endpoint,requireProtected=true) {
  if(!endpoint?.relayRunner)return;
  const association=endpoint.relayAssociation;
  if(!association||association.version!==1||association.runner!==endpoint.relayRunner
    ||!association.pairId||!association.challenge||requireProtected&&!association.protected
    ||!association.nativePeer.socketPath.startsWith('/')
    ||!/^([a-f0-9]{64})$/.test(association.runnerIdentity.implementationSha256)
    ||!/^([a-f0-9]{64})$/.test(association.runnerIdentity.helperSha256)
    ||association.runnerIdentity.helperSha256!==association.preparation.helperSha256
    ||association.runnerIdentity.botDir!==association.preparation.machine.botDir
    ||association.preparation.machine.runnerName!==association.runner
    ||association.preparation.connectionFile!==`${association.preparation.machine.stateDir}/connection.env`)
    throw new Error('Custody relay has no supported exact-pair protected native association.');
  assertLocalProcess(association.runnerIdentity);
  assertLocalProcess(association.nativePeer);
}

/** Undefined means the configured Codex fallback; null deliberately selects local.
 * Neither an explicit binding nor that distinction may be erased for recovery. */
export function assertCustodyRunnerBinding(retained:string|null|undefined,endpoint:Endpoint) {
  const selected=retained===undefined?process.env.CONCIERGE_CODEX_RUNNER?.trim()||null:retained;
  if((endpoint?.relayRunner??null)!==selected)
    throw new Error('The retained Codex runner binding differs from the protected native association.');
  assertCustodyEndpoint(endpoint);
}

export function custodyProcessEndpoint(endpoint:Endpoint):{socketPath:string;nativePid?:number} {
  assertCustodyEndpoint(endpoint);
  if(!endpoint)throw new Error('Current process effects have no supported local native endpoint.');
  return endpoint.relayAssociation
    ?{socketPath:endpoint.relayAssociation.nativePeer.socketPath,nativePid:endpoint.relayAssociation.nativePeer.pid}
    :{socketPath:endpoint.socketPath};
}
