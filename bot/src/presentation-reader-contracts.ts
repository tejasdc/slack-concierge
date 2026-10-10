/** An interactive presentation route must declare its growth dimension and bounded work.
 * The release harness runs these descriptors against retained-cardinality fixtures; adding
 * a route here without a fixture is a build failure, not a performance waiver. */
export const PRESENTATION_READERS={
  inboxQueue:{route:'GET /sessions/v1/presentation/inbox-queue',collection:'waiting Inbox inputs',
    growth:'queued inputs and retained Inbox history',maxRows:50,maxStorageRows:60,maxResponseBytes:65_536,
    sourceTables:['turns','session_inputs'],fixture:'inbox-queue-growth'},
  topicEvents:{route:'GET /sessions/v1/inbox/topics/:topic/entries',collection:'topic entries',
    growth:'unrelated messages and large management declarations',maxRows:20,maxStorageRows:180,maxResponseBytes:524_288,
    sourceTables:['presentation_messages','presentation_topic_events','presentation_topic_event_display'],fixture:'topic-events-growth'},
  topicWindow:{route:'GET /sessions/v1/presentation/topics',collection:'topics',
    growth:'unrelated topics and matching search postings',maxRows:20,maxStorageRows:240,maxResponseBytes:262_144,
    sourceTables:['presentation_topics'],fixture:'topics-window-growth'},
  topicIncoming:{route:'GET /sessions/v1/presentation/incoming',collection:'incoming Inbox requests',
    growth:'earlier requests, agent requests and unrelated thread roots',maxRows:20,maxStorageRows:60,maxResponseBytes:131_072,
    sourceTables:['presentation_topic_roots','presentation_topics'],fixture:'topics-incoming-growth'},
  topicChanges:{route:'GET /sessions/v1/presentation/topics/changes',collection:'topic-changes',
    growth:'earlier topic changes',maxRows:20,maxResponseBytes:262_144,
    sourceTables:['presentation_topic_changes'],fixture:'topics-changes-growth'},
  topicResolution:{route:'GET /sessions/v1/presentation/topics/resolve',collection:'topic-resolution',
    growth:'unrelated Inbox messages and topic history',maxRows:1,maxResponseBytes:32_768,
    sourceTables:['presentation_messages','presentation_topics'],fixture:'topics-resolution-growth'},
  topicOverview:{route:'GET /sessions/v1/presentation/topics/:topic',collection:'topic-overview',
    growth:'historical topic requests questions and changes',maxRows:60,maxResponseBytes:524_288,
    sourceTables:['presentation_topics','presentation_topic_items','presentation_topic_questions'],fixture:'topics-overview-growth'},
  topicItems:{route:'GET /sessions/v1/presentation/topics/:topic/items',collection:'topic-items',
    growth:'historical topic items and unrelated question filters',maxRows:20,maxResponseBytes:131_072,
    sourceTables:['presentation_topic_items','presentation_topic_questions'],fixture:'topics-items-growth'},
  topicQuestions:{route:'GET /sessions/v1/presentation/questions',collection:'questions',
    growth:'settled questions and unrelated topics',maxRows:20,maxResponseBytes:262_144,
    sourceTables:['presentation_topic_questions','presentation_question_counts'],fixture:'topics-questions-growth'},
  topicDetail:{route:'GET /sessions/v1/presentation/topic-details/:hash',collection:'topic-detail-parts',
    growth:'retained item length and unrelated topic detail',maxRows:1,maxResponseBytes:131_072,
    sourceTables:['presentation_topic_chunks'],fixture:'topics-detail-growth'},
  messageWindow:{route:'GET /sessions/v1/presentation/messages',collection:'messages',
    growth:'unrelated Inbox roots and message versions',maxRows:20,maxResponseBytes:262_144,
    sourceTables:['presentation_messages'],fixture:'messages-window-growth'},
  messageDetail:{route:'GET /sessions/v1/presentation/messages/:session/:message/detail',collection:'message-parts',
    growth:'message length and unrelated message history',maxRows:4,maxResponseBytes:65_536,
    sourceTables:['presentation_message_detail_chunks'],fixture:'messages-detail-growth'},
  sessionWindow:{route:'GET /sessions/v1/presentation/sessions/window',collection:'sessions',
    growth:'unrelated sessions and prior turns',maxRows:40,maxResponseBytes:262_144,
    sourceTables:['presentation_session_cards'],fixture:'sessions-window-growth'},
  sessionChanges:{route:'GET /sessions/v1/presentation/sessions/changes',collection:'sessions',
    growth:'unrelated session history',maxRows:40,maxResponseBytes:262_144,
    sourceTables:['presentation_session_changes'],fixture:'sessions-changes-growth'},
  inboxAttention:{route:'GET /sessions/v1/presentation/sessions/:session/attention',collection:'Inbox attention',
    growth:'unrelated questions and reading history',maxRows:20,maxResponseBytes:262_144,
    sourceTables:['presentation_inbox_attention'],fixture:'inbox-attention-growth'},
  savedMessages:{route:'GET /sessions/v1/saved',collection:'saved messages and followed threads',
    growth:'older saved message marks and unrelated sessions',maxRows:20,maxStorageRows:300,maxResponseBytes:524_288,
    sourceTables:['session_saved_messages','session_followed_messages','sessions'],fixture:'saved-messages-growth'},
  savedWork:{route:'GET /sessions/v1/saved-work',collection:'queued saved work',
    growth:'older saved turns and unrelated provider turns',maxRows:10,maxStorageRows:200,maxResponseBytes:262_144,
    sourceTables:['turns','sessions'],fixture:'saved-work-growth'},
  lab:{route:'GET /sessions/v1/lab',collection:'lab requests and sessions',
    growth:'unrelated requests and sessions plus project moves',maxRows:40,maxStorageRows:300,maxResponseBytes:524_288,
    sourceTables:['presentation_lab_requests','presentation_session_cards','session_communication_requests','sessions'],fixture:'lab-growth'},
  receiptWindow:{route:'GET /sessions/v1/presentation/receipts/:session',collection:'receipts',
    growth:'settled receipts and unrelated session history',maxRows:40,maxResponseBytes:262_144,
    sourceTables:['presentation_receipts'],
    fixture:'receipts-window-growth'},
  receiptChanges:{route:'GET /sessions/v1/presentation/receipts/:session/changes',collection:'receipts',
    growth:'unrelated events and previously settled receipts',maxRows:40,maxResponseBytes:262_144,
    sourceTables:['presentation_receipt_changes'],
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
      storage:{maxCalls:128,maxRows:'maxStorageRows' in contract?contract.maxStorageRows:contract.maxRows*4+20,maxResultBytes:contract.maxResponseBytes*2}};
  }
  return null;
}
