import {ownerGetPolicy} from './owner-get-policy';

/** GET labels are the reader contract, never a second list of its static words. */
const mutationPaths=[
 '/sessions','/sessions/:id/inputs','/sessions/:id/stop','/sessions/:id/actions',
 '/sessions/:id/actions/:id/cancel','/sessions/:id/outage-choice','/sessions/:id/message-actions','/sessions/:id/input','/sessions/:id/title',
 '/sessions/:id/forks','/sessions/:id/comparisons','/sessions/:id/tasks',
 '/sessions/:id/captures','/sessions/:id/reconcile','/sessions/:id/bind','/sessions/:id/asides',
 '/inbox','/inbox/topics','/inbox/topics/:id/actions','/operations/:id/cancel',
 '/search','/context','/imports','/sources/refresh',
 '/attachments','/attachments/:id/transcription','/attachments/:id/transcription/start',
 '/auth/refresh','/auth/refresh/complete','/auth/profiles/save','/auth/profiles/switch','/auth/reset-credit/use','/auth/usage/retry',
 '/requests','/requests/:id/replies','/requests/:id/cancel',
 '/saved-work/settings','/saved-work/:id/start','/saved-work/:id/time','/saved-work/:id/schedule','/saved-work/:id/drop',
 '/projects/new','/projects/share','/projects/cancel','/projects/canvas-policy','/projects/:id/default','/projects/:id/todos','/canvas-projects/ensure',
 '/consultations','/resurrections','/resurrections/native',
 '/peers/requests','/peers/requests/corrected-attachment','/peers/requests/:id/replies','/peers/requests/:id/notify','/peers/requests/:id/cancel',
 '/peers/operations','/peers/operations/:id/outcome','/peers/links','/peers/lab','/peers/project-notices',
 '/handoffs','/handoffs/:id/accept','/handoffs/:id/withdraw','/agent-report','/focus-hold','/focus-hold/release',
 '/pause-all','/pause-all/resume','/pause-all/peer','/inbox/queue-actions','/inbox/areas','/inbox/areas/:id/actions',
 '/journal/observations','/canvas-observations','/sessions/:id/canvas-observations','/sessions/:id/feature-requests','/mac-browser-fallback',
] as const;

export function ownerRequestLabel(method:string,path:string):string{
 if(method==='GET'){
  const policy=ownerGetPolicy(method,path);
  if(policy)return policy.kind==='presentation'?policy.contract.route.replace(/:[A-Za-z]+/g,':id'):`GET /sessions/v1${policy.path}`;
 }
 if(method==='POST'){
  const actual=path.slice('/sessions/v1'.length).split('/');
  const pattern=mutationPaths.find(pattern=>{const parts=pattern.split('/');return parts.length===actual.length&&parts.every((part,i)=>part===':id'?Boolean(actual[i]):part===actual[i]);});
  if(pattern)return `POST /sessions/v1${pattern}`;
 }
 // A future/invalid path cannot turn a private project name or token into a log label.
 return `${['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD'].includes(method)?method:'OTHER'} /sessions/v1/:unknown`;
}
