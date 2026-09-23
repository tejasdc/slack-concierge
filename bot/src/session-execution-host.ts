import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {db,getSessionById,getChannel,markTurnSteeringMessageSending,markTurnSteeringMessageSent,markTurnSteeringMessageFailed,markTurnSteeringMessageAmbiguous,finalizeTurnSteeringMessageAmbiguity,updateTurnSteeringReplayText,markTurnProviderAdmissionIntended,failRunningTurnAndReleaseSession,interruptOrphanedTurn,cancelRunningTurnAndReleaseSession,claimNativeResultReconciliation,claimOrphanedDelivery,recordTurnProviderTurnId,markTurnResponseDelivered,finishDeliveredTurn,finishTurn,settleTurnDependencies,relinquishTurnDelivery,parseAdditionalPaths,type QueuedTurnClaimRow,type SessionRow} from './state';
import {attachSessionSteering,bindSessionProvider,enqueueSessionInput,getAcceptedSessionInput,nativeRunId,recordSessionEvent,recordSessionInputAttention,sessionMetadata,stablePayload,updateSessionMetadata,type AcceptedSessionInput} from './session-inputs';
import {executeAgentTurn,type NativeTurnResult} from './turn-execution';
import {recordResultTurnOutcome} from './session-turn-outcome';
import {ActiveTurnDispatchRegistry,type TurnCancellationController} from './turn-dispatch-seams';
import type {TurnSteeringController} from './steering';
import {SessionOwner,type SessionOwnerRuntime} from './session-owner';
import type {AgentProvider} from './providers';
import type {ProviderId} from './state';
import {SessionCapabilityClient,chatGptCapabilities,type ChatGptAdmission,type CapabilityEvidence,type ChatGptReceipt} from './session-capability-client';
import {completeNativeFork,readNativeForkPin,type NativeForkPin} from './native-session-controls';
import {readRetainedNativeResult} from './turn-recovery';
import {isProcessIdentityAlive} from './runtime-identity';
import {ProviderCapabilityUnavailableError} from './provider-policy';
import {ProviderDispatchError} from './provider-failures';
import {PROVIDER_ALIASES} from './aliases';
import type {RunResult} from './codex';
import {sessionInputEnvelope,sessionInputInstructions} from './session-input-context';
import {INBOX_INSTRUCTIONS} from './session-inbox';
import {topicPromptContext} from './session-topics';
import {getRunningTurnDispatchBoundary,parkRunningTurnAfterProviderFailure} from './state';
import {log,errorFields} from './log';
import {transcribeAudioPath,transcriptionPrompt} from './transcription';
import {ProviderLoginManager} from './auth-login';
import {codexAccountInUse} from './codex-device-login';
import {CodexAccountLogin} from './codex-account-login';
import {currentAccount,listProfiles,saveProfile,activateProfile,activateProfileHome,refreshClaudeAccount,setCodexAccountInUse,rememberCurrentAccount,type ProviderAccount,type ProviderProfile,type ProviderKey} from './provider-accounts';
import {providerAccountUsage,scheduleProviderAccountUsageRefresh,type ProviderUsage} from './provider-account-usage';
import {usagePressureBrief} from './provider-usage-forecast';
import {activateCredentials,type ActivationReport} from './provider-activation';
import {resumeBlockedParkedHeadTurns} from './state';

export type ProviderAuthView=Readonly<{provider:'claude-code'|'codex';mode:'interactive'|'device';pending:boolean;signInKeepsCurrent:true;message:string;account:ProviderAccount|null;profiles:readonly ProviderProfile[];usage:ProviderUsage|null}>;
export type ProviderAuthRefreshResult=Readonly<{status:'awaiting_code'|'awaiting_approval'|'completed'|'failed'|'no_pending_login';url?:string;userCode?:string|null;resumedTurnIds?:readonly number[];activation?:ActivationReport|null}>;

export class SessionExecutionHost {
  readonly owner:SessionOwner;
  readonly capabilityClient:SessionCapabilityClient|null;
  private readonly providerLoginManager:ProviderLoginManager;
  private readonly codexLogin:CodexAccountLogin;
  constructor(readonly options:{instanceId:string;registry:ActiveTurnDispatchRegistry;providers:Partial<Record<ProviderId,AgentProvider>>;defaultCwd:string;wake():void;history?:SessionOwnerRuntime['history'];sources?:SessionOwnerRuntime['sources'];capabilitySocket?:string;capabilityClient?:SessionCapabilityClient;findForks?(pin:NativeForkPin):Promise<string[]>;providerSessionBound?(providerThreadUuid:string):Promise<void>;claudeAuthRefreshCommand?:string}) {
    this.capabilityClient=options.capabilityClient??(options.capabilitySocket?new SessionCapabilityClient({socketPath:options.capabilitySocket}):null);
    // A device login completes in the browser with nothing to send back, so the
    // process exiting is the only signal that credentials changed. Activation
    // belongs here too, or the new account would sit on disk unused.
    this.providerLoginManager=new ProviderLoginManager({onUnattendedCompletion:provider=>{
      void (provider==='codex'?this.codexLogin.completed():this.settleCredentialChange(provider as ProviderKey))
        .catch(error=>{log('warn','auth_activation_failed',{provider,...errorFields(error)});});
    }});
    // A Codex sign-in lands in a home of its own and is only then put in use, so the
    // account already here keeps its token instead of being deleted by the login.
    this.codexLogin=new CodexAccountLogin(this.providerLoginManager,async home=>{
      activateProfileHome(home);
      await this.settleCredentialChange('codex');
    });
    // Codex signs itself in over its own API and keeps the token it obtained, so there is
    // nothing here to activate — only parked work to release once the account is usable.
    this.owner=new SessionOwner({wake:options.wake,available:provider=>provider==='chatgpt'?!!this.capabilityClient:!!options.providers[provider]&&options.providers[provider]!.capabilities?.send!==false,
      steer:input=>this.steer(input),stop:async(session,turn)=>{const stopped=options.registry.requestSessionCancellation(session,turn);if(!stopped.matched)return false;await stopped.completion;return true;},
      capabilities:session=>this.capabilities(session),
      saveCaptureNote:this.capabilityClient?input=>this.capabilityClient!.saveCaptureNote(input):undefined,
      history:options.history??((session,cursor,limit)=>this.history(session,cursor,limit)),
      detail:(session,key)=>this.detail(session,key),artifact:(session,id)=>this.artifact(session,id),
      bind:this.capabilityClient?((session,operation,reference)=>this.capabilityClient!.bind({operationId:operation.id,sessionId:`concierge:${session.id}`,bindingGeneration:session.binding_generation??1,reference})):undefined,
      fork:(_session,operation)=>{enqueueSessionInput(operation.id);},recover:(session,operation)=>this.recover(session,operation),
      auth:{status:()=>this.providerAuthStatus(),start:provider=>this.startProviderAuthRefresh(provider),complete:(provider,code)=>this.completeProviderAuthRefresh(provider,code),
        saveProfile:(provider,label)=>this.saveProviderAuthProfile(provider,label),switchProfile:(provider,profileId)=>this.switchProviderAuthProfile(provider,profileId)},
      sources:options.sources??(this.capabilityClient?{search:input=>this.capabilityClient!.searchSources(input),context:input=>this.capabilityClient!.sourceContext(input),import:input=>this.capabilityClient!.importSource(input),history:input=>this.capabilityClient!.sourceHistory(input),refresh:()=>this.capabilityClient!.refreshSources()}:undefined)},options.defaultCwd);
  }
  private providerAuthView(provider:ProviderKey):ProviderAuthView{
    const account=currentAccount(provider);
    return {provider,mode:provider==='codex'?'device':'interactive',
      pending:provider==='codex'?this.codexLogin.hasPending():this.providerLoginManager.hasPendingLogin(provider),
      // A signed-in account is kept before anything replaces it. A surface talking to an
      // older build sees this absent and warns him first, and stops once this is live.
      signInKeepsCurrent:true,
      message:account?`This machine runs ${provider==='codex'?'Codex':'Claude'} on ${account.label}.`
        :`This machine has no ${provider==='codex'?'Codex':'Claude'} account yet.`,
      account,profiles:listProfiles(provider),usage:providerAccountUsage(provider)};
  }
  private async providerAuthStatus():Promise<readonly ProviderAuthView[]>{
    // Asking Claude Code who it is costs a process start, so the surface that displays the
    // answer pays it rather than the dispatch path that only needs the identity.
    await Promise.all([refreshClaudeAccount(),codexAccountInUse().then(setCodexAccountInUse).catch(()=>{})]);
    // An account he is signed into is one this machine keeps, so the list he switches
    // between fills itself as he uses it.
    for(const provider of ['claude-code','codex'] as const)rememberCurrentAccount(provider);
    return [this.providerAuthView('claude-code'),this.providerAuthView('codex')];
  }
  private resumeParkedWorkAfterAuthRefresh(provider:ProviderKey):number[]{
    const resumedTurnIds=resumeBlockedParkedHeadTurns();
    if(resumedTurnIds.length)log('info','parked_head_turns_resumed',{reason:'auth_refresh',provider,turn_ids:resumedTurnIds});
    this.options.wake();
    return resumedTurnIds;
  }
  private assertAuthProvider(provider:string):ProviderKey{
    if(provider!=='codex'&&provider!=='claude-code')throw new ProviderCapabilityUnavailableError('auth','This provider has no configured authentication path.');
    return provider;
  }
  /** A credential change is only finished once the provider actually uses it. */
  private async settleCredentialChange(provider:ProviderKey):Promise<ProviderAuthRefreshResult>{
    const activation=await activateCredentials(provider);
    // The sign-in just changed who this host is; read it again so the answer this call
    // returns, and the next providers read, name the account that is actually active.
    if(provider==='claude-code')await refreshClaudeAccount();
    // The set of accounts changed, so their limits are read now rather than at the next
    // half-hourly pass; an account that just arrived would otherwise have nothing to show.
    void scheduleProviderAccountUsageRefresh().catch(()=>{});
    return {status:activation.status==='failed'?'failed':'completed',activation,
      resumedTurnIds:activation.status==='applied'?this.resumeParkedWorkAfterAuthRefresh(provider):[]};
  }
  private async startProviderAuthRefresh(provider:string):Promise<ProviderAuthRefreshResult>{
    const key=this.assertAuthProvider(provider);
    if(key==='codex'){
      const started=await this.codexLogin.start();
      if(started.status==='awaiting_approval')return {status:'awaiting_approval',url:started.url,userCode:started.userCode};
      if(started.status==='completed')return this.settleCredentialChange(key);
      log('warn','auth_refresh_failed',{provider:key});
      return {status:'failed'};
    }
    const command=this.options.claudeAuthRefreshCommand??'claude auth login';
    const started=await this.providerLoginManager.start(key,command,homedir(),'paste-code');
    if(started.status==='awaiting_code')return {status:'awaiting_code',url:started.url};
    if(started.status==='completed')return this.settleCredentialChange(key);
    log('warn','auth_refresh_failed',{provider:key,output_chars:started.output.length});
    return {status:'failed'};
  }
  private async completeProviderAuthRefresh(provider:string,code:string):Promise<ProviderAuthRefreshResult>{
    const key=this.assertAuthProvider(provider);
    const completion=await this.providerLoginManager.complete(key,code);
    if(completion.status==='no_pending_login')return {status:'no_pending_login'};
    if(completion.status==='completed')return this.settleCredentialChange(key);
    log('warn','auth_refresh_failed',{provider:key,output_chars:completion.output.length});
    return {status:'failed'};
  }
  private saveProviderAuthProfile(provider:string,label:string):readonly ProviderProfile[]{
    return saveProfile(this.assertAuthProvider(provider),label);
  }
  private async switchProviderAuthProfile(provider:string,profileId:string):Promise<ProviderAuthRefreshResult>{
    const key=this.assertAuthProvider(provider);
    activateProfile(key,profileId);
    return this.settleCredentialChange(key);
  }
  async stop():Promise<void>{await Promise.all([this.providerLoginManager.stop(),this.codexLogin.stop()]);}
  private capabilities(session:SessionRow) {
    if(session.provider_id==='chatgpt'&&this.capabilityClient)return {...chatGptCapabilities,recover:true,models:['chat','work'],attachments:['image/png','image/jpeg','image/webp']};
    const provider=this.options.providers[session.provider_id],restricted=sessionMetadata(session).interactionPolicy==='consultation-only';
    const models=[...new Set(Object.values(PROVIDER_ALIASES).filter(alias=>alias.provider===session.provider_id).flatMap(alias=>'model' in alias?[alias.model]:[]))];
    return {...provider?.capabilities,fork:provider?.capabilities?.fork===true&&!!provider.history,recover:true,models,attachments:restricted?[]:provider?['*/*']:[]};
  }
  private cwd(session:ReturnType<typeof getSessionById>) {if(!session)throw new Error('Unknown session');const channel=session.slack_channel_id?getChannel(session.slack_channel_id):null;return sessionMetadata(session).cwd??channel?.code_path??channel?.vault_path??this.options.defaultCwd;}
  private readRef(session:NonNullable<ReturnType<typeof getSessionById>>) {const binding=sessionMetadata(session).nativeBinding;if(!binding)throw new Error('Exact native account/conversation binding is unavailable.');return {sessionId:`concierge:${session.id}`,bindingGeneration:session.binding_generation??1,binding};}
  private async history(session:NonNullable<ReturnType<typeof getSessionById>>,cursor:string|null,limit:number) {
    if(session.provider_id==='chatgpt') {
      if(!sessionMetadata(session).nativeBinding)return null;
      if(!this.capabilityClient)throw new Error('ChatGPT history capability unavailable.');
      return this.capabilityClient.history({...this.readRef(session),cursor,limit});
    }
    const provider=this.options.providers[session.provider_id];
    if(!provider?.history||!session.agent_session_uuid)return null;
    return provider.history({sessionUuid:session.agent_session_uuid,cwd:this.cwd(session),cursor,limit});
  }
  private async detail(session:NonNullable<ReturnType<typeof getSessionById>>,detailKey:string) {
    if(session.provider_id==='chatgpt') {if(!this.capabilityClient)throw new Error('ChatGPT detail capability unavailable.');return this.capabilityClient.detail({...this.readRef(session),detailKey});}
    const provider=this.options.providers[session.provider_id];if(!provider?.detail||!session.agent_session_uuid)throw new Error('Native detail capability unavailable.');
    return provider.detail({sessionUuid:session.agent_session_uuid,cwd:this.cwd(session),detailKey});
  }
  private async artifact(session:NonNullable<ReturnType<typeof getSessionById>>,artifactId:string) {
    if(session.provider_id!=='chatgpt'||!this.capabilityClient)throw new Error('Artifact download capability unavailable.');
    const events=db.query("SELECT payload_json FROM session_owner_events WHERE session_id=? AND kind='message'").all(session.id) as any[];
    for(const event of events) {
      const message=JSON.parse(event.payload_json).message;
      for(const part of message?.richContent?.parts??[])if(part.kind==='file'&&part.id===artifactId)return this.capabilityClient.artifact({...this.readRef(session),messageId:message.id,path:part.path});
    }
    throw new Error('Artifact is not retained under this exact session message.');
  }
  private capabilityEvidence(input:AcceptedSessionInput,turnId:number,evidence:CapabilityEvidence) {
    const encoded=JSON.stringify(evidence),digest=createHash('sha256').update(encoded).digest('hex');
    recordSessionEvent({eventId:`capability:${input.id}:${digest}`,sessionId:input.session_id,inputId:input.id,turnId,kind:'capability',payload:evidence});
    if(evidence.kind==='observe')for(const event of evidence.observation.events) {
      if(event.kind==='message')recordSessionEvent({eventId:`provider:${input.id}:${event.eventId}`,sessionId:input.session_id,inputId:input.id,turnId,kind:'message',payload:event.payload});
    }
  }
  private prompt(input:AcceptedSessionInput):string {
    const body=JSON.parse(input.payload_json),payload=input.kind==='create'?body.firstInput:body;
    let prompt=payload.preparedPrompt??payload.text;
    if(sessionMetadata(getSessionById(input.session_id)!).inbox)prompt=INBOX_INSTRUCTIONS+'\n\n'+(payload.capture?`Retained captureId: ${payload.capture.id}\nSource: ${JSON.stringify(payload.capture.source)}\n\n`:'')+prompt;
    if(payload.replyToMessage)prompt+=`\n\n<reply-target>\n${JSON.stringify(payload.replyToMessage)}\n</reply-target>`;
    // The thread this input belongs to, or the instruction to file it first.
    prompt+=topicPromptContext(input.session_id,input.id,payload);
    if(payload.context?.length)prompt+=`\n\n<selected-workspace-revisions>\n${JSON.stringify(payload.context)}\n</selected-workspace-revisions>`;
    return prompt;
  }
  private steer(input:AcceptedSessionInput):boolean {
    const body=JSON.parse(input.payload_json);
    const session=getSessionById(input.session_id);
    if(!session||!this.owner.view(session).capabilities.steer)return false;
    if(sessionMetadata(session).interactionPolicy==='consultation-only'&&body.attachments?.length)return false;
    const matched=this.options.registry.dispatchSessionSteering(input.session_id,target=>{
      // Stop owns this run only. New communication waits in its session's FIFO.
      if(!db.query("SELECT 1 FROM turns WHERE id=? AND status='running' AND stop_requested_at IS NULL").get(target.turnId))return false;
      if(input.origin==='service'&&input.source_run_id!==nativeRunId(target.turnId))return false;
      if(body.expectedRunId&&nativeRunId(target.turnId)!==body.expectedRunId)return false;
      const attached=attachSessionSteering(input.id,target.turnId);
      const steeringId=attached.steering_id!;
      // A follow-up's delivery changes mid-turn with no other owner event on it, so each
      // change is announced on that input; surfaces refresh its receipt at once instead
      // of showing it queued until their next periodic check.
      const deliveryChanged=(state:'sent'|'ambiguous'|'failed')=>recordSessionEvent({eventId:`delivery:${input.id}:${state}`,
        sessionId:input.session_id,inputId:input.id,turnId:target.turnId,kind:'delivery',payload:{state}});
      const accepted=target.controller.enqueue({clientMessageId:input.id,text:this.prompt(attached),
        prepareText:async root=>{
          const attachments=this.owner.attachments(body.attachments);
          let text=this.prompt(attached);
          if(attachments.length) {
            if(!root)throw new Error('The active turn has no owned attachment root.');
            const transcripts=[];for(const attachment of attachments){const path=join(root,`${attachment.id}-${attachment.name}`);await writeFile(path,Buffer.from(attachment.base64,'base64'),{mode:0o600});text+=`\nAttached ${attachment.contentType} file ${JSON.stringify(attachment.name)}: ${path}`;if(attachment.contentType.startsWith('audio/'))transcripts.push(attachment.transcriptText?{slackFileId:attachment.id,title:attachment.name,text:attachment.transcriptText,source:'local' as const}:await transcribeAudioPath({slackFileId:attachment.id,title:attachment.name,path}));}const transcript=transcriptionPrompt(transcripts.filter(item=>!body.text?.includes(item.text)));text+=transcript?`\n\n${transcript}`:'';
          }
          if(sessionMetadata(session).interactionPolicy!=='consultation-only'&&session.provider_id!=='chatgpt')text=sessionInputEnvelope(attached,nativeRunId(target.turnId),text);
          updateTurnSteeringReplayText(steeringId,text,attachments.length);
          return text;
        },
        onSending:()=>markTurnSteeringMessageSending(steeringId),
        onSent:()=>{markTurnSteeringMessageSent(steeringId);deliveryChanged('sent');},
        onError:error=>{markTurnSteeringMessageFailed(steeringId,error.message);deliveryChanged('failed');},
        onAmbiguous:error=>{markTurnSteeringMessageAmbiguous(steeringId,error.message);deliveryChanged('ambiguous');},
        onAmbiguousFinalized:()=>{finalizeTurnSteeringMessageAmbiguity(steeringId);}});
      if(!accepted){markTurnSteeringMessageFailed(steeringId,'The live run ended before accepting this input.');deliveryChanged('failed');}
      return accepted;
    });
    return matched.matched&&matched.value;
  }
  async deliverResult(result:NativeTurnResult):Promise<'delivered'> {
    this.retainResult(result);
    // Only a delivered result can carry the turn's outcome; failures stay finished without saying.
    recordResultTurnOutcome(result);
    return 'delivered';
  }
  private retainResult(result:NativeTurnResult) {
    db.transaction(()=>{
      const eventId=`result:${result.turnId}`;
      const payload={...result,runId:nativeRunId(result.turnId)};
      const existed=db.query('SELECT payload_json FROM session_owner_events WHERE event_id=?').get(eventId) as {payload_json:string}|null;
      if(existed){if(stablePayload(JSON.parse(existed.payload_json))!==stablePayload(payload))throw new Error('Retained native result identity conflict.');return;}
      recordSessionInputAttention(result.inputId);
      recordSessionEvent({eventId,sessionId:result.sessionId,inputId:result.inputId,turnId:result.turnId,kind:'result',payload});
    })();
  }
  async run(claim:QueuedTurnClaimRow) {
    if(claim.turn_kind!=='native'||!claim.accepted_input_id)throw new Error('Native execution requires an accepted input.');
    const input=getAcceptedSessionInput(claim.accepted_input_id),session=getSessionById(claim.session_id);
    if(!input||!session||input.session_id!==session.id||input.turn_id!==claim.turn_id||input.steering_id!==null)throw new Error('Accepted native input binding changed.');
    recordSessionEvent({eventId:`run:${claim.turn_id}:${claim.dispatch_attempt}`,sessionId:session.id,inputId:input.id,turnId:claim.turn_id,kind:'run',payload:{run:this.owner.run(nativeRunId(claim.turn_id))}});
    try {
      return await this.options.registry.run({turnId:claim.turn_id,sessionId:session.id},async(steeringController,closeSteering,cancellationController)=>{
        if(input.kind==='fork'){closeSteering(new Error('A native fork control has no model input channel.'));return this.runFork(claim,input,session);}
        return this.runModel(claim,input,session,steeringController,closeSteering,cancellationController);
      });
    } finally {
      recordSessionEvent({eventId:`terminal:${claim.turn_id}:${claim.dispatch_attempt}`,sessionId:session.id,inputId:input.id,turnId:claim.turn_id,kind:'run',payload:{run:this.owner.run(nativeRunId(claim.turn_id))}});
    }
  }
  settleSetupFailure(claim:Pick<QueuedTurnClaimRow,'turn_id'|'dispatch_attempt'>,error:unknown) {
    const boundary=getRunningTurnDispatchBoundary(claim.turn_id,this.options.instanceId,claim.dispatch_attempt);
    if(!boundary)return false;
    const message=error instanceof Error?error.message:String(error);
    if(!boundary.admissionIntended&&!boundary.unsafeSteering&&!boundary.durableArtifactActivity)
      return failRunningTurnAndReleaseSession(claim.turn_id,this.options.instanceId,message);
    return parkRunningTurnAfterProviderFailure({turnId:claim.turn_id,ownerInstanceId:this.options.instanceId,dispatchAttempt:claim.dispatch_attempt,failureClass:'parked_ambiguous',error:message});
  }
  private async runModel(claim:QueuedTurnClaimRow,input:AcceptedSessionInput,session:SessionRow,steeringController:TurnSteeringController,closeSteering:(reason?:Error)=>void,cancellationController:TurnCancellationController) {
    const metadata=sessionMetadata(session);
    const channel=session.slack_channel_id?getChannel(session.slack_channel_id):null;
    const cwd=this.cwd(session);
    const body=JSON.parse(input.payload_json),payload=input.kind==='create'?body.firstInput:body;
    const attachments=this.owner.attachments(payload.attachments);
    let prompt=this.prompt(input),staging:string|null=null;
    const additionalDirs=[...(metadata.additionalDirs??parseAdditionalPaths(channel))];
    try {
      if(attachments.length&&metadata.interactionPolicy==='consultation-only')throw new ProviderCapabilityUnavailableError('attachments','Information-only consultation cannot read attached files.');
      if(attachments.length&&session.provider_id!=='chatgpt') {
        staging=await mkdtemp(join(tmpdir(),`concierge-native-${claim.turn_id}-`));additionalDirs.push(staging);
        const transcripts=[];for(const attachment of attachments){const path=join(staging,`${attachment.id}-${attachment.name}`);await writeFile(path,Buffer.from(attachment.base64,'base64'),{mode:0o600});prompt+=`\nAttached ${attachment.contentType} file ${JSON.stringify(attachment.name)}: ${path}`;if(attachment.contentType.startsWith('audio/'))transcripts.push(attachment.transcriptText?{slackFileId:attachment.id,title:attachment.name,text:attachment.transcriptText,source:'local' as const}:await transcribeAudioPath({slackFileId:attachment.id,title:attachment.name,path}));}const transcript=transcriptionPrompt(transcripts.filter(item=>!payload.text?.includes(item.text)));prompt+=transcript?`\n\n${transcript}`:'';
      }
      const nativeContext=metadata.interactionPolicy!=='consultation-only'&&session.provider_id!=='chatgpt';
      if(nativeContext)prompt=sessionInputEnvelope(input,nativeRunId(claim.turn_id),prompt);
      const underlying=this.options.providers[session.provider_id];
      const provider:AgentProvider={id:session.provider_id,capabilities:underlying?.capabilities,
        fork:async()=>{throw new Error('Native fork uses its exact control turn.');},
        run:async actual=>{
          const admission=this.retainAdmission(claim,input,session,actual,attachments);
          if(session.provider_id==='chatgpt') {
            if(!this.capabilityClient)throw new ProviderCapabilityUnavailableError('send','ChatGPT capability is not configured.');
            if(admission.purpose!=='chat'||admission.policy!=='standard')throw new ProviderCapabilityUnavailableError('send','ChatGPT does not support this purpose or consultation policy.');
            return this.capabilityClient.createChatGptProvider({run:{operationId:input.id,sessionId:`concierge:${session.id}`,inputId:input.id,runId:admission.runId},admission:admission as ChatGptAdmission,attachments,
              onEvidence:evidence=>this.capabilityEvidence(input,claim.turn_id,evidence),onNativeBinding:binding=>updateSessionMetadata(session.id,{nativeBinding:binding})}).run(actual);
          }
          if(!underlying)throw new ProviderCapabilityUnavailableError('send',`${session.provider_id} is unavailable; no provider substitution was attempted.`);
          return underlying.run(actual);
        }};
      return await executeAgentTurn({
      presentation:'native',inputId:input.id,turnKind:'native',turnId:claim.turn_id,session,provider,providerId:session.provider_id,providerLabel:session.provider_id,
      text:claim.turn_user_text,prompt,cwd,additionalDirs,model:claim.provider_model??undefined,reasoningEffort:claim.reasoning_effort??undefined,
      baseSystemPrompt:nativeContext?sessionInputInstructions(input,nativeRunId(claim.turn_id),{unnamed:!metadata.title?.trim(),budget:session.provider_id==='chatgpt'?null:usagePressureBrief(session.provider_id)}):undefined,
      unreplayableAttachmentCount:attachments.length,
      interactionPolicy:metadata.interactionPolicy??'standard',
      ownerInstanceId:this.options.instanceId,dispatchAttempt:claim.dispatch_attempt,steeringController,closeSteering,cancellationController,
      providerEnvironment:{CONCIERGE_SOURCE_INPUT_ID:input.id,CONCIERGE_SOURCE_RUN_ID:nativeRunId(claim.turn_id)},
      services:{bindProviderSession:(sessionId,provider,uuid)=>{
        bindSessionProvider(sessionId,provider,uuid);
        if(provider==='codex')void this.options.providerSessionBound?.(uuid).catch(error=>log('warn','codex_session_subscription_failed',{provider_thread_uuid:uuid,...errorFields(error)}));
      },deliverResult:result=>this.deliverResult(result)},
      });
    } finally {
      if(staging)await rm(staging,{recursive:true,force:true});
    }
  }
  private retainAdmission(claim:QueuedTurnClaimRow,input:AcceptedSessionInput,session:SessionRow,actual:Parameters<AgentProvider['run']>[0],attachments:ReturnType<SessionOwner['attachments']>) {
    const current=getSessionById(session.id)!,metadata=sessionMetadata(current);
    const owned=db.query("SELECT provider_admission_intended_at FROM turns WHERE id=? AND session_id=? AND owner_instance_id=? AND dispatch_attempt=? AND status='running' AND stop_requested_at IS NULL")
      .get(claim.turn_id,session.id,this.options.instanceId,claim.dispatch_attempt) as any;
    if(!owned?.provider_admission_intended_at||current.binding_generation!==session.binding_generation||current.status==='archived'||metadata.suspended)throw new ProviderCapabilityUnavailableError('send','The exact owner admission is no longer current.');
    const saved=JSON.parse(getAcceptedSessionInput(input.id)!.receipt_json??'{}');
    const admission={provider:session.provider_id,purpose:metadata.purpose??'chat',inputId:input.id,runId:nativeRunId(claim.turn_id),bindingGeneration:session.binding_generation??1,
      admittedAt:saved.admission?.admittedAt??new Date().toISOString(),promptHash:createHash('sha256').update(actual.prompt).digest('hex'),model:actual.model??null,
      attachments:attachments.map(({base64,...pin})=>pin),policy:metadata.interactionPolicy??'standard',nativeBinding:metadata.nativeBinding??null};
    if(session.provider_id==='chatgpt'&&saved.admission&&stablePayload(saved.admission)!==stablePayload(admission))throw new ProviderCapabilityUnavailableError('send','Prepared input changed from its immutable provider admission.');
    db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({...saved,admission}),input.id);
    return admission;
  }
  private async runFork(claim:QueuedTurnClaimRow,operation:AcceptedSessionInput,session:SessionRow) {
    let effectIntended=false;
    try {
      const pin=readNativeForkPin(operation),provider=this.options.providers[pin.provider];
      if(session.provider_id!==pin.provider||session.agent_session_uuid!==pin.parentSessionUUID||session.binding_generation!==pin.bindingGeneration||sessionMetadata(session).interactionPolicy==='consultation-only'||!provider?.capabilities?.fork||!provider.history)throw new ProviderCapabilityUnavailableError('fork','The pinned native fork capability or parent binding is unavailable.');
      let cursor:string|null=null,found=false;const cursors=new Set<string>();
      do {
        const page=await provider.history({sessionUuid:pin.parentSessionUUID,cwd:this.cwd(session),cursor,limit:100});
        found=page.messages.some(message=>provider.capabilities!.forkBoundary==='message'?message.id===pin.boundary:message.turnId===pin.boundary);
        if(found)break;
        cursor=page.nextCursor;
        if(cursor&&cursors.has(cursor))throw new Error('Native fork history did not advance.');
        if(cursor)cursors.add(cursor);
      } while(cursor);
      if(!found)throw new ProviderCapabilityUnavailableError('fork','The exact native fork boundary is absent from this conversation.');
      const current=getSessionById(session.id)!;
      if(current.agent_session_uuid!==pin.parentSessionUUID||current.binding_generation!==pin.bindingGeneration||current.status==='archived'||sessionMetadata(current).suspended||sessionMetadata(current).interactionPolicy==='consultation-only')throw new ProviderCapabilityUnavailableError('fork','The parent binding or eligibility changed before native fork admission.');
      const stop=db.query('SELECT stop_requested_at FROM turns WHERE id=?').get(claim.turn_id) as {stop_requested_at:string|null}|null;
      if(stop?.stop_requested_at){cancelRunningTurnAndReleaseSession(claim.turn_id,this.options.instanceId,'Stopped before native fork admission.');return;}
      const channel=current.slack_channel_id?getChannel(current.slack_channel_id):null;
      const retained={...pin,cwd:this.cwd(current),additionalDirs:sessionMetadata(current).additionalDirs??parseAdditionalPaths(channel),metadata:sessionMetadata(current),threadSource:`concierge-native-fork:${operation.id}`};
      db.transaction(()=>{
        if(!markTurnProviderAdmissionIntended(claim.turn_id,this.options.instanceId,claim.dispatch_attempt))throw new Error('Native fork control lost its owner.');
        db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(operation.receipt_json!),fork:retained}),operation.id);
      })();
      effectIntended=true;
      const result=await provider.fork({sessionUUID:pin.parentSessionUUID,cwd:retained.cwd,additionalDirs:retained.additionalDirs,lastTurnId:pin.boundary,threadSource:retained.threadSource,interactionPolicy:'standard'});
      completeNativeFork(operation.id,this.options.instanceId,result);
    } catch(error) {
      const reason=error instanceof Error?error.message:String(error);
      const confirmed=!effectIntended||error instanceof ProviderDispatchError&&error.terminalConfirmed||(error as any)?.outcome==='rejected';
      if(confirmed)failRunningTurnAndReleaseSession(claim.turn_id,this.options.instanceId,reason);
      else interruptOrphanedTurn(claim.turn_id,this.options.instanceId,`Native fork outcome is uncertain; it will not be repeated. ${reason}`);
    }
  }
  private async recover(session:SessionRow,operation:AcceptedSessionInput) {
    if(operation.turn_id===null)return;
    let turn=db.query('SELECT * FROM turns WHERE id=? AND session_id=?').get(operation.turn_id,session.id) as any;
    if(!turn||turn.turn_kind!=='native'||!['interrupted','parked','delivery_parked','delivering'].includes(turn.status))return;
    if(turn.owner_instance_id) {
      const identity=db.query('SELECT pid,boot_id AS bootId,process_start_ticks AS startTicks FROM process_instances WHERE instance_id=?').get(turn.owner_instance_id) as any;
      if(identity&&isProcessIdentityAlive(identity))return;
    }
    if(turn.status==='delivering'&&turn.delivery_status==='delivered') {
      if(claimOrphanedDelivery(turn.id,turn.owner_instance_id,this.options.instanceId))finishDeliveredTurn(turn.id);
      return;
    }
    if(operation.kind==='fork') {
      const pin=readNativeForkPin(operation);
      if(pin.provider!=='codex'||!pin.threadSource||!pin.cwd)return;
      const matches=await (this.options.findForks?this.options.findForks(pin):(await import('./codex')).findCodexForksByThreadSource({sourceSessionUUID:pin.parentSessionUUID,threadSource:pin.threadSource,cwd:pin.cwd}));
      if(matches.length!==1||matches[0]===pin.parentSessionUUID)return;
      const result:RunResult={text:'Fork recovered from exact native provenance.',sessionUUID:matches[0]!,toolsUsed:[],providerTurnId:null};
      db.transaction(()=>{if(this.claimResult(turn,result))completeNativeFork(operation.id,this.options.instanceId,result);})();
      return;
    }
    const saved=JSON.parse(operation.receipt_json??'{}');
    let result:RunResult|null=null,proof:ChatGptReceipt|null=null;
    if(turn.outbound_text!==null)result=readRetainedNativeResult(turn);
    else if(session.provider_id==='chatgpt'&&this.capabilityClient&&saved.admission) {
      const admission=saved.admission as ChatGptAdmission;
      if(admission.bindingGeneration!==session.binding_generation||admission.inputId!==operation.id||admission.runId!==turn.native_run_id)return;
      const run={operationId:operation.id,sessionId:`concierge:${session.id}`,inputId:operation.id,runId:turn.native_run_id};
      const receipt=await this.capabilityClient.reconcile(run);
      if(receipt.runId!==run.runId)throw new Error('Reconciliation returned another provider effect.');
      this.capabilityEvidence(operation,turn.id,{kind:'reconcile',run,receipt});
      const current=getSessionById(session.id)!;
      if(current.binding_generation!==session.binding_generation)throw new Error('Session binding changed during reconciliation.');
      const binding=sessionMetadata(current).nativeBinding??admission.nativeBinding;
      if(binding&&stablePayload(binding)!==stablePayload(receipt.nativeBinding))throw new Error('Reconciliation changed the exact native binding.');
      if(!['completed','failed','canceled'].includes(receipt.state))return;
      if(!receipt.result) {
        if(receipt.state==='completed')return;
        db.transaction(()=>{
          if(!claimNativeResultReconciliation({turnId:turn.id,sessionId:session.id,ownerInstanceId:this.options.instanceId,agentText:null,outboundText:null,isOwnerAlive:isProcessIdentityAlive}))return;
          this.finishNativeFailure(operation,turn,null,receipt);
        })();
        return;
      }
      if(receipt.result.state!==receipt.state)throw new Error('Reconciled result has conflicting terminal evidence.');
      if(receipt.result.sessionId!==receipt.nativeBinding?.sessionId)throw new Error('Reconciled output has no proven native conversation.');
      proof=receipt;
      result={text:receipt.result.text,sessionUUID:receipt.result.sessionId!,providerTurnId:receipt.result.turnId,toolsUsed:[]};
    }
    if(!result)return;
    const claimed=db.transaction(()=>{
      const current=getSessionById(session.id)!;
      const latest=db.query('SELECT provider_turn_id FROM turns WHERE id=?').get(turn.id) as any;
      if(current.binding_generation!==session.binding_generation||(current.agent_session_uuid&&current.agent_session_uuid!==result!.sessionUUID)||(latest.provider_turn_id&&latest.provider_turn_id!==result!.providerTurnId))throw new Error('The reconciled result no longer matches the exact session and turn.');
      if(!this.claimResult(turn,result))return false;
      if(proof?.nativeBinding){updateSessionMetadata(session.id,{nativeBinding:proof.nativeBinding});bindSessionProvider(session.id,'chatgpt',proof.nativeBinding.sessionId);}
      if(proof?.acknowledgedAt)db.query('UPDATE turns SET provider_input_acknowledged_at=COALESCE(provider_input_acknowledged_at,?) WHERE id=?').run(proof.acknowledgedAt,turn.id);
      recordTurnProviderTurnId(turn.id,result!.providerTurnId);
      if(proof&&(proof.state==='failed'||proof.state==='canceled')) {
        this.retainResult({...result!,inputId:operation.id,sessionId:session.id,turnId:turn.id});
        this.finishNativeFailure(operation,turn,result!.text,proof);
      }
      return true;
    })();
    if(!claimed)return;
    if(proof&&(proof.state==='failed'||proof.state==='canceled'))return;
    try {
      await this.deliverResult({...result,turnId:turn.id,sessionId:session.id,inputId:operation.id});
      markTurnResponseDelivered(turn.id);
      if(!finishDeliveredTurn(turn.id))throw new Error('Reconciled result could not settle its exact turn.');
    } catch(error) {relinquishTurnDelivery(turn.id,this.options.instanceId);throw error;}
  }
  private claimResult(turn:{id:number;session_id:number;status?:string;owner_instance_id?:string|null},result:RunResult) {
    if(turn.status==='delivering')return claimOrphanedDelivery(turn.id,turn.owner_instance_id??null,this.options.instanceId);
    return claimNativeResultReconciliation({turnId:turn.id,sessionId:turn.session_id,ownerInstanceId:this.options.instanceId,agentText:result.text,outboundText:JSON.stringify({version:1,result}),isOwnerAlive:isProcessIdentityAlive});
  }
  private finishNativeFailure(operation:AcceptedSessionInput,turn:{id:number;session_id:number},text:string|null,proof:ChatGptReceipt) {
    const saved=JSON.parse(getAcceptedSessionInput(operation.id)!.receipt_json??'{}');
    db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify({...saved,state:proof.state,error:proof.error??proof.result?.error??null}),operation.id);
    markTurnResponseDelivered(turn.id);
    db.query('UPDATE turns SET owner_instance_id=NULL WHERE id=?').run(turn.id);
    db.query("UPDATE sessions SET status=CASE WHEN status='archived' THEN status ELSE ? END WHERE id=?").run(proof.state==='failed'?'error':'idle',turn.session_id);
    finishTurn(turn.id,proof.state==='failed'?'error':'cancelled',text);
    settleTurnDependencies(turn.id);
    recordSessionEvent({eventId:`reconciled-terminal:${turn.id}`,sessionId:turn.session_id,inputId:operation.id,turnId:turn.id,kind:'run',payload:{run:this.owner.run(nativeRunId(turn.id))}});
  }
}
