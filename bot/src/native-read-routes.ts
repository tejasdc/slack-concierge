import {OWNER_GET_EXCEPTIONS,ownerGetPolicy} from './owner-get-policy';
import {PRESENTATION_READERS} from './presentation-reader-contracts';

export type NativeReadRoute=Readonly<{
  domain:'read-worker'|'live-owner'|'stream-owner';
  source:'prepared'|'canonical'|'provider'|'filesystem'|'account'|'control';
  /** Canonical pathname after the same legacy alias resolution as SessionOwner.handle. */
  path:string;
  pattern:string;
  maxResponseBytes:number;
}>;

const liveOwner=new Set([
  '/status','/projects/:id/status','/peers','/peers/operations/:id',
  '/peers/requests/:id','/peers/requests/:id/replies/:id','/requests/:id',
]);
const provider=new Set(['/sessions/:id/history','/sessions/:id/history/messages/:id/detail',
  '/sessions/:id/details/:id','/sessions/:id/artifacts/:id']);
const filesystem=new Set(['/files','/projects/:id/instructions','/projects/:id/todos',
  '/attachments/:id','/attachments/:id/transcription','/inbox/:id']);
const account=new Set(['/auth/providers']);

function normalize(path:string):string {
  const alias=/^\/sessions\/v1\/inbox\/(topics(?:\/[^/]+)?|questions)$/.exec(path);
  return alias?`/sessions/v1/presentation/${alias[1]}`:path;
}

/** Pure, storage-free admission contract shared by the gateway and read executors. */
export function classifyNativeReadRoute(method:string,pathname:string):NativeReadRoute|null {
  if(method!=='GET')return null;
  const path=normalize(pathname);
  const policy=ownerGetPolicy(method,path);
  if(!policy)return null;
  if(policy.kind==='presentation')return {domain:'read-worker',source:'prepared',path,
    pattern:policy.contract.route.slice(4),maxResponseBytes:policy.maxResponseBytes};
  const suffix=path.slice('/sessions/v1'.length);
  const pattern=policy.path;
  if(pattern==='/events/stream')return {domain:'stream-owner',source:'control',path,pattern,maxResponseBytes:0};
  if(liveOwner.has(pattern))return {domain:'live-owner',source:'control',
    path,pattern,maxResponseBytes:policy.maxResponseBytes};
  if(account.has(pattern))return {domain:'read-worker',source:'account',path,pattern,maxResponseBytes:policy.maxResponseBytes};
  if(provider.has(pattern))return {domain:'read-worker',source:'provider',path,pattern,maxResponseBytes:policy.maxResponseBytes};
  if(filesystem.has(pattern))return {domain:'read-worker',source:'filesystem',path,pattern,maxResponseBytes:policy.maxResponseBytes};
  // Every remaining exact exception is a canonical or control read with no live
  // coordinator dependency. Unknown exceptions fail below when the policy changes.
  if(!independentCanonical.has(pattern))throw new Error(`Unclassified native read route ${suffix}`);
  return {domain:'read-worker',source:'canonical',path,pattern,maxResponseBytes:policy.maxResponseBytes};
}

const independentCanonical=new Set([
  '/events','/releases','/models','/usage/breakdown','/projects','/saved-work/settings',
  '/operations/:id','/runs/:id','/work-thread','/inbox','/sessions','/sessions/:id',
  '/sessions/:id/view',
]);

/** Fails the candidate if a new GET exception has no execution owner. */
export function assertNativeReadRouteCoverage():void {
  const classified=new Set([...liveOwner,...provider,...filesystem,...account,...independentCanonical,'/events/stream']);
  for(const route of OWNER_GET_EXCEPTIONS)if(!classified.has(route.path))throw new Error(`Unclassified native read route ${route.path}`);
  for(const route of classified)if(!OWNER_GET_EXCEPTIONS.some(entry=>entry.path===route))throw new Error(`Stale native read route ${route}`);
  for(const contract of Object.values(PRESENTATION_READERS)){
    const path=contract.route.slice(4).replace(/:[^/]+/g,'sample');
    const classifiedRoute=classifyNativeReadRoute('GET',path);
    if(classifiedRoute?.domain!=='read-worker'||classifiedRoute.source!=='prepared')throw new Error(`Unclassified prepared read ${contract.route}`);
  }
}
