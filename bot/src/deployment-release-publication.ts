import { TrustedRootReleaseManager } from './deployment-release';

type OwnerFetch = (path:string, init:RequestInit)=>Promise<Response>;

/** Capability discovery is a read of the actual serving application, never of the selected
 * controller. Only the retained application's exact unsupported-route reply selects the
 * stopped lane. Transport failures, identity changes and other refusals remain failures. */
export async function releasePublicationMode(manager:TrustedRootReleaseManager, fetch:OwnerFetch) {
  const current=manager.currentArtifactPath();
  if(!current)throw new Error('Publication requires a verified current application.');
  const manifest=manager.verify(current);
  const ping=await fetch('/supervisor/ping',{method:'GET'});
  const serving=await ping.json() as {ok?:boolean;pid?:number;release?:string};
  if(!ping.ok||serving.ok!==true||!Number.isSafeInteger(serving.pid)||Number(serving.pid)<=0
    ||serving.release!==manifest.git_commit)
    throw new Error('Serving application identity does not match the verified current release.');
  const response=await fetch('/internal/deployment-release-capabilities',{method:'GET'});
  const capability=await response.json() as {publication?:number;pid?:number;release?:string;error?:string};
  const confirm=await fetch('/supervisor/ping',{method:'GET'});
  const confirmed=await confirm.json() as {ok?:boolean;pid?:number;release?:string};
  if(!confirm.ok||confirmed.ok!==true||confirmed.pid!==serving.pid||confirmed.release!==serving.release)
    throw new Error('Serving application changed during publication capability discovery.');
  if(response.ok&&capability.publication===1&&capability.pid===serving.pid&&capability.release===serving.release)
    return 'serialized' as const;
  if(response.status===404&&capability.error==='Unknown request API route.')return 'stopped' as const;
  throw new Error(`Serving application publication capability is unproven: ${JSON.stringify(capability)}`);
}
