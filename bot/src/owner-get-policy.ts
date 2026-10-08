import {presentationContractFor} from './presentation-reader-contracts';

type Route=Readonly<{path:string;purpose:string;maxResponseBytes:number;kind:'control'|'legacy'}>;
const MiB=1024*1024;
/** Exact GET entrances outside the prepared presentation contract. No family prefix is admitted.
 * Legacy interactive routes are named debt, response-capped while callers move to prepared pages.
 * They are not a basis for adding another page: new interactive reads belong in PRESENTATION_READERS. */
export const OWNER_GET_EXCEPTIONS:readonly Route[]=[
 {path:'/events/stream',purpose:'event stream; no materialized response body',maxResponseBytes:0,kind:'control'},
 {path:'/events',purpose:'cursor-paged owner event transport',maxResponseBytes:2*MiB,kind:'control'},
 {path:'/status',purpose:'exact service health',maxResponseBytes:MiB,kind:'control'},
 {path:'/releases',purpose:'release-control history; migration to a page remains due',maxResponseBytes:2*MiB,kind:'legacy'},
 {path:'/auth/providers',purpose:'provider sign-in/control state',maxResponseBytes:MiB,kind:'control'},
 {path:'/models',purpose:'provider model choices',maxResponseBytes:MiB,kind:'control'},
 {path:'/usage/breakdown',purpose:'two bounded accounting periods',maxResponseBytes:MiB,kind:'control'},
 {path:'/projects',purpose:'registered project choices; finite owner catalogue',maxResponseBytes:2*MiB,kind:'control'},
 {path:'/projects/:id/status',purpose:'one project setup status',maxResponseBytes:MiB,kind:'control'},
 {path:'/projects/:id/instructions',purpose:'one exact project instructions file',maxResponseBytes:8*MiB,kind:'control'},
 {path:'/projects/:id/todos',purpose:'one exact project task file',maxResponseBytes:8*MiB,kind:'control'},
 {path:'/files',purpose:'one explicitly named workspace file; size still capped',maxResponseBytes:32*MiB,kind:'control'},
 {path:'/saved-work/settings',purpose:'one saved-work settings record',maxResponseBytes:MiB,kind:'control'},
 {path:'/attachments/:id',purpose:'one retained attachment; size still capped',maxResponseBytes:64*MiB,kind:'control'},
 {path:'/attachments/:id/transcription',purpose:'one attachment transcription status',maxResponseBytes:MiB,kind:'control'},
 {path:'/operations/:id',purpose:'one exact operation receipt',maxResponseBytes:2*MiB,kind:'control'},
 {path:'/runs/:id',purpose:'one exact run status',maxResponseBytes:MiB,kind:'control'},
 {path:'/requests/:id',purpose:'one exact addressed request and event set; needs paging',maxResponseBytes:8*MiB,kind:'legacy'},
 {path:'/peers',purpose:'configured peer inventory',maxResponseBytes:MiB,kind:'control'},
 {path:'/peers/operations/:id',purpose:'one exact peer project setup receipt',maxResponseBytes:MiB,kind:'control'},
 {path:'/peers/requests/:id',purpose:'one exact peer request status',maxResponseBytes:2*MiB,kind:'control'},
 {path:'/peers/requests/:id/replies/:id',purpose:'one exact peer reply including retained files',maxResponseBytes:64*MiB,kind:'control'},
 {path:'/sessions/:id/details/:id',purpose:'one provider runtime detail',maxResponseBytes:32*MiB,kind:'control'},
 {path:'/sessions/:id/artifacts/:id',purpose:'one provider runtime artifact',maxResponseBytes:64*MiB,kind:'control'},
 {path:'/inbox/:id',purpose:'one exact retained capture',maxResponseBytes:32*MiB,kind:'control'},
 {path:'/inbox',purpose:'one Inbox identity with selected view; retire this alias',maxResponseBytes:2*MiB,kind:'legacy'},
 {path:'/sessions',purpose:'UNBOUNDED whole catalogue; MUST REMOVE after peer migration',maxResponseBytes:8*MiB,kind:'legacy'},
 {path:'/sessions/:id',purpose:'legacy receipts page; MUST REMOVE after prepared consumers migrate',maxResponseBytes:8*MiB,kind:'legacy'},
 {path:'/sessions/:id/view',purpose:'selected exact view; attention prepared, other costs under review',maxResponseBytes:2*MiB,kind:'legacy'},
 {path:'/sessions/:id/history',purpose:'legacy cursor-paged provider history; retire after prepared message readers',maxResponseBytes:8*MiB,kind:'legacy'},
 {path:'/lab',purpose:'legacy bounded lab list; retire after prepared catalogue',maxResponseBytes:8*MiB,kind:'legacy'},
 {path:'/saved',purpose:'legacy saved-session collection; migrate to prepared catalogue',maxResponseBytes:8*MiB,kind:'legacy'},
 {path:'/saved-work',purpose:'legacy saved-work collection; add page contract',maxResponseBytes:8*MiB,kind:'legacy'},
];
function matches(pattern:string,path:string){
 const expected=pattern.split('/').slice(1),actual=path.split('/').slice(1);
 return expected.length===actual.length&&expected.every((part,index)=>part.startsWith(':')?!!actual[index]:part===actual[index]);
}
export function ownerGetPolicy(method:string,path:string){
 if(method!=='GET')return null;
 const prepared=presentationContractFor(method,path);
 if(prepared)return {kind:'presentation' as const,maxResponseBytes:prepared.maxResponseBytes,contract:prepared};
 if(!path.startsWith('/sessions/v1/'))return null;
 const suffix=path.slice('/sessions/v1'.length);
 const exception=OWNER_GET_EXCEPTIONS.find(route=>matches(route.path,suffix));
 return exception?{...exception,contract:null}:null;
}
