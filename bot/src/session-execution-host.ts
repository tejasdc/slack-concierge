import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {db,getSessionById,getChannel,markTurnSteeringMessageSending,markTurnSteeringMessageSent,markTurnSteeringMessageFailed,markTurnSteeringMessageAmbiguous,finalizeTurnSteeringMessageAmbiguity,updateTurnSteeringReplayText,markTurnProviderAdmissionIntended,failRunningTurnAndReleaseSession,interruptOrphanedTurn,cancelRunningTurnAndReleaseSession,claimNativeResultReconciliation,claimOrphanedDelivery,recordTurnProviderTurnId,markTurnResponseDelivered,finishDeliveredTurn,finishTurn,settleTurnDependencies,relinquishTurnDelivery,parseAdditionalPaths,type QueuedTurnClaimRow,type SessionRow} from './state';
import {attachSessionSteering,bindSessionProvider,enqueueSessionInput,getAcceptedSessionInput,nativeRunId,recordSessionEvent,recordSessionInputAttention,recoverUnsentSteeredInput,releaseEarlierWaitingInputs,sessionMetadata,stablePayload,updateSessionMetadata,type AcceptedSessionInput} from './session-inputs';
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
import {CHATGPT_THINKING_LEVELS,HIS_CHATGPT_PREFIX,PROVIDER_ALIASES} from './aliases';
import {recordRepairNotice} from './repair-notices';

/**
 * A ChatGPT request that fails because the channel itself broke (the page changed, sign-in failed,
 * the answer came from the wrong model) reaches the repair agent at once, so it is fixed once for
 * every agent rather than each asker giving up. Tejas, 2026-10-09: "the agent should not stop
 * there ... talk with the agent who built that ... so no other agents are blocked". ChatGPT asking
 * to slow down is temporary and is not filed. One notice per failure code per hour.
 */
function noteChatgptChannelFailure(error:unknown,sessionId:number):void{
  const text=error instanceof Error?error.message:String(error);
  const code=/CHATGPT_[A-Z_]+|CAPABILITY_[A-Z_]+/.exec(text)?.[0]??'CHATGPT_FAILURE';
  if(['CHATGPT_RATE_LIMITED','CAPABILITY_OWNER_LOST','CAPABILITY_OBSERVATION_ABORTED','CHATGPT_OBSERVATION_STOPPED'].includes(code))return;
  try{
    recordRepairNotice(db,{key:`chatgpt-channel:${code}:${Math.floor(Date.now()/3_600_000)}`,kind:'chatgpt_channel',
      text:`The ChatGPT channel failed a request from concierge:${sessionId} with ${code}. Agents ask ChatGPT Pro through it, so fix it for all of them: Thinkering's ChatGPT adapter (packages/adapters/src/chatgpt-browser.ts, chatgpt-subscription.ts), the real Chrome on the server (remote-box docs/chatgpt-browser.md), and the run receipt under /var/lib/thinkering/production/agents/chatgpt/. The session that built the channel is session:WzIsNDYyMiwxXQ.`});
  }catch{}
}
import type {RunResult} from './codex';
import {sessionInputEnvelope,sessionInputInstructions} from './session-input-context';
import {INBOX_INSTRUCTIONS,minutesText,pebbleArrivalWaitMs,relayUnpostedAnswer} from './session-inbox';
import {readClaudeCachedMessage,readCodexHistoryMessage,readClaudeHistory,readCodexHistory} from './provider-history';
import {ProviderHistoryPageClient} from './provider-history-page-client';
import {ATTENTION_INSTRUCTION,releaseFocusForPost,topicPromptContext} from './session-topics';
import {getRunningTurnDispatchBoundary,parkRunningTurnAfterProviderFailure,recordPendingSignIn,clearPendingSignIn} from './state';
import {log,errorFields} from './log';
import {transcribeAudioPath,transcriptionPrompt} from './transcription';
import {ProviderLoginManager} from './auth-login';
import {codexSignInState,codexAccountInUse} from './codex-device-login';
import {CodexAccountLogin} from './codex-account-login';
import {currentAccount,listProfiles,saveProfile,refreshClaudeAccount,setCodexAccountInUse,codexProfileSource,moveCodexAccountIntoUse,type ProviderAccount,type ProviderProfile,type ProviderKey} from './provider-accounts';
import {ClaudeAccountLogin} from './claude-account-login';
import {providerAccountUsage,scheduleProviderAccountUsageRefresh,type ProviderUsage} from './provider-account-usage';
import {chooseAccountForTurn} from './provider-account-choice';
import {needClaudeSignInRenewal} from './signin-renewal';
import {claudeRunsFromOwnHomes,forgetClaudeHomeCheck,markClaudeHomeRefused,markClaudeHomeVerified,savedWorkAccountRooms,sharedClaudeHome} from './provider-account-dispatch';
import {savedTurn,yieldBankedTurn} from './saved-work';
import {useCodexResetCredit} from './codex-reset-credit';
import {storedUsage,usagePressureBrief} from './provider-usage-forecast';
import {MANAGED_CODEX,activateCredentials,claudeAccountWorks,claudeCredentialsAnswer,runningCodexTurns,type ActivationReport} from './provider-activation';
import {resumeBlockedParkedHeadTurns,releaseAuthHeldWork,observeExecutionChanges} from './state';
import {noticeTime} from './provider-free-notice';
import {accountHome} from './provider-accounts';
import {claudeAccountSelection,selectClaudeAccount} from './provider-account-selection';
import {releaseUsageHeldWork} from './provider-usage';
import {isWritingSession,WRITING_SESSION_STANDING} from './session-roles';
import {readFileSync,realpathSync} from 'node:fs';
import {providerOwnerEnvironment} from './provider-owner-environment';
import {pinCodexThreadHooks} from './hook-pins';
import {HostedClaudeCodeTransport,claudeExecutable,executionDirectory,executionHostsEnabled,newExecutionId,streamJournal} from './execution-host-client';
import {recordExecutionExited,recordExecutionLaunched,recordLiveAdoption,releaseExecution,retainExecutionIntent,type Adoption,type ExecutionRow} from './executions';

export type ProviderAuthView=Readonly<{provider:'claude-code'|'codex';mode:'interactive'|'device';pending:boolean;signInKeepsCurrent:true;pendingFor:string|null;pendingUrl:string|null;lastSignIn:{ok:boolean;detail:string|null}|null;message:string;signedIn?:boolean;checking?:boolean;account:ProviderAccount|null;profiles:readonly ProviderProfile[];usage:ProviderUsage|null}>;
/**
 * `detail` is one sentence for him about what actually happened, present only when
 * something went wrong. Without it the app could say only "Couldn't start", and a sign-in
 * that had been taken away by a restart was reported to him as a wrong code.
 */
export type ProviderAuthRefreshResult=Readonly<{status:'awaiting_code'|'awaiting_approval'|'completed'|'failed'|'no_pending_login';url?:string;userCode?:string|null;detail?:string;needsSignIn?:boolean;resumedTurnIds?:readonly number[];activation?:ActivationReport|null}>;

const SIGN_IN_FAILURE_DETAIL:Record<string,string>={
  no_url_before_timeout:'The sign-in tool did not produce a link. Nothing changed.',
  cli_exited:'The sign-in tool stopped before it could show a link. Nothing changed.',
  superseded:'Another sign-in for this provider started, so this one was dropped.',
};

export class SessionExecutionHost {
  private readonly historyPages=new ProviderHistoryPageClient();
  readonly owner:SessionOwner;
  readonly capabilityClient:SessionCapabilityClient|null;
  private readonly providerLoginManager:ProviderLoginManager;
  private readonly codexLogin:CodexAccountLogin;
  private readonly claudeLogin:ClaudeAccountLogin;
  // One Codex switch at a time: two moves sharing one restart would undo in the wrong order.
  private codexSwitching=false;
  /** An account a move to just failed is not tried again for this long, so a dead login costs one restart, not one a minute. */
  private readonly codexMoveFailedAt=new Map<string,number>();
  private readonly stopCodexMoves:()=>void;
  // How the last sign-in that finished on its own ended, for the screen that waited on it.
  private readonly lastSignIn=new Map<ProviderKey,{ok:boolean;detail:string|null}>();
  constructor(readonly options:{instanceId:string;registry:ActiveTurnDispatchRegistry;providers:Partial<Record<ProviderId,AgentProvider>>;defaultCwd:string;wake():void;history?:SessionOwnerRuntime['history'];sources?:SessionOwnerRuntime['sources'];capabilitySocket?:string;capabilityClient?:SessionCapabilityClient;findForks?(pin:NativeForkPin):Promise<string[]>;providerSessionBound?(providerThreadUuid:string):Promise<void>;claudeAuthRefreshCommand?:string}) {
    // Codex work moves to an account with room by itself, as Claude's does (Tejas, 2026-10-08, capture
    // f48861f1: "Can we extend the same Claude code automation for account switching here to Codex too").
    // Checked whenever work stops or starts and once a minute, since a usage reading can arrive between.
    const detach=observeExecutionChanges(()=>void this.moveCodexOffSpentAccount());
    const timer=setInterval(()=>void this.moveCodexOffSpentAccount(),60_000);
    this.stopCodexMoves=()=>{detach();clearInterval(timer);};
    this.capabilityClient=options.capabilityClient??(options.capabilitySocket?new SessionCapabilityClient({socketPath:options.capabilitySocket}):null);
    // A device login completes in the browser with nothing to send back, so the
    // process exiting is the only signal that credentials changed. Activation
    // belongs here too, or the new account would sit on disk unused.
    this.providerLoginManager=new ProviderLoginManager({onUnattendedCompletion:provider=>{
      void (provider==='codex'?this.codexLogin.completed():this.finishClaudeSignIn())
        .catch(error=>{log('warn','auth_activation_failed',{provider,...errorFields(error)});});
    },onPendingChanged:(provider,expiresAtMs)=>{
      // A sign-in he has started becomes work in progress the drain can see, so an update
      // waits for it instead of discarding it while he is fetching the code.
      if(expiresAtMs===null)clearPendingSignIn(provider);
      else recordPendingSignIn(provider,this.options.instanceId,expiresAtMs);
    }});
    // A Codex sign-in lands in a home of its own and is only then put in use, so the
    // account already here keeps its token instead of being deleted by the login.
    this.codexLogin=new CodexAccountLogin(this.providerLoginManager,async home=>{
      const result=await this.putCodexAccountInUse(join(home,'auth.json'));
      this.lastSignIn.set('codex',{ok:result.status==='completed',detail:result.status==='completed'?null:result.detail??null});
    });
    // A Claude sign-in lands in a folder of its own too, and is filed under whoever it
    // turned out to be, so the login every Claude session here runs on is never replaced.
    this.claudeLogin=new ClaudeAccountLogin(this.providerLoginManager);
    // Codex signs itself in over its own API and keeps the token it obtained, so there is
    // nothing here to activate — only parked work to release once the account is usable.
    this.owner=new SessionOwner({wake:options.wake,available:provider=>provider==='chatgpt'?!!this.capabilityClient:!!options.providers[provider]&&options.providers[provider]!.capabilities?.send!==false,
      steer:input=>this.steer(input),stop:async(session,turn)=>{const stopped=options.registry.requestSessionCancellation(session,turn);if(!stopped.matched)return false;await stopped.completion;return true;},
      capabilities:session=>this.capabilities(session),
      saveCaptureNote:this.capabilityClient?input=>this.capabilityClient!.saveCaptureNote(input):undefined,
      history:options.history??((session,cursor,limit)=>this.history(session,cursor,limit)),
      projectedHistory:options.history||Object.entries(options.providers).some(([provider,value])=>
        (provider==='codex'||provider==='claude-code')&&value?.history!==
          (provider==='codex'?readCodexHistory:readClaudeHistory))?undefined:((session,operation,cursor,limit,after)=>
        this.historyPages.request({operation,sessionId:`concierge:${session.id}`,cwd:this.cwd(session),cursor,limit,after})),
      historyMessage:(session,messageId,turnId)=>this.historyMessage(session,messageId,turnId),
      detail:(session,key)=>this.detail(session,key),artifact:(session,id)=>this.artifact(session,id),
      bind:this.capabilityClient?((session,operation,reference)=>this.capabilityClient!.bind({operationId:operation.id,sessionId:`concierge:${session.id}`,bindingGeneration:session.binding_generation??1,reference})):undefined,
      fork:(_session,operation)=>{enqueueSessionInput(operation.id);},recover:(session,operation)=>this.recover(session,operation),
      auth:{status:(fresh?:boolean)=>this.providerAuthStatus(fresh===true),start:(provider,profileId)=>this.startProviderAuthRefresh(provider,profileId),complete:(provider,code)=>this.completeProviderAuthRefresh(provider,code),
        saveProfile:(provider,label)=>this.saveProviderAuthProfile(provider,label),switchProfile:(provider,profileId)=>this.switchProviderAuthProfile(provider,profileId),
        useResetCredit:(provider,account)=>this.useProviderResetCredit(provider,account)},
      sources:options.sources??(this.capabilityClient?{search:input=>this.capabilityClient!.searchSources(input),context:input=>this.capabilityClient!.sourceContext(input),import:input=>this.capabilityClient!.importSource(input),history:input=>this.capabilityClient!.sourceHistory(input),historyMessage:input=>this.capabilityClient!.sourceHistoryMessage(input),refresh:()=>this.capabilityClient!.refreshSources()}:undefined)},options.defaultCwd);
  }
  /** What Codex itself last said about its sign-in; see codexSignInState. */
  private codexSignIn:'signed-in'|'signed-out'|'unknown'='unknown';
  private providerAuthView(provider:ProviderKey):ProviderAuthView{
    let mark=performance.now();
    const step=(name:string)=>{const now=performance.now();this.authViewSteps[name]=Math.round(now-mark);mark=now;};
    const defaultAccount=currentAccount(provider);step('current_account_ms');
    const selection=provider==='claude-code'?claudeAccountSelection():null;step('selection_ms');
    const saved=listProfiles(provider);step('list_profiles_ms');
    // Where accounts have homes of their own, the main folder's login is a terminal's and is never
    // offered: agents never run on it, so a hand sign-in there cannot displace theirs.
    const ownHomes=provider==='claude-code'&&claudeRunsFromOwnHomes();step('own_homes_ms');
    const profiles=provider==='claude-code'&&ownHomes
      ?saved.map(profile=>({...profile,current:selection?.profileId===profile.id}))
      :provider==='claude-code'&&defaultAccount
      ?[{id:'default',label:defaultAccount.label,detail:defaultAccount.detail,current:!selection||selection.profileId==='default',signedIn:true},
        ...saved.filter(profile=>profile.label!==defaultAccount.label).map(profile=>({...profile,current:selection?.profileId===profile.id}))]
      :saved;
    const account=provider==='claude-code'&&ownHomes
      ?profiles.find(profile=>profile.current)??null
      :provider==='claude-code'&&selection&&selection.profileId!=='default'
      ?profiles.find(profile=>profile.id===selection.profileId)??defaultAccount:defaultAccount;
    // A sign-in Codex refused shows as signed out, on the account in use and on any kept
    // account whose usage reading was refused, so the row offers "Sign in again".
    const usage=providerAccountUsage(provider);
    const refused=new Set((usage?.accounts??[]).filter(entry=>entry.signedOut).map(entry=>entry.label));
    const brokenInUse=provider==='codex'&&this.codexSignIn==='signed-out';
    // The Codex login in use lives in the agents' own home, not in a kept account's folder, so it
    // had no row of its own and nothing on the page said "in use" (2026-10-07). It gets one.
    const listed=provider==='codex'&&account&&!profiles.some(profile=>profile.current)
      ?[{id:'in-use',label:account.label,detail:account.detail,current:true,signedIn:true},...profiles.filter(profile=>profile.label!==account.label)]
      :profiles;
    const checked=listed.map(profile=>({...profile,signedIn:profile.signedIn!==false&&!refused.has(profile.label)&&!(brokenInUse&&profile.current)}));
    if(provider==='codex'&&account)return {provider,mode:'device',pending:this.codexLogin.hasPending(),signInKeepsCurrent:true,pendingFor:null,pendingUrl:null,
      lastSignIn:this.lastSignIn.get(provider)??null,
      message:brokenInUse||refused.has(account.label)?`Codex on this machine is signed out: the sign-in for ${account.label} stopped working. Sign in again to run Codex work here.`:'',
      signedIn:!(brokenInUse||refused.has(account.label)),account,profiles:checked,usage};
    return {provider,mode:provider==='codex'?'device':'interactive',
      pending:provider==='codex'?this.codexLogin.hasPending():this.claudeLogin.hasPending(),
      // A signed-in account is kept before anything replaces it. A surface talking to an
      // older build sees this absent and warns him first, and stops once this is live.
      signInKeepsCurrent:true,
      // Which account's row a waiting sign-in belongs to, so a reloaded page puts the code
      // box back under the account he pressed rather than under "another account".
      pendingFor:provider==='claude-code'?this.claudeLogin.pendingFor():null,
      // The page that sign-in is waiting on, so a page that lost the answer to its press (a reload,
      // or a read that raced the start) can still open it; the Mac's browser agent was left with a
      // code box and no link on 2026-10-08. It goes only to the authenticated Accounts read.
      pendingUrl:provider==='claude-code'?this.claudeLogin.pendingUrl():null,
      // A Codex sign-in finishes in the browser, so its refusal can only reach him here.
      lastSignIn:this.lastSignIn.get(provider)??null,
      message:account?(provider==='claude-code'?this.claudeInUseSentence(account.label,usage):'')
        :ownHomes?'No Claude account is selected for agents on this machine. Sign in to one or switch to one below.'
        :`This machine has no ${provider==='codex'?'Codex':'Claude'} account yet.`,
      account,profiles:checked,usage};
  }
  /**
   * Nothing while the account he chose is the one in use: the row's "in use" tag already says so, and
   * his own choice read back to him is not news (Tejas, 2026-10-08). When it is at its limit, where new
   * work runs until it resets, because without that he could not tell a switch that went wrong from
   * the automatic move to an account with room (2026-10-07).
   */
  private claudeInUseSentence(chosen:string,usage:ReturnType<typeof providerAccountUsage>):string{
    const reading=usage?.accounts.find(item=>item.label===chosen);
    const full=reading?.windows.filter(window=>window.usedPercent>=100&&window.resetsAt)??[];
    if(!full.length)return '';
    const until=Math.max(...full.map(window=>Date.parse(window.resetsAt!)));
    const other=usage?.accounts.find(item=>item.label!==chosen&&!item.problem&&item.windows.length>0&&item.windows.every(window=>window.usedPercent<100));
    const when=noticeTime(db,until);
    return other
      ?`${chosen} is at its limit until ${when}, so new Claude work runs on ${other.label} until then.`
      :`${chosen} is at its limit until ${when}, and no other account has room, so new Claude work waits until then.`;
  }
/**
   * The account list, answered from what this machine last knew, with the checks run behind it.
   * Every open of Accounts used to wait for a fresh sign-in check and usage reading on both
   * machines first, 6 to 18 seconds each on 2026-10-07, so the page sat empty for up to a minute:
   * "Why are we like not caching things ... so I don't have to wait for like a minute, every single
   * time I open this page". Now an ordinary read returns at once, marked `checking` while a check
   * runs, and the page asks once more with `fresh` to get the checked answer. Refresh asks with
   * `fresh` directly, so pressing it still waits for new readings (2026-09-23). One check at a time
   * is shared by every reader.
   */
  private async providerAuthStatus(fresh=false):Promise<readonly ProviderAuthView[]>{
    const recent=Date.now()-this.providerAuthCheckedAt<30_000;
    const check=this.providerAuthCheck??(!fresh&&recent?null:this.providerAuthCheck=Promise.all([refreshClaudeAccount(),
      codexSignInState().then(answer=>{this.codexSignIn=answer.state;if(answer.state==='signed-in')setCodexAccountInUse(answer);}).catch(()=>{}),
      scheduleProviderAccountUsageRefresh().catch(()=>{})]).then(()=>undefined,()=>undefined)
      .finally(()=>{this.providerAuthCheck=null;this.providerAuthCheckedAt=Date.now();}));
    if(fresh&&check)await check;
    const checking=this.providerAuthCheck!==null;
    // Reading the list never copies a login. It used to snapshot the Codex login in use into
    // a kept home on every read, which is a second copy of one renewal key.
    return (['claude-code','codex'] as const).map(provider=>{
      // The Accounts page waits on this read, so a slow one names its own steps: on 2026-10-08 it took
      // ~10 s a read and finding why took a system-call trace.
      const started=performance.now();this.authViewSteps={};
      const view=this.providerAuthView(provider);
      const total=Math.round(performance.now()-started);
      if(total>=500)log('warn','provider_auth_view_slow',{provider,total_ms:total,fresh,...this.authViewSteps});
      return {...view,checking};
    });
  }
  private providerAuthCheck:Promise<void>|null=null;
  private authViewSteps:Record<string,number>={};
  private providerAuthCheckedAt=0;
  /**
   * Spends one banked reset on a named account, then reads that account again.
   *
   * Reading straight afterwards is what makes his screen the confirmation: the bars drop to
   * the reset state and the offer disappears, so nothing has to announce what happened.
   * Only Codex grants these; Claude has nothing of the kind to spend.
   */
  private async useProviderResetCredit(provider:string,account:string){
    if(provider!=='codex')throw new ProviderCapabilityUnavailableError('auth','This provider does not grant allowance resets.');
    const outcome=await useCodexResetCredit(account);
    if(outcome.status!=='failed')await scheduleProviderAccountUsageRefresh().catch(()=>{});
    return outcome;
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
  /**
   * `profileId` is the kept account he pressed sign-in on; absent means a new account. A
   * lapsed account is repaired in place: its row starts this, and finishing it switches to it.
   */
  private async startProviderAuthRefresh(provider:string,profileId?:string|null):Promise<ProviderAuthRefreshResult>{
    const key=this.assertAuthProvider(provider);
    if(key==='codex'){
      this.lastSignIn.delete('codex');
      const started=await this.codexLogin.start();
      if(started.status==='awaiting_approval')return {status:'awaiting_approval',url:started.url,userCode:started.userCode};
      if(started.status==='completed')return this.settleCredentialChange(key);
      log('warn','auth_refresh_failed',{provider:key});
      return {status:'failed'};
    }
    const expected=profileId?this.claudeProfile(profileId)?.label??null:null;
    const started=await this.claudeLogin.start(expected);
    if(started.status==='awaiting_code')return {status:'awaiting_code',url:started.url};
    if(started.status==='completed')return this.finishClaudeSignIn();
    log('warn','auth_refresh_failed',{provider:key,reason:started.reason,output_chars:started.output.length});
    return {status:'failed',detail:SIGN_IN_FAILURE_DETAIL[started.reason]??'The sign-in could not be started. Nothing changed.'};
  }
  private async completeProviderAuthRefresh(provider:string,code:string):Promise<ProviderAuthRefreshResult>{
    const key=this.assertAuthProvider(provider);
    const completion=key==='claude-code'?await this.claudeLogin.complete(code):await this.providerLoginManager.complete(key,code);
    // Not a wrong code: the waiting sign-in is gone, most often because Concierge updated
    // between his opening the link and his pasting what it gave him. Telling him the code
    // was wrong sent him round the same loop again, which is most of why this has felt like
    // nothing works (2026-09-24).
    if(completion.status==='no_pending_login')return {status:'no_pending_login',detail:'This sign-in is no longer waiting for a code — it most likely ended when Concierge updated. Start it again and it should go through.'};
    if(completion.status==='completed')return key==='claude-code'?this.finishClaudeSignIn():this.settleCredentialChange(key);
    log('warn','auth_refresh_failed',{provider:key,stage:'complete',output_chars:completion.output.length});
    return {status:'failed',detail:'The sign-in tool did not accept that code. Nothing changed.'};
  }
  /**
   * A finished Claude sign-in is kept under the account it actually is, then switched to
   * through the same proof as the Switch button, so "signed in" and "in use" cannot disagree.
   * Signing in as someone other than the account pressed keeps that login and switches nothing.
   */
  private async finishClaudeSignIn():Promise<ProviderAuthRefreshResult>{
    const filed=await this.claudeLogin.file();
    if(filed.status==='failed')return {status:'failed',detail:filed.detail};
    void scheduleProviderAccountUsageRefresh().catch(()=>{});
    if(filed.expected&&filed.expected!==filed.email)
      return {status:'failed',detail:`That signed in ${filed.email}, not ${filed.expected}. ${filed.email} is kept on this machine; nothing was switched.`};
    // The home it was just filed into, never a lookup by name: the default login has the same
    // address, and choosing it would re-test the login this sign-in was meant to replace.
    return this.switchProviderAuthProfile('claude-code',basename(filed.home));
  }
  private claudeProfile(profileId:string):{id:string;label:string}|null{
    const defaultAccount=currentAccount('claude-code');
    return profileId==='default'&&defaultAccount&&!claudeRunsFromOwnHomes()?{id:'default',label:defaultAccount.label}
      :listProfiles('claude-code').find(item=>item.id===profileId)??null;
  }
  private saveProviderAuthProfile(provider:string,label:string):readonly ProviderProfile[]{
    return saveProfile(this.assertAuthProvider(provider),label);
  }
  /**
   * Put a kept Codex login in use and prove the running daemon renews as that account before
   * saying so. The login is moved, never copied, and a failed proof moves both logins back
   * and restarts Codex onto the one it had, so a refused switch leaves his machine unchanged.
   */
  private async putCodexAccountInUse(source:string):Promise<ProviderAuthRefreshResult>{
    if(this.codexSwitching)return {status:'failed',detail:'Another Codex switch is still finishing on this machine. Nothing was changed.'};
    if(runningCodexTurns()!==0)return {status:'failed',detail:'Codex is working on this machine right now, so nothing was changed. Switch once that work finishes.'};
    this.codexSwitching=true;
    try {
      return await this.moveCodexAndProve(source);
    } finally { this.codexSwitching=false; }
  }
  private async moveCodexAndProve(source:string):Promise<ProviderAuthRefreshResult>{
    const move=moveCodexAccountIntoUse(source);
    let activation:ActivationReport;
    try { activation=await activateCredentials('codex'); }
    catch(error){ log('warn','auth_activation_failed',{provider:'codex',...errorFields(error)}); activation={status:'failed',detail:''}; }
    if(activation.status==='applied'){
      void scheduleProviderAccountUsageRefresh().catch(()=>{});
      return {status:'completed',activation:{status:'applied',detail:`Codex on this machine now runs on ${move.incoming.label}.`},
        resumedTurnIds:this.resumeParkedWorkAfterAuthRefresh('codex')};
    }
    move.undo();
    // Codex never restarted, so the account was never tried: say what failed, not "could not sign in".
    if(activation.restartFailed)return {status:'failed',detail:activation.detail};
    const back=move.outgoing?await activateCredentials('codex'):null;
    log('warn','provider_profile_switch_refused',{provider:'codex',reason:'account_did_not_authenticate',previous_answered:back?back.status==='applied':null});
    const still=move.outgoing?(back?.status==='applied'?` Still on ${move.outgoing.label}.`:` Codex is back on ${move.outgoing.label}, which did not answer either.`):'';
    return {status:'failed',needsSignIn:true,detail:`${move.incoming.label} could not sign in from this machine.${still}`};
  }
  private claudeSwitching=false;
  private async switchClaudeAccount(profileId:string):Promise<ProviderAuthRefreshResult>{
    const key='claude-code' as const;
    const profile=this.claudeProfile(profileId);
    if(!profile)throw new ProviderCapabilityUnavailableError('auth','That Claude account is not available on this machine.');
    const home=profile.id==='default'?null:accountHome(key,profile.id);
    if(profile.id!=='default'){
      if(!sharedClaudeHome(profile.label,home!,true)){
        log('warn','provider_profile_switch_refused',{provider:key,reason:'history_unavailable'});
        return {status:'failed',detail:'That Claude account could not be given this machine\'s shared settings, instructions and history, so agents would run without them. The previous account is still selected.'};
      }
    }
    forgetClaudeHomeCheck(home);
    const check=await claudeAccountWorks(home,profile.label);
    // At its limit is still signed in and still his choice: select it, and its work waits for the
    // reset or runs on the other account while that one has room.
    const full=check.reason==='out_of_room';
    if(!check.ok&&!full)markClaudeHomeRefused(home);
    if(check.reason==='signed_out'&&home)needClaudeSignInRenewal(profile.label,'switching to it found it signed out');
    if(!check.ok&&!full){
      log('warn','provider_profile_switch_refused',{provider:key,reason:check.reason});
      const why=check.reason==='signed_out'?`${profile.label} needs signing in again on this machine.`
        :check.reason==='wrong_account'?`That sign-in is now a different account than ${profile.label}.`
        :check.reason==='settings_not_in_effect'?`${profile.label} signed in, but agents on it could not write files or run commands with this machine's settings.`
        :check.reason==='timeout'?`${profile.label} did not answer in time.`
        :`${profile.label} could not finish a test task on this machine.`;
      return {status:'failed',needsSignIn:check.reason==='signed_out'||check.reason==='wrong_account',detail:`${why} Nothing was switched.`};
    }
    if(!full)markClaudeHomeVerified(home);
    selectClaudeAccount(profile.id,profile.label);
    const reading=providerAccountUsage(key)?.accounts.find(item=>item.label===profile.label);
    const hasRoom=!!reading&&!reading.problem&&reading.windows.length>0&&reading.windows.every(window=>window.usedPercent<100);
    if(hasRoom)releaseUsageHeldWork(key);
    // The account just proved it answers, so work held for a sign-in may go to it now.
    if(releaseAuthHeldWork(key))log('info','provider_auth_hold_released',{provider:key,released_by:'owner_switch'});
    return {status:'completed',activation:{status:'applied',detail:full?`New Claude work will use ${profile.label}. It is at its usage limit right now, so its work waits for the reset or runs on another account with room.`:`New Claude work will use ${profile.label}.`},
      resumedTurnIds:this.resumeParkedWorkAfterAuthRefresh(key)};
  }
  private async switchProviderAuthProfile(provider:string,profileId:string):Promise<ProviderAuthRefreshResult>{
    const key=this.assertAuthProvider(provider);
    if(key==='claude-code'){
      // One switch at a time: two presses in a row used to race on preparing the same home and the
      // second was refused for a reason that was not true.
      if(this.claudeSwitching)return {status:'failed',detail:'Another Claude switch is still finishing on this machine. Nothing was changed.'};
      this.claudeSwitching=true;
      try { return await this.switchClaudeAccount(profileId); } finally { this.claudeSwitching=false; }
    }
    const source=codexProfileSource(profileId);
    if(!source)throw new ProviderCapabilityUnavailableError('auth','That Codex account is not available on this machine.');
    return this.putCodexAccountInUse(source);
  }
  /**
   * Codex runs every turn on one shared login, so it cannot pick an account per turn the way Claude
   * does: the whole machine moves, through the same proven switch as the Accounts button. It moves
   * only off the account in use when that account's allowance is spent, only to an account whose
   * every window has room, and only while no Codex turn is running (a turn on a spent account has
   * already been refused, so this waits seconds, not hours). The switch releases the work that was
   * held for the spent account's reset. Nothing is said to him about it, as for Claude.
   */
  private async moveCodexOffSpentAccount():Promise<void>{
    if(this.codexSwitching||runningCodexTurns()!==0)return;
    const target=codexAccountWithRoomWhileInUseIsSpent();
    if(!target||Date.now()-(this.codexMoveFailedAt.get(target.label)??0)<15*60_000)return;
    log('info','codex_account_move_started',{reason:'in_use_account_spent'});
    const result=await this.putCodexAccountInUse(target.source).catch(error=>({status:'failed' as const,detail:String((error as Error)?.message??error)}));
    if(result.status==='completed')log('info','codex_account_moved',{released:'resumedTurnIds' in result?result.resumedTurnIds?.length??0:0});
    else {
      // Only an account that would not sign in waits before it is tried again; a failure of the
      // machine's own (an unmanaged Codex service) is retried next minute, once that is repaired.
      if((result as {needsSignIn?:boolean}).needsSignIn)this.codexMoveFailedAt.set(target.label,Date.now());
      log('warn','codex_account_move_failed',{detail:String(result.detail??'').slice(0,300)});
    }
  }
  async stop():Promise<void>{this.stopCodexMoves();await Promise.all([this.providerLoginManager.stop(),this.codexLogin.stop(),this.claudeLogin.stop(),this.historyPages.close()]);}
  private capabilities(session:SessionRow) {
    if(session.provider_id==='chatgpt'&&this.capabilityClient)return {...chatGptCapabilities,recover:true,models:['chat','work',...CHATGPT_THINKING_LEVELS,...CHATGPT_THINKING_LEVELS.map(level=>HIS_CHATGPT_PREFIX+level)],attachments:['*/*']};
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
    return provider.history({sessionUuid:session.agent_session_uuid,cwd:this.cwd(session),cursor,limit,ownerSessionId:session.id});
  }
  private async historyMessage(session:SessionRow,messageId:string,turnId:string|null) {
    if(!session.agent_session_uuid)return null;
    if(session.provider_id==='claude-code')return readClaudeCachedMessage(session.agent_session_uuid,messageId);
    if(session.provider_id==='codex'&&turnId)return readCodexHistoryMessage(session.agent_session_uuid,turnId,messageId);
    return null;
  }
  private async detail(session:NonNullable<ReturnType<typeof getSessionById>>,detailKey:string) {
    if(session.provider_id==='chatgpt') {if(!this.capabilityClient)throw new Error('ChatGPT detail capability unavailable.');return this.capabilityClient.detail({...this.readRef(session),detailKey});}
    const provider=this.options.providers[session.provider_id];if(!provider?.detail||!session.agent_session_uuid)throw new Error('Native detail capability unavailable.');
    return provider.detail({sessionUuid:session.agent_session_uuid,cwd:this.cwd(session),detailKey,ownerSessionId:session.id});
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
    // The Inbox's standing instructions are in its per-run instructions, read once per run; each
    // input carries only its own facts. They used to prefix every input: 3,802 characters, 1,029
    // copies in one conversation (September 23, 2026).
    if(sessionMetadata(getSessionById(input.session_id)!).inbox&&payload.capture) {
      const wait=pebbleArrivalWaitMs(payload.capture.source,input.created_at);
      const arrival=wait===null?'':`Arrived late: this note reached the server ${minutesText(wait)} after he recorded it. The wait happened before his phone sent it, not in the Inbox; he cannot tell that from his side.\n`;
      prompt=`Retained captureId: ${payload.capture.id}\nSource: ${JSON.stringify(payload.capture.source)}\n${arrival}\n`+prompt;
    }
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
      // One message into the run, with its own words and files.
      const deliver=(one:AcceptedSessionInput):boolean=>{
        const input=one,body=JSON.parse(one.payload_json);
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
      };
      // His earlier messages still waiting for their own turn go in first, in his order
      // (releaseEarlierWaitingInputs); one the run cannot take returns to the queue.
      const earlier=sessionMetadata(session).interactionPolicy==='consultation-only'?[]:releaseEarlierWaitingInputs(input.session_id,input.id);
      for(const one of earlier)if(!deliver(one))enqueueSessionInput(recoverUnsentSteeredInput(one.id).id);
      return deliver(input);
    });
    return matched.matched&&matched.value;
  }
  async deliverResult(result:NativeTurnResult):Promise<'delivered'> {
    this.retainResult(result);
    // An Inbox turn that answered another agent's return or request only in its closing text
    // has that text relayed into the thread it owes, before the outcome is recorded, so a
    // `response` finds something to read there and the answer never silently disappears.
    // Relaying must never fail delivery of the answer it carries.
    try {
      const relayed=relayUnpostedAnswer(result);
      if(relayed) {
        log('warn','inbox_answer_relayed',{session_id:result.sessionId,turn_id:result.turnId,input_id:result.inputId,thread:relayed});
        const session=getSessionById(result.sessionId);
        if(session)releaseFocusForPost(session,relayed,null);
      }
    } catch(error) {log('error','inbox_answer_relay_failed',{turn_id:result.turnId,...errorFields(error)});}
    // Only a delivered result can carry the turn's outcome; failures stay finished without saying.
    recordResultTurnOutcome(result);
    return 'delivered';
  }
  private retainResult(result:NativeTurnResult) {
    // Immediate, because this transaction reads before it writes. A deferred one takes its read
    // snapshot first, and when another process commits in between (the deployment drain claim at
    // 22:28:15 on 2026-10-09), SQLite refuses the write at once as "database is locked" without
    // waiting the busy timeout: the finished answer of turn 5924 failed retention and reached him
    // only after the next restart adopted it. Reserving the writer up front waits instead.
    db.transaction(()=>{
      const eventId=`result:${result.turnId}`;
      const payload={...result,runId:nativeRunId(result.turnId)};
      const existed=db.query('SELECT payload_json FROM session_owner_events WHERE event_id=?').get(eventId) as {payload_json:string}|null;
      if(existed){if(stablePayload(JSON.parse(existed.payload_json))!==stablePayload(payload))throw new Error('Retained native result identity conflict.');return;}
      recordSessionInputAttention(result.inputId);
      recordSessionEvent({eventId,sessionId:result.sessionId,inputId:result.inputId,turnId:result.turnId,kind:'result',payload});
    }).immediate();
  }
  /**
   * A run is executed here once per dispatch attempt; `adoption` is that same run taken back by a
   * later coordinator from its execution host after a restart, through the same steps.
   */
  async run(claim:QueuedTurnClaimRow,adoption?:Adoption) {
    if(claim.turn_kind!=='native'||!claim.accepted_input_id)throw new Error('Native execution requires an accepted input.');
    const input=getAcceptedSessionInput(claim.accepted_input_id),session=getSessionById(claim.session_id);
    if(!input||!session||input.session_id!==session.id||input.turn_id!==claim.turn_id||input.steering_id!==null)throw new Error('Accepted native input binding changed.');
    if(!adoption)recordSessionEvent({eventId:`run:${claim.turn_id}:${claim.dispatch_attempt}`,sessionId:session.id,inputId:input.id,turnId:claim.turn_id,kind:'run',payload:{run:this.owner.run(nativeRunId(claim.turn_id))}});
    try {
      return await this.options.registry.run({turnId:claim.turn_id,sessionId:session.id},async(steeringController,closeSteering,cancellationController)=>{
        if(input.kind==='fork'){closeSteering(new Error('A native fork control has no model input channel.'));return this.runFork(claim,input,session);}
        if(adoption)await this.settleUnsentSteering(claim.turn_id,adoption.execution);
        const outcome=await this.runModel(claim,input,session,steeringController,closeSteering,cancellationController,adoption);
        // Only here is the run's outcome durably settled; a crash before this leaves the host's
        // record for the next coordinator to settle from.
        await this.releaseExecutions(claim.turn_id).catch(error=>log('warn','execution_release_failed',{turn_id:claim.turn_id,...errorFields(error)}));
        return outcome;
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
  /**
   * Follow-ups the previous coordinator had queued for this turn but never wrote to the agent are
   * provably unsent: they fail back to their own queue. One it was writing is settled by the host's
   * record: written means Claude's pickup decides it (during replay or later), absent means unsent.
   */
  private async settleUnsentSteering(turnId:number,execution:ExecutionRow) {
    const rows=db.query(`SELECT steering.id,steering.status,input.id AS input_id FROM turn_steering_messages steering
      LEFT JOIN session_inputs input ON input.steering_id=steering.id
      WHERE steering.turn_id=? AND steering.status IN ('queued','sending')`).all(turnId) as {id:number;status:string;input_id:string|null}[];
    // 'queued' was never handed to the provider by anyone: provably unsent.
    for(const row of rows)if(row.status==='queued')markTurnSteeringMessageFailed(row.id,'Concierge restarted before this message was sent to the agent; it was never delivered.');
    const sending=rows.filter(row=>row.status==='sending');
    if(!sending.length)return;
    // The daemon's own history decides a Codex follow-up (recoveredSteeringClientIds).
    if(execution.supervisor==='codex-daemon')return;
    // A host records a write before making it, then records whether it completed. Only those
    // records prove anything: no attempt means unsent; a recorded failure means unsent; a
    // completed write is decided by Claude's pickup; anything unreadable or unfinished stays uncertain.
    const attempted=new Set<string>(),completed=new Set<string>(),failed=new Set<string>();
    let readable=true;
    try {
      for await(const frame of streamJournal(execution.directory)) {
        if(frame.k==='i'&&frame.d?.meta?.kind==='steering'&&typeof frame.d.meta.clientMessageId==='string')attempted.add(frame.d.id);
        if(frame.k==='c'&&frame.d?.op==='written')completed.add(frame.d.id);
        if(frame.k==='c'&&frame.d?.op==='write-failed')failed.add(frame.d.id);
      }
    } catch(error){readable=false;log('warn','execution_journal_unreadable',{execution_id:execution.execution_id,...errorFields(error)});}
    for(const row of sending) {
      const command=row.input_id?`steer-${row.input_id}`:null;
      if(!readable||!command){markTurnSteeringMessageAmbiguous(row.id,'Concierge restarted while sending this message and its delivery cannot be confirmed.');continue;}
      if(!attempted.has(command)||failed.has(command)){markTurnSteeringMessageFailed(row.id,'Concierge restarted before this message was written to the agent; it was never delivered.');continue;}
      if(!completed.has(command))markTurnSteeringMessageAmbiguous(row.id,'Concierge restarted while this message was being written to the agent; its delivery cannot be confirmed.');
    }
  }
  /** After the turn's outcome is durably the owner's, its host may let its record go. */
  private async releaseExecutions(turnId:number) {
    for(const execution of db.query("SELECT * FROM executions WHERE turn_id=? AND state IN ('live','exited')").all(turnId) as ExecutionRow[])
      await releaseExecution(execution);
  }
  /** What Claude's record of picking up an earlier coordinator's follow-up means for its delivery. */
  private recoveredSteering(clientMessageId:string,outcome:'acknowledged'|'unacknowledged') {
    const row=db.query('SELECT steering_id,session_id,turn_id FROM session_inputs WHERE id=?').get(clientMessageId) as {steering_id:number|null;session_id:number;turn_id:number|null}|null;
    if(!row?.steering_id)return;
    // Only states this evidence can move: an acknowledgement upgrades sending or uncertain to sent;
    // a missing pickup makes sending uncertain. A settled failure or delivery stays as it is.
    const status=(db.query('SELECT status FROM turn_steering_messages WHERE id=?').get(row.steering_id) as {status:string}|null)?.status;
    if(outcome==='acknowledged'&&(status==='sending'||status==='ambiguous'))markTurnSteeringMessageSent(row.steering_id);
    else if(outcome==='unacknowledged'&&status==='sending')markTurnSteeringMessageAmbiguous(row.steering_id,'The run ended before the agent recorded picking this message up.');
    else return;
    recordSessionEvent({eventId:`delivery:${clientMessageId}:${outcome==='acknowledged'?'sent':'ambiguous'}`,sessionId:row.session_id,inputId:clientMessageId,
      turnId:row.turn_id,kind:'delivery',payload:{state:outcome==='acknowledged'?'sent':'ambiguous'}});
  }
  private async runModel(claim:QueuedTurnClaimRow,input:AcceptedSessionInput,session:SessionRow,steeringController:TurnSteeringController,closeSteering:(reason?:Error)=>void,cancellationController:TurnCancellationController,adoption?:Adoption) {
    const saved=savedTurn(claim.turn_id);
    let boundAccount:{account:string;home:string|null}|null=adoption?.processor.account??null;
    if(!adoption&&saved?.saved_kind==='banked'&&!saved.saved_manual_start) {
      const usage=session.provider_id==='codex'||session.provider_id==='claude-code'?providerAccountUsage(session.provider_id):null;
      const rooms=usage&&['codex','claude-code'].includes(session.provider_id)
        ?savedWorkAccountRooms(session.provider_id as ProviderKey,usage):[];
      const choice=chooseAccountForTurn({accounts:rooms,
        bound:saved.saved_account?{account:saved.saved_account,reason:'spending-this-window'}:null,prefer:null});
      if(!saved.saved_account||saved.saved_boundary_ms===null||saved.saved_boundary_ms<=Date.now()
        ||choice.account!==saved.saved_account) {
        if(!yieldBankedTurn(claim.turn_id,this.options.instanceId))throw new Error('Banked account declined after admission; exact turn needs reconciliation.');
        closeSteering();
        return;
      }
      boundAccount={account:choice.account,home:choice.home};
    }
    const metadata=sessionMetadata(session);
    const channel=session.slack_channel_id?getChannel(session.slack_channel_id):null;
    const cwd=this.cwd(session);
    const body=JSON.parse(input.payload_json),payload=input.kind==='create'?body.firstInput:body;
    const attachments=this.owner.attachments(payload.attachments);
    // An adopted run continues exactly what was started: the same words, files and folders, never
    // a re-preparation that could differ from what the agent already read.
    let prompt=adoption?String(adoption.processor.replayPrompt):this.prompt(input),staging:string|null=adoption?.processor.staging??null;
    const additionalDirs=adoption?[...adoption.processor.runAdditionalDirs as string[]]:[...(metadata.additionalDirs??parseAdditionalPaths(channel))];
    try {
      if(attachments.length&&metadata.interactionPolicy==='consultation-only')throw new ProviderCapabilityUnavailableError('attachments','Information-only consultation cannot read attached files.');
      if(!adoption&&attachments.length&&session.provider_id!=='chatgpt') {
        staging=await mkdtemp(join(tmpdir(),`concierge-native-${claim.turn_id}-`));additionalDirs.push(staging);
        const transcripts=[];for(const attachment of attachments){const path=join(staging,`${attachment.id}-${attachment.name}`);await writeFile(path,Buffer.from(attachment.base64,'base64'),{mode:0o600});prompt+=`\nAttached ${attachment.contentType} file ${JSON.stringify(attachment.name)}: ${path}`;if(attachment.contentType.startsWith('audio/'))transcripts.push(attachment.transcriptText?{slackFileId:attachment.id,title:attachment.name,text:attachment.transcriptText,source:'local' as const}:await transcribeAudioPath({slackFileId:attachment.id,title:attachment.name,path}));}const transcript=transcriptionPrompt(transcripts.filter(item=>!payload.text?.includes(item.text)));prompt+=transcript?`\n\n${transcript}`:'';
      }
      const nativeContext=metadata.interactionPolicy!=='consultation-only'&&session.provider_id!=='chatgpt';
      if(nativeContext&&!adoption)prompt=sessionInputEnvelope(input,nativeRunId(claim.turn_id),prompt);
      const replayPrompt=prompt,runAdditionalDirs=[...additionalDirs];
      const underlying=this.options.providers[session.provider_id];
      const provider:AgentProvider={id:session.provider_id,capabilities:underlying?.capabilities,
        fork:async()=>{throw new Error('Native fork uses its exact control turn.');},
        run:async prepared=>{
          let actual=prepared;
          // New Codex turns always use the shared daemon. Retain the old host path only
          // to finish an execution recorded before this change.
          const privateCodex=session.provider_id==='codex'&&!!adoption&&adoption.execution.supervisor!=='codex-daemon';
          const kept={replayPrompt,runAdditionalDirs,staging,account:prepared.accountLabel&&(session.provider_id==='claude-code'||privateCodex)
            ?{account:prepared.accountLabel,home:(session.provider_id==='codex'?prepared.environment?.CODEX_HOME:prepared.environment?.CLAUDE_CONFIG_DIR)??null}:null};
          if(session.provider_id==='claude-code'&&(adoption||executionHostsEnabled())) {
            actual=adoption?this.adoptedRun(prepared,adoption):this.hostedRun(prepared,claim,session,kept);
          } else if(privateCodex) {
            actual=this.adoptedRun(prepared,adoption!,MANAGED_CODEX);
          } else if(session.provider_id==='codex'&&(adoption||executionHostsEnabled())) {
            // The shared daemon already outlives Concierge; recording the run lets the next Concierge follow it.
            actual=adoption?this.adoptedCodexRun(prepared,adoption,session):this.trackedCodexRun(prepared,claim,session,kept);
          }
          // An adopted run's admission was retained when it started, and a Stop requested meanwhile
          // must still reach its process, so it is not re-checked here.
          const admission=adoption?null:this.retainAdmission(claim,input,session,actual,attachments);
          if(session.provider_id==='chatgpt'&&admission) {
            // Only a person's or an asking agent's own words are ever typed into ChatGPT. Concierge's
            // service notices (cancellations, returns, reminders) are for agents and stop here.
            if(input.origin==='service')throw new ProviderCapabilityUnavailableError('send','ChatGPT receives only the words of a person or an asking agent; a service notice is not sent.');
            if(!this.capabilityClient)throw new ProviderCapabilityUnavailableError('send','ChatGPT capability is not configured.');
            if(admission.purpose!=='chat'||admission.policy!=='standard')throw new ProviderCapabilityUnavailableError('send','ChatGPT does not support this purpose or consultation policy.');
            return this.capabilityClient.createChatGptProvider({run:{operationId:input.id,sessionId:`concierge:${session.id}`,inputId:input.id,runId:admission.runId},admission:admission as ChatGptAdmission,attachments:attachments.map(({transcriptText,...file})=>file),
              onEvidence:evidence=>this.capabilityEvidence(input,claim.turn_id,evidence),onNativeBinding:binding=>updateSessionMetadata(session.id,{nativeBinding:binding})}).run(actual)
              .catch(error=>{noteChatgptChannelFailure(error,session.id);throw error;});
          }
          if(!underlying)throw new ProviderCapabilityUnavailableError('send',`${session.provider_id} is unavailable; no provider substitution was attempted.`);
          return underlying.run(actual);
        }};
      return await executeAgentTurn({
      presentation:'native',inputId:input.id,turnKind:'native',turnId:claim.turn_id,session,provider,providerId:session.provider_id,providerLabel:session.provider_id,
      text:claim.turn_user_text,prompt,cwd,additionalDirs,model:claim.provider_model??undefined,reasoningEffort:claim.reasoning_effort??undefined,
      baseSystemPrompt:nativeContext?sessionInputInstructions(input,nativeRunId(claim.turn_id),{unnamed:!metadata.title?.trim(),budget:session.provider_id==='chatgpt'?null:usagePressureBrief(session.provider_id),
        standing:[metadata.inbox?`${INBOX_INSTRUCTIONS}\n\n${ATTENTION_INSTRUCTION}`:null,
          isWritingSession(session)?WRITING_SESSION_STANDING:null,
          saved?.saved_kind==='banked'?'This work was banked to use spare allowance. Follow the same delivery and approval rules as daytime work. In your final answer, say what shipped and what remains. This run may stop at its allowance or a deployment boundary and resume later.':null].filter(Boolean).join('\n\n')||null}):undefined,
      unreplayableAttachmentCount:attachments.length,
      interactionPolicy:metadata.interactionPolicy??'standard',
      ownerInstanceId:this.options.instanceId,dispatchAttempt:claim.dispatch_attempt,steeringController,closeSteering,cancellationController,
      providerEnvironment:{CONCIERGE_SOURCE_INPUT_ID:input.id,CONCIERGE_SOURCE_RUN_ID:nativeRunId(claim.turn_id)},
      ...(boundAccount?{boundAccount}:{}),
      // Admission was recorded when this run first started; taking it back is not a new admission.
      ...(adoption?{adopted:true,beforeProviderAdmission:()=>{}}:{}),
      services:{bindProviderSession:(sessionId,provider,uuid)=>{
        bindSessionProvider(sessionId,provider,uuid);
        if(provider==='codex')void this.options.providerSessionBound?.(uuid).catch(error=>log('warn','codex_session_subscription_failed',{provider_thread_uuid:uuid,...errorFields(error)}));
      },deliverResult:result=>this.deliverResult(result)},
      });
    } finally {
      if(staging)await rm(staging,{recursive:true,force:true});
    }
  }
  /**
   * A new Claude run starts in its own execution host, recorded in the ledger before the host is
   * started, with what a later coordinator needs to take it back: the exact prompt, folders and
   * account, never re-derived.
   */
  private hostedRun(prepared:Parameters<AgentProvider['run']>[0],claim:QueuedTurnClaimRow,session:SessionRow,
    kept:{replayPrompt:string;runAdditionalDirs:string[];staging:string|null;account:{account:string;home:string|null}|null},executable?:string):Parameters<AgentProvider['run']>[0] {
    const executionId=newExecutionId(),stateDir=realpathSync(process.env.CONCIERGE_STATE_DIR!);
    const {onProgress,onProviderMessage,onProviderThreadStarted,onProviderTurnStarted,onSteeringReady,onCancellationReady,onProviderTerminal,
      onBackgroundWait,onBackgroundReportMissing,onBackgroundReleaseReady,onProviderRetry,onRetryRestartReady,onInputAcknowledged,onPreferredModel,...data}=prepared as any;
    retainExecutionIntent({executionId,turnId:claim.turn_id,dispatchAttempt:claim.dispatch_attempt,sessionId:session.id,provider:session.provider_id,
      directory:executionDirectory(stateDir,executionId),coordinatorInstanceId:this.options.instanceId,processor:{...kept,run:data}});
    return {...prepared,transport:this.hostedTransport('launch',executionId,stateDir,executable)} as any;
  }
  private adoptedRun(prepared:Parameters<AgentProvider['run']>[0],adoption:Adoption,executable?:string):Parameters<AgentProvider['run']>[0] {
    const stateDir=realpathSync(process.env.CONCIERGE_STATE_DIR!);
    return {...prepared,...adoption.processor.run,adopted:true,
      ...(executable===MANAGED_CODEX?{legacyPrivateCodex:true}:{}),
      onRecoveredSteering:(clientMessageId:string,outcome:'acknowledged'|'unacknowledged')=>this.recoveredSteering(clientMessageId,outcome),
      transport:this.hostedTransport(adoption.mode,adoption.execution.execution_id,stateDir,executable)} as any;
  }
  private trackedCodexRun(prepared:Parameters<AgentProvider['run']>[0],claim:QueuedTurnClaimRow,session:SessionRow,
    kept:{replayPrompt:string;runAdditionalDirs:string[];staging:string|null;account:{account:string;home:string|null}|null}):Parameters<AgentProvider['run']>[0] {
    const {onProgress,onProviderMessage,onProviderThreadStarted,onProviderTurnStarted,onSteeringReady,onCancellationReady,onProviderTerminal,
      onBackgroundWait,onBackgroundReportMissing,onBackgroundReleaseReady,onProviderRetry,onRetryRestartReady,onInputAcknowledged,onPreferredModel,onRateLimits,...data}=prepared as any;
    const executionId=newExecutionId();
    retainExecutionIntent({executionId,turnId:claim.turn_id,dispatchAttempt:claim.dispatch_attempt,sessionId:session.id,provider:'codex',
      directory:'',coordinatorInstanceId:this.options.instanceId,supervisor:'codex-daemon',processor:{...kept,run:data}});
    // The daemon's hooks carry no run of their own: file this release's helpers under the Codex
    // conversation before its turn starts, so they stay the same if an update installs mid-turn.
    const stateDir=realpathSync(process.env.CONCIERGE_STATE_DIR!),botDir=providerOwnerEnvironment().CONCIERGE_ROUTER_BOT_DIR;
    return {...prepared,onProviderThreadStarted:(threadId:string)=>{
      try{if(botDir)pinCodexThreadHooks(stateDir,threadId,executionId,botDir);}
      catch(error){log('warn','codex_hook_pin_failed',{execution_id:executionId,...errorFields(error)});}
      onProviderThreadStarted?.(threadId);
    }} as any;
  }
  /** Follow the daemon's turn by its exact thread and turn; never start one (design §4.2). */
  private adoptedCodexRun(prepared:Parameters<AgentProvider['run']>[0],adoption:Adoption,session:SessionRow):Parameters<AgentProvider['run']>[0] {
    const current=getSessionById(session.id)!;
    const turn=db.query('SELECT provider_turn_id FROM turns WHERE id=?').get(adoption.claim.turn_id) as {provider_turn_id:string|null}|null;
    if(!current.agent_session_uuid)throw new ProviderDispatchError({message:'The Codex thread this run started is unknown; it cannot be followed.',terminalConfirmed:false,toolsUsed:[]});
    const sending=(db.query(`SELECT input.id FROM turn_steering_messages steering JOIN session_inputs input ON input.steering_id=steering.id
      WHERE steering.turn_id=? AND steering.status='sending'`).all(adoption.claim.turn_id) as {id:string}[]).map(row=>row.id);
    return {...prepared,...adoption.processor.run,
      adoptTurn:{threadId:current.agent_session_uuid,turnId:turn?.provider_turn_id??null},
      recoveredSteeringClientIds:sending,
      onAdoptedLive:()=>recordLiveAdoption(adoption.execution.execution_id),
      onRecoveredSteering:(clientMessageId:string,outcome:'acknowledged'|'unacknowledged')=>this.recoveredSteering(clientMessageId,outcome)} as any;
  }
  private hostedTransport(mode:'launch'|'adopt'|'adopt-record',executionId:string,stateDir:string,executable?:string) {
    // From the owner, not the run's environment: an information-only consultation runs without it.
    const routerBotDir=providerOwnerEnvironment().CONCIERGE_ROUTER_BOT_DIR;
    return new HostedClaudeCodeTransport({mode,executionId,stateDir,routerBotDir,executable:executable??claudeExecutable(),
      onLaunched:launch=>recordExecutionLaunched(executionId,launch),
      onAttached:status=>{
        log('info','execution_host_attached',{execution_id:executionId,mode,host_pid:status.hostPid,provider_pid:status.providerPid,replayed:status.until,provider_running:!status.exit});
        if(mode==='adopt'&&!status.exit)recordLiveAdoption(executionId);
      },
      onExited:exit=>recordExecutionExited(executionId,exit)});
  }
  private retainAdmission(claim:QueuedTurnClaimRow,input:AcceptedSessionInput,session:SessionRow,actual:Parameters<AgentProvider['run']>[0],attachments:ReturnType<SessionOwner['attachments']>) {
    const current=getSessionById(session.id)!,metadata=sessionMetadata(current);
    const owned=db.query("SELECT provider_admission_intended_at FROM turns WHERE id=? AND session_id=? AND owner_instance_id=? AND dispatch_attempt=? AND status='running' AND stop_requested_at IS NULL")
      .get(claim.turn_id,session.id,this.options.instanceId,claim.dispatch_attempt) as any;
    if(!owned?.provider_admission_intended_at||current.binding_generation!==session.binding_generation||current.status==='archived'||metadata.suspended)throw new ProviderCapabilityUnavailableError('send','The exact owner admission is no longer current.');
    const saved=JSON.parse(getAcceptedSessionInput(input.id)!.receipt_json??'{}');
    const admission={provider:session.provider_id,purpose:metadata.purpose??'chat',inputId:input.id,runId:nativeRunId(claim.turn_id),bindingGeneration:session.binding_generation??1,
      admittedAt:saved.admission?.admittedAt??new Date().toISOString(),promptHash:createHash('sha256').update(actual.prompt).digest('hex'),model:actual.model??null,
      // A file's pin is its custody identity: id, name, type and digest. An audio transcript is the
      // owner's own derived text, not part of the file, and Thinkering's ChatGPT capability refuses
      // any field outside the pin, so every ChatGPT send with a file failed once transcripts were
      // added to attachment rows (found 2026-10-09).
      attachments:attachments.map(({base64,transcriptText,...pin})=>pin),policy:metadata.interactionPolicy??'standard',nativeBinding:metadata.nativeBinding??null};
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

/**
 * The kept Codex login to move to when the one in use has spent an allowance window: the account
 * in use is read from the login on disk, never from the reading, so a reading taken before a move
 * cannot send the machine back. Among accounts with room in every window, the least used wins.
 */
function codexAccountWithRoomWhileInUseIsSpent():{label:string;source:string}|null{
  const inUse=currentAccount('codex')?.label;
  const usage=storedUsage('codex');
  if(!inUse||!usage)return null;
  const current=usage.accounts.find(account=>account.label===inUse);
  if(!current||current.problem||!current.windows.some(window=>window.usedPercent>=100))return null;
  const used=(account:{windows:readonly {usedPercent:number}[]})=>Math.max(...account.windows.map(window=>window.usedPercent));
  const room=usage.accounts.filter(account=>account.label!==inUse&&!account.problem&&!account.signedOut&&account.windows.length>0
    &&account.windows.every(window=>window.usedPercent<100)).sort((a,b)=>used(a)-used(b));
  const profiles=listProfiles('codex');
  for(const account of room){
    const profile=profiles.find(each=>each.label===account.label);
    const source=profile?codexProfileSource(profile.id):null;
    if(source)return {label:account.label,source};
  }
  return null;
}
