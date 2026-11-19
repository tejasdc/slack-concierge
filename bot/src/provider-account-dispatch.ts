import {existsSync,lstatSync,mkdirSync,readdirSync,readlinkSync,realpathSync,renameSync,symlinkSync,unlinkSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {chooseAccountForTurn,type AccountReason} from './provider-account-choice';
import {accountHome,currentAccount,keptProfileCount,listProfiles,profileId,type AccountIdentityProvider,type ProviderKey} from './provider-accounts';
import {providerAccountUsage} from './provider-account-usage';
import {accountReadingFresh,hasActiveFullAllowanceWindow,includedAllowanceWindows} from './account-allowance-observation';
import type {AccountUsage,ProviderUsage} from './provider-account-usage';
import type {AccountRoom} from './provider-account-choice';
import {ProviderDispatchError} from './provider-failures';
import {canTakeWork} from './account-authority';
import {claudeAccountCachedReset,releaseUsageHeldWork} from './provider-usage';
import {claudeAccountSelection,claudeHomeProven,claudeHomeSignedOut,recordClaudeHomeProof,recordClaudeHomeSignedOut} from './provider-account-selection';
import {log} from './log';
import {releaseUsageContinuationHolds} from './state';
import {accountFilesView,forgetAccountFiles} from './account-files-memo';
import {accountAvailability} from './provider-usage-forecast';
import {claudeKeychainMayHoldLogin} from './claude-keychain';
import {needClaudeSignInRenewal} from './signin-renewal';
import {claudeAccountWorks,releaseAuthHold} from './provider-activation';
import {providerRunnerTarget} from './provider-runner-target';
import {providerAccountHomeForPlacement} from './provider-account-home';
import {CLAUDE_SCRATCH,isClaudePerLogin} from './claude-home-entries';

/**
 * What an extra Claude home keeps for itself: its own login and the per-login state Claude writes
 * beside it. Everything else in the default home (settings and allowed commands, global
 * instructions, hooks, skills, agents, plugins, conversation history and memory) is the machine's
 * one shared set, and an extra home only links to it. Claude reads all of that from the folder it
 * starts in, so a home that only linked history ran agents with no settings: on 2026-10-07 every
 * command needed an approval nobody could give, for ten minutes after a switch that "worked".
 */
// Which entries are per-login and which are scratch lives in claude-home-entries.ts, shared with runners.
const isPerLogin=isClaudePerLogin;
const SCRATCH=CLAUDE_SCRATCH;

/**
 * The home an extra Claude account launches from, or null when it is not a complete view of the
 * shared set. `prepare` adds missing links, and on an explicit switch or sign-in (`claim`) moves a
 * conflicting private copy of a shared (non-scratch) entry aside into `.unlinked-<time>/` (kept,
 * never deleted) so the link can take its place. A home that is still incomplete is never chosen,
 * and says which entries it lacks: failing closed, out loud, is the invariant.
 */
/**
 * Whether a Claude home holds a login. On Linux that is its `.credentials.json`; on a Mac, Claude
 * keeps an extra home's login in the login Keychain under "Claude Code-credentials-" plus the first
 * eight hex digits of the SHA-256 of the home's path, and writes no file (seen 2026-10-07, design
 * §0.1). The Keychain is asked only whether that item exists; its secret is never read.
 */
export function claudeHomeHasLogin(home:string):boolean {
  return existsSync(join(home,'.credentials.json'))||claudeKeychainMayHoldLogin(home);
}

export function sharedClaudeHome(account:string,home=accountHome('claude-code',profileId(account)),prepare=false,claim=prepare):string|null {
  if(!prepare)return accountFilesView(`claude-home:${account}:${home}`,()=>inspectClaudeHome(account,home,false,false));
  forgetAccountFiles();
  try {return inspectClaudeHome(account,home,prepare,claim);}
  finally {forgetAccountFiles();}
}
function inspectClaudeHome(account:string,home:string,prepare:boolean,claim:boolean):string|null {
  let names:string[];
  try {
    if(!claudeHomeHasLogin(home))return null;
    const shared=join(homedir(),'.claude');
    if(realpathSync(home)===realpathSync(shared))return null;
    names=readdirSync(shared);
  } catch {return null;}
  const shared=join(homedir(),'.claude'),missing:string[]=[];
  let aside:string|null=null;
  for(const name of names){
    if(isPerLogin(name))continue;
    try {
      const source=realpathSync(join(shared,name)),target=join(home,name);
      let present:string|null=null;
      try {present=realpathSync(target);} catch {present=null;}
      const wanted=join(shared,name);
      if(present===source){
        // A link resolved to today's destination would miss a later change to the shared entry.
        if(claim&&isLink(target)&&readlinkSync(target)!==wanted){unlinkSync(target);symlinkSync(wanted,target);}
        continue;
      }
      const exists=present!==null||isLink(target);
      if(SCRATCH.has(name)){if(prepare&&!exists)symlinkSync(join(shared,name),target);continue;}
      if(prepare&&exists&&claim){
        aside??=join(home,`.unlinked-${Date.now()}`);
        mkdirSync(aside,{recursive:true,mode:0o700});
        renameSync(target,join(aside,name));
      }
      if(prepare&&(!exists||claim)){symlinkSync(join(shared,name),target);continue;}
      missing.push(name);
    } catch(error) {
      // A shared entry that cannot be resolved (a dangling link in the default home) is not
      // something this account could have used either, so it does not disqualify the account.
      if(!existsSync(join(shared,name)))continue;
      missing.push(name);
    }
  }
  const said=missing.join(',');
  if(incompleteSaid.get(home)!==said){
    incompleteSaid.set(home,said);
    if(missing.length)log('warn','claude_account_home_incomplete',{account,missing:missing.slice(0,20)});
  }
  return missing.length?null:home;
}
const incompleteSaid=new Map<string,string>();

/**
 * Extra homes proven to do work: a passing account check (the switch's, or a background one), or a
 * real turn that finished from that home. Automatic moves only go to a proven home. On 2026-10-07
 * the chooser moved work for room onto a home holding an expired login, and every turn failed until
 * he signed in; GPT-6 Astra's review made this the first blocker. Proof is withdrawn by a sign-in
 * refusal from that home and by a new login being filed into it. It is process state: after a
 * restart each home proves itself again, once, in the background.
 */
const provenHomes=new Set<string>();
const proving=new Set<string>();
/** A home that just failed is not checked again for this long, so a dead login costs one check, not one per turn. */
const RECHECK_AFTER_FAILURE_MS=10*60_000;
const failedAt=new Map<string,number>();
export function markClaudeHomeVerified(home:string|null){if(home){provenHomes.add(home);failedAt.delete(home);recordClaudeHomeSignedOut(home,false);recordClaudeHomeProof(home,true);}}
/** A failed check or turn. Only a sign-in refusal (`signedOut`) records the home as waiting for a sign-in. */
export function markClaudeHomeRefused(home:string|null,signedOut=true){if(home){provenHomes.delete(home);failedAt.set(home,Date.now());if(signedOut)recordClaudeHomeSignedOut(home,true);recordClaudeHomeProof(home,false);}}
/** A newly filed login or an explicit switch starts the home's evidence over. */
export function forgetClaudeHomeCheck(home:string|null){if(home){provenHomes.delete(home);failedAt.delete(home);recordClaudeHomeSignedOut(home,false);recordClaudeHomeProof(home,false);}}
function provenOrProve(account:string,home:string):boolean{
  if(provenHomes.has(home))return true;
  if(claudeHomeProven(home)){provenHomes.add(home);return true;}
  if(Date.now()-(failedAt.get(home)??0)<RECHECK_AFTER_FAILURE_MS)return false;
  if(!proving.has(home)){
    proving.add(home);
    void claudeAccountWorks(home,account).then(check=>{
      // Work held because no account had room may now have one: release it to try again.
      if(check.ok){markClaudeHomeVerified(home);releaseUsageContinuationHolds('claude-code');releaseUsageHeldWork('claude-code');releaseAuthHold('claude-code','home_proven');}
      else {
        failedAt.set(home,Date.now());if(check.reason==='signed_out')recordClaudeHomeSignedOut(home,true);
        log('warn','claude_account_home_unproven',{account,reason:check.reason});
        if(check.reason==='signed_out')needClaudeSignInRenewal(account,'the background account check found it signed out');
      }
    }).catch(()=>{}).finally(()=>proving.delete(home));
  }
  return false;
}
/**
 * Proves every complete account home that lacks proof, in the background, whenever usage is read,
 * so the account with room is already eligible when the one in use runs out. Proving only at the
 * moment of need held six turns at 2:54 AM on 2026-10-08 for the forty seconds the check took.
 */
export function proveClaudeHomesAhead(accounts:readonly string[]):void{
  if(providerRunnerTarget('claude-code'))return;
  for(const account of accounts){
    const home=sharedClaudeHome(account,undefined,false,false);
    if(home)provenOrProve(account,home);
  }
}
/**
 * Whether work can run from this account on this machine now: its own home is complete and proven, or
 * it is the selected account and has not just been refused. A usage reading with room is not that: the
 * usage reader holds its own copy of each login, so on 2026-11-02 the Mac's tejas@chann.app read 54%
 * free while its home was signed out, and the hold notice promised work would "move to it by itself".
 */
export function claudeAccountLaunchableHere(account:string):boolean{
  if(providerRunnerTarget('claude-code'))return providerAccountUsage('claude-code')?.accounts.some(item=>item.label===account&&item.signedOut!==true)??false;
  if(!claudeRunsFromOwnHomes())return true;
  const home=sharedClaudeHome(account,undefined,false,false);
  if(!home)return false;
  if(provenHomes.has(home)||claudeHomeProven(home))return true;
  if(claudeHomeSignedOut(home)||Date.now()-(failedAt.get(home)??0)<RECHECK_AFTER_FAILURE_MS){provenOrProve(account,home);return false;}
  return account===selectedClaudeHome()?.label||provenOrProve(account,home);
}
/**
 * Whether this account's own home on this machine was last seen signed out (by a turn's sign-in refusal or
 * a background check), and no check has passed since. Narrower than not launchable: an incomplete home,
 * a timeout or a wrong account is not a sign-in, and must not hold work that could move elsewhere.
 */
export function claudeAccountAwaitingSignIn(account:string):boolean{
  if(!claudeRunsFromOwnHomes())return false;
  if(providerRunnerTarget('claude-code'))return providerAccountUsage('claude-code')?.accounts.some(item=>item.label===account&&item.signedOut===true)??false;
  const profile=listProfiles('claude-code').find(item=>item.label===account);
  return !!profile&&claudeHomeSignedOut(accountHome('claude-code',profile.id));
}
function isLink(path:string):boolean {try {return lstatSync(path).isSymbolicLink();} catch {return false;}}

/** Homes with credentials that this owner can use without switching a live login. */
function accountUsedPercent(provider:AccountIdentityProvider,account:AccountUsage,model?:string|null):number|null {
  if(provider==='claude-code'&&claudeAccountCachedReset(account.label,model))return 100;
  const windows=includedAllowanceWindows(provider,account,model);
  return windows.length?Math.max(...windows.map(window=>window.usedPercent)):null;
}

/**
 * Whether Claude work on this machine runs only from accounts' own homes.
 *
 * The main folder's login (`~/.claude/.credentials.json`) is whatever was last signed in there,
 * and anyone typing `claude auth login` or `/login` in a terminal replaces it, destroying the
 * login that was there: Claude keeps no second copy. At 19:31 UTC on 2026-10-07 a hand sign-in
 * as tejas@chann.app replaced his personal account that way, and his personal account dropped out
 * of agents' work with nothing said. So once this machine keeps any account in a home of its own
 * (Accounts files every sign-in into one), agents never run on the main folder's login: it is the
 * terminal's, and a hand sign-in there can only displace the terminal's account. A machine whose
 * logins are not files (the Mac keeps them in the Keychain) has no such homes and is unchanged.
 */
export function claudeRunsFromOwnHomes():boolean {
  return !!providerRunnerTarget('claude-code')||keptProfileCount('claude-code')>0;
}

/** The account selected for agents and its home, when that is one of the homes (never the main folder's login). */
export function selectedClaudeHome(runnerTarget:string|null|undefined=undefined):{label:string;home:string}|null {
  const selection=claudeAccountSelection();
  if(!selection||selection.profileId==='default')return null;
  const target=runnerTarget===undefined?providerRunnerTarget('claude-code'):runnerTarget;
  const localHome=accountHome('claude-code',selection.profileId);
  return {label:selection.label,home:providerAccountHomeForPlacement(target,selection.label,localHome)};
}

/** The home a Claude account launches from: the selected account's complete home, or another proven one. */
function launchableClaudeHome(account:string,selected:string|null,prepare:boolean,home?:string,runnerTarget:string|null|undefined=undefined):string|null {
  // A peer can supply this account's allowance, but only this machine can establish
  // whether its own home is signed in. The selected-home exception honors that verdict.
  const reading=providerAccountUsage('claude-code')?.accounts.find(item=>item.label===account);
  if(reading?.signedOut===true)return null;
  if(runnerTarget===undefined?providerRunnerTarget('claude-code'):!!runnerTarget){
    return providerAccountHomeForPlacement(runnerTarget===undefined?providerRunnerTarget('claude-code'):runnerTarget,account,home??'');
  }
  const complete=sharedClaudeHome(account,home,prepare,false);
  // The selected account was proven when he chose it and stays his choice across restarts; a
  // sign-in refusal from it holds the work for a sign-in. Proof only gates automatic moves.
  return complete&&(account===selected||provenOrProve(account,complete))?complete:null;
}

export function savedWorkAccountRooms(provider:AccountIdentityProvider,usage:ProviderUsage,now=Date.now(),model?:string|null,runnerTarget:string|null|undefined=undefined):AccountRoom[] {
  // Codex turns all use the shared daemon. Other homes are read for usage and kept for
  // switching, but a banked turn cannot launch against one without changing that daemon.
  if(provider==='codex'||provider==='antigravity'){
    const active=currentAccount(provider)?.label??(provider==='codex'&&providerRunnerTarget('codex')?usage.accounts.find(item=>item.current)?.label:null);
    const account=usage.accounts.find(item=>item.label===active);
    if(!account)return [];
    const fresh=accountReadingFresh(provider,usage,account,now,undefined,model);
    return [{account:account.label,home:null,isDefault:true,
      tightestUsedPercent:fresh?accountUsedPercent(provider,account,model):null,
      problem:!fresh?'Usage reading is stale.':account.problem}];
  }
  const ownHomes=provider==='claude-code'&&claudeRunsFromOwnHomes();
  const claudeRunner=runnerTarget===undefined?providerRunnerTarget('claude-code'):runnerTarget;
  if(provider==='claude-code'&&claudeRunner){
    return usage.accounts.map(account=>({account:account.label,home:`runner-account:${account.label}`,isDefault:false,
      tightestUsedPercent:accountReadingFresh(provider,usage,account,now,undefined,model)?accountUsedPercent(provider,account,model):null,
      problem:accountReadingFresh(provider,usage,account,now,undefined,model)?account.problem:'Usage reading is stale.'}));
  }
  const defaultLabel=ownHomes?null:currentAccount(provider)?.label;
  const selected=provider==='claude-code'?selectedClaudeHome(runnerTarget)?.label??null:null;
  const profiles=listProfiles(provider);
  return usage.accounts.map(account=>{
    const isDefault=account.label===defaultLabel;
    const profile=profiles.find(item=>item.label===account.label);
    const home=isDefault?null:profile?accountHome(provider,profile.id):null;
    const ready=home&&launchableClaudeHome(account.label,selected,false,home,runnerTarget)===home;
    const fresh=accountReadingFresh(provider,usage,account,now,undefined,model);
    return {account:account.label,home:ready?home:null,isDefault,
      tightestUsedPercent:fresh?accountUsedPercent(provider,account,model):null,
      problem:!fresh?'Usage reading is stale.':account.problem};
  });
}

/**
 * Whether a Claude account other than `refused` has confirmed room now. Dispatch may allow an
 * unreadable selected login one provider attempt, but that permission cannot support a room claim.
 */
export function claudeAccountWithRoomBesides(refused:string|null,model?:string|null):boolean{
  try {
    const next=chooseClaudeDispatch(refused,0,undefined,model);
    return !!next&&next.account!==refused
      &&accountAvailability('claude-code',model).some(account=>account.account===next.account&&account.hasRoom);
  } catch { return false; }
}

/**
 * Whether usage-held Claude work can be released now: dispatch would run it on an account whose
 * latest good reading shows room, fresh or not. A hold made while that account looked unreadable
 * must not wait for a fresh reading the release check alone could accept.
 */
export function claudeHeldWorkCanRun(model?:string|null):boolean{
  if(claudeAccountWithRoomBesides(null,model))return true;
  try {
    const next=chooseClaudeDispatch(null,0,undefined,model);
    const reading=next?providerAccountUsage('claude-code')?.accounts.find(account=>account.label===next.account):null;
    const used=reading&&!reading.problem&&!reading.signedOut?accountUsedPercent('claude-code',reading,model):null;
    return used!==null&&used<100;
  } catch { return false; }
}

/** Bring a peer-discovered account with room into this machine's own login path. */
export function requestMissingClaudeHomes(model?:string|null):void{
  if(!claudeRunsFromOwnHomes()||providerRunnerTarget('claude-code'))return;
  const local=new Set(listProfiles('claude-code').map(profile=>profile.label));
  for(const room of accountAvailability('claude-code',model))
    if(room.hasRoom&&!local.has(room.account))
      needClaudeSignInRenewal(room.account,'This account has room but has not been signed in on this machine.');
}

/**
 * When every Claude account this machine can launch is spent, the earliest moment one frees up,
 * by the same rules dispatch uses; null when one can run now or no reset is known.
 */
export function claudeEveryAccountClearsAt(model?:string|null):number|null{
  try { chooseClaudeDispatch(null,0,undefined,model); return null; }
  catch(error) { return error instanceof ProviderDispatchError?error.clearsAtMs:null; }
}

// A successful manual check is proof for the exact waiting turns it released. Account usage
// readings can still be stale at 100%; these one-shot entries let those turns reach Claude once.
const provenWaitingTurns=new Map<number,{account:string;selectionRevision:number}>();
export function admitProvenClaudeWaitingTurn(turnId:number,account:string,selectionRevision:number):void {
  provenWaitingTurns.set(turnId,{account,selectionRevision});
}

/** Held for a sign-in, never run on the main folder's login instead (the message is a sign-in refusal on purpose). */
const noOwnClaudeLogin=()=>new ProviderDispatchError({failureClass:'parked_access',terminalConfirmed:true,
  message:'Not logged in: no Claude account on this machine has a working sign-in of its own. Sign in to one in Accounts.'});

/**
 * Pick a Claude account for this turn. Collapsed in 2026-11-19 from 9 gates to a thin
 * filter+rank over `canTakeWork`. The ranker is `chooseAccountForTurn` which preserves:
 *
 *   - 2026-10-07 — "where accounts have homes of their own, the main folder's login is
 *     the terminal's; agents never run on it" (`claudeRunsFromOwnHomes`).
 *   - 2026-10-09 — "selected account out, so with only that one free it read as 'no
 *     account has room'" → eligible set always includes the selected account.
 *   - 2026-10-15 — "an old reading is not a limit; a launchable account whose last
 *     reading showed room is tried" → authority's `last-showed-room` branch admits it.
 *   - 2026-10-30 — "Anthropic removes the 5-hour window from Ultra accounts; a reading
 *     without it must still show room" → `includedAllowanceWindows` tolerates it.
 *   - 2026-11-02 — "Mac's tejas@chann.app read 54% free while its home was signed out,
 *     and the hold notice promised work would 'move to it by itself'" → authority's
 *     `no-home`/`signed-out` branches exclude such accounts from the eligible set.
 *   - 2026-11-15 — "warm account stays while its own pressure is at least half the best
 *     one's" (WARM_STAY_BAND) → preserved by `chooseAccountForTurn`.
 *   - 2026-11-16 — "aggregated usage per provider, not per single account" → ranker
 *     uses lapse pressure, not just per-account percentage.
 *   - 2026-11-19 — F1: Opus-only refusal does not block Sonnet/Haiku turns, because
 *     the `canTakeWork` call is model-specific. F7: cross-provider recovery uses the
 *     authority, not `/usage` percentages.
 */
export function chooseClaudeDispatch(prefer:string|null,seenSelectionRevision=0,turnId?:number,model?:string|null,warmCacheAccount?:string|null,runnerTarget:string|null|undefined=undefined):{account:string;home:string|null;because:AccountReason;expected:string|null;selectionRevision:number}|null {
  const proof=turnId===undefined?null:provenWaitingTurns.get(turnId)??null;
  if(turnId!==undefined)provenWaitingTurns.delete(turnId);
  const usage=providerAccountUsage('claude-code');
  const ownHomes=claudeRunsFromOwnHomes();
  const defaultAccount=ownHomes?null:currentAccount('claude-code')?.label??usage?.accounts.find(account=>account.current)?.label??null;
  const selection=claudeAccountSelection();
  const provenAccount=proof&&proof.selectionRevision===(selection?.revision??0)?proof.account:null;
  const selectedAccount=selection&&selection.revision>seenSelectionRevision?selection.label:null;
  const selected=selectedClaudeHome(runnerTarget)?.label??null;
  const expected=selectedAccount??prefer??selection?.label??defaultAccount;
  const selectionRevision=selection?.revision??0;
  const resolvedModel=model??'claude-opus-5-5';
  // Own-homes with no reading yet: the operator-selected home gets one attempt via proof.
  if(ownHomes&&(!usage||(selected&&!usage.accounts.some(account=>account.label===selected)))){
    const home=selected?launchableClaudeHome(selected,selected,true,undefined,runnerTarget):null;
    if(home&&!claudeAccountCachedReset(selected!,model))
      return {account:selected!,home,because:'stayed-on-its-account',expected:selected,selectionRevision};
    if(!usage){
      const refusedUntil=selected?claudeAccountCachedReset(selected,model):null;
      if(home&&refusedUntil)throw new ProviderDispatchError({message:'This Claude account has a recorded model refusal.',
        failureClass:'parked_terminal',terminalConfirmed:true,clearsAtMs:refusedUntil});
      throw noOwnClaudeLogin();
    }
  }
  if(!usage||(!ownHomes&&!defaultAccount))return null;
  const rooms=savedWorkAccountRooms('claude-code',usage,Date.now(),model,runnerTarget);
  if(ownHomes&&!rooms.some(r=>r.home||r.isDefault))throw noOwnClaudeLogin();
  // Proof-admitted turn: the manual Accounts check released this exact turn against the proved account.
  const proved=provenAccount?rooms.find(r=>r.account===provenAccount&&(r.home||r.isDefault)
    &&!claudeAccountCachedReset(r.account,model)):null;
  if(proved)return {account:proved.account,home:proved.home,
    because:proved.account===expected?'stayed-on-its-account':'moved-for-room',expected,selectionRevision};
  // Authority-filtered eligibility. The ranker then picks by selection/warmth/room.
  const now=Date.now();
  const authorityOk=(account:string)=>{
    const verdict=canTakeWork('claude-code',{provider:'claude-code',label:account},resolvedModel,now);
    return verdict.ok;
  };
  const eligibleRooms=rooms.filter(r=>(r.home||r.isDefault)&&!claudeAccountCachedReset(r.account,model)&&authorityOk(r.account));
  const choice=chooseAccountForTurn({accounts:eligibleRooms.length?eligibleRooms:rooms,bound:null,prefer:expected,newlySelected:!!selectedAccount,warmCacheAccount});
  if(choice.account!==null)return {account:choice.account,home:choice.home,because:choice.because,expected,selectionRevision};
  // Fallthrough — nothing eligible. Give the selected home one admitted attempt if its verdict
  // says the only block is "unknown"/"last-showed-room"/"proven-attempt" (hold-worthy but not refused).
  const attemptRoom=rooms.find(r=>{
    if(r.account!==selected||!r.home||claudeAccountCachedReset(r.account,model))return false;
    const verdict=canTakeWork('claude-code',{provider:'claude-code',label:r.account},resolvedModel,now);
    return verdict.ok||verdict.reason==='unknown'||verdict.reason==='last-showed-room'||verdict.reason==='proven-attempt';
  });
  if(attemptRoom)return {account:attemptRoom.account,home:attemptRoom.home,because:'stayed-on-its-account',expected,selectionRevision};
  // Nobody can run. Ask the browser repair agent to establish any peer-discovered account.
  if(ownHomes&&turnId!==undefined)requestMissingClaudeHomes(model);
  // Earliest clearsAtMs across the eligible home set, from the authority.
  const clearsAts=rooms.filter(r=>r.home||r.isDefault).flatMap(r=>{
    const v=canTakeWork('claude-code',{provider:'claude-code',label:r.account},resolvedModel,now);
    return v.clearsAtMs!==null?[v.clearsAtMs]:[];
  });
  throw new ProviderDispatchError({message:'Every available Claude account is out of room.',failureClass:'parked_terminal',
    terminalConfirmed:true,clearsAtMs:clearsAts.length?Math.min(...clearsAts):null});
}
