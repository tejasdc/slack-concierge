/** An interactive presentation route must declare its growth dimension and bounded work.
 * The release harness runs these descriptors against retained-cardinality fixtures; adding
 * a route here without a fixture is a build failure, not a performance waiver. */
export const PRESENTATION_READERS={
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
