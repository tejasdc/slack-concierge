/** An interactive presentation route must declare its growth dimension and bounded work.
 * The release harness runs these descriptors against retained-cardinality fixtures; adding
 * a route here without a fixture is a build failure, not a performance waiver. */
export const PRESENTATION_READERS={
  messageWindow:{route:'GET /sessions/v1/presentation/messages',collection:'messages',
    growth:'unrelated Inbox roots and message versions',maxRows:20,maxResponseBytes:262_144,
    sourceTables:['presentation_messages'],fixture:'messages-window-growth'},
  sessionWindow:{route:'GET /sessions/v1/presentation/sessions/window',collection:'sessions',
    growth:'unrelated sessions and prior turns',maxRows:40,maxResponseBytes:262_144,
    sourceTables:['prepared_session_cards'],fixture:'sessions-window-growth'},
  sessionChanges:{route:'GET /sessions/v1/presentation/sessions/changes',collection:'sessions',
    growth:'unrelated session history',maxRows:40,maxResponseBytes:262_144,
    sourceTables:['prepared_session_cards'],fixture:'sessions-changes-growth'},
  receiptWindow:{route:'GET /sessions/v1/presentation/receipts/:session',collection:'receipts',
    growth:'settled receipts and unrelated session history',maxRows:40,maxResponseBytes:262_144,
    sourceTables:['session_inputs','turns','session_communication_requests','session_peer_requests'],
    fixture:'receipts-window-growth'},
  receiptChanges:{route:'GET /sessions/v1/presentation/receipts/:session/changes',collection:'receipts',
    growth:'unrelated events and previously settled receipts',maxRows:40,maxResponseBytes:262_144,
    sourceTables:['presentation_change_log','session_inputs','turns','session_communication_requests'],
    fixture:'receipts-changes-growth'},
} as const;
export type PresentationReaderName=keyof typeof PRESENTATION_READERS;
export const presentationReader=(name:PresentationReaderName)=>PRESENTATION_READERS[name];

/** New presentation routes cannot run until their contract and executable fixture exist. */
export function presentationContractFor(method:string,path:string){
  if(method!=='GET')return null;
  for(const [name,contract] of Object.entries(PRESENTATION_READERS)){
    const pattern=contract.route.slice(4).split('/').map(part=>part.startsWith(':')?'[^/]+':part).join('/');
    if(new RegExp(`^${pattern}$`).test(path))return {name:name as PresentationReaderName,...contract,
      storage:{maxCalls:128,maxRows:contract.maxRows*4+20,maxResultBytes:contract.maxResponseBytes*2}};
  }
  return null;
}
