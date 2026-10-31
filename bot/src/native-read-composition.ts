import {db,getChannel,type SessionRow} from './state';
import {sessionMetadata} from './session-inputs';
import {SessionOwner,type SessionOwnerRuntime} from './session-owner';
import {providers} from './providers';
import {ProviderHistoryPageClient} from './provider-history-page-client';
import {readClaudeCachedMessage,readCodexHistoryMessage} from './provider-history';
import {SessionCapabilityClient,chatGptCapabilities} from './session-capability-client';
import {CHATGPT_THINKING_LEVELS,HIS_CHATGPT_PREFIX,PROVIDER_ALIASES} from './aliases';
import {peerSettings} from './session-peers';
import {readRequestReceipt} from './native-read-request-receipt';

/**
 * ChatGPT and imported conversations' history is held by thnkr.ing. While thnkr.ing restarted at
 * 17:58 UTC on 2026-10-30, two reads of one ChatGPT conversation waited with no limit, held both
 * read workers for the gateway's 20 s and were killed, so every other read queued behind them. A
 * read here now waits at most this long and answers that thnkr.ing should be asked again.
 */
const CAPABILITY_READ_WAIT_MS=5000;

/** Read composition reuses the owner's projection and validation, without a command host. */
export function createNativeReadComposition(defaultCwd:string,capabilitySocket:string|undefined) {
  if(process.env.CONCIERGE_READ_WORKER!=='1')throw new Error('NATIVE_READ_WORKER_REQUIRED');
  const capabilityClient=capabilitySocket?new SessionCapabilityClient({socketPath:capabilitySocket}):null;
  const historyPages=new ProviderHistoryPageClient();
  historyPages.warm();
  const configuredPeers=peerSettings();
  const cwd=(session:SessionRow)=>{
    const channel=session.slack_channel_id?getChannel(session.slack_channel_id):null;
    return sessionMetadata(session).cwd??channel?.code_path??channel?.vault_path??defaultCwd;
  };
  const readRef=(session:SessionRow)=>{
    const binding=sessionMetadata(session).nativeBinding;
    if(!binding)throw new Error('Exact native account/conversation binding is unavailable.');
    return {sessionId:`concierge:${session.id}`,bindingGeneration:session.binding_generation??1,binding};
  };
  const runtime:SessionOwnerRuntime={
    wake(){throw new Error('READ_ONLY');},steer(){throw new Error('READ_ONLY');},
    async stop(){throw new Error('READ_ONLY');},
    available:provider=>provider==='chatgpt'?!!capabilityClient:!!providers[provider]&&providers[provider].capabilities?.send!==false,
    peerForPath:path=>configuredPeers.peers.find(peer=>peer.paths.some(prefix=>path.startsWith(prefix)))?.name??null,
    requestReceipt:readRequestReceipt,
    capabilities:session=>{
      if(session.provider_id==='chatgpt'&&capabilityClient)return {...chatGptCapabilities,recover:true,
        models:['chat','work',...CHATGPT_THINKING_LEVELS,...CHATGPT_THINKING_LEVELS.map(level=>HIS_CHATGPT_PREFIX+level)],attachments:['*/*']};
      const provider=providers[session.provider_id],restricted=sessionMetadata(session).interactionPolicy==='consultation-only';
      const models=[...new Set(Object.values(PROVIDER_ALIASES).filter(alias=>alias.provider===session.provider_id)
        .flatMap(alias=>'model' in alias?[alias.model]:[]))];
      return {...provider?.capabilities,fork:provider?.capabilities?.fork===true&&!!provider.history,
        recover:true,models,attachments:restricted?[]:provider?['*/*']:[]};
    },
    fork(){throw new Error('READ_ONLY');},recover:async()=>{throw new Error('READ_ONLY');},
    history:async(session,cursor,limit)=>{
      if(session.provider_id==='chatgpt'){
        if(!sessionMetadata(session).nativeBinding)return null;
        if(!capabilityClient)throw new Error('ChatGPT history capability unavailable.');
        return capabilityClient.history({...readRef(session),cursor,limit},AbortSignal.timeout(CAPABILITY_READ_WAIT_MS));
      }
      const provider=providers[session.provider_id];
      if(!provider?.history||!session.agent_session_uuid)return null;
      return provider.history({sessionUuid:session.agent_session_uuid,cwd:cwd(session),cursor,limit,ownerSessionId:session.id});
    },
    projectedHistory:(session,operation,cursor,limit,after,want)=>historyPages.request({operation,
      sessionId:`concierge:${session.id}`,cwd:cwd(session),cursor,limit,after,want}),
    historyMessage:async(session,messageId,turnId)=>{
      if(!session.agent_session_uuid)return null;
      if(session.provider_id==='claude-code')return readClaudeCachedMessage(session.agent_session_uuid,messageId);
      if(session.provider_id==='codex'&&turnId)return readCodexHistoryMessage(session.agent_session_uuid,turnId,messageId);
      return null;
    },
    detail:async(session,detailKey)=>{
      if(session.provider_id==='chatgpt'){
        if(!capabilityClient)throw new Error('ChatGPT detail capability unavailable.');
        return capabilityClient.detail({...readRef(session),detailKey},AbortSignal.timeout(CAPABILITY_READ_WAIT_MS));
      }
      const provider=providers[session.provider_id];
      if(!provider?.detail||!session.agent_session_uuid)throw new Error('Native detail capability unavailable.');
      return provider.detail({sessionUuid:session.agent_session_uuid,cwd:cwd(session),detailKey,ownerSessionId:session.id});
    },
    artifact:async(session,artifactId)=>{
      if(session.provider_id!=='chatgpt'||!capabilityClient)throw new Error('Artifact download capability unavailable.');
      const events=db.query("SELECT payload_json FROM session_owner_events WHERE session_id=? AND kind='message'").all(session.id) as any[];
      for(const event of events){
        const message=JSON.parse(event.payload_json).message;
        for(const part of message?.richContent?.parts??[])if(part.kind==='file'&&part.id===artifactId)
          return capabilityClient.artifact({...readRef(session),messageId:message.id,path:part.path});
      }
      throw new Error('Artifact is not retained under this exact session message.');
    },
    sources:capabilityClient?{
      search:input=>capabilityClient.searchSources(input),context:input=>capabilityClient.sourceContext(input),
      import:async()=>{throw new Error('READ_ONLY');},proof:input=>capabilityClient.sourceSearchProof(input),history:input=>capabilityClient.sourceHistory(input,AbortSignal.timeout(CAPABILITY_READ_WAIT_MS)),
      historyMessage:input=>capabilityClient.sourceHistoryMessage(input,AbortSignal.timeout(CAPABILITY_READ_WAIT_MS)),
    }:undefined,
  };
  return {owner:new SessionOwner(runtime,defaultCwd,configuredPeers.peers.map(peer=>peer.name)),close:()=>historyPages.close()};
}
