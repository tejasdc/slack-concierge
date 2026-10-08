import {existsSync,lstatSync,mkdirSync,readdirSync,readlinkSync,realpathSync,renameSync,symlinkSync,unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {chooseAccountForTurn,type AccountReason} from './provider-account-choice';
import {accountHome,currentAccount,keptProfileCount,listProfiles,profileId,type ProviderKey} from './provider-accounts';
import {providerAccountUsage} from './provider-account-usage';
import type {AccountUsage,ProviderUsage} from './provider-account-usage';
import type {AccountRoom} from './provider-account-choice';
import {ProviderDispatchError} from './provider-failures';
import {claudeAccountCachedReset,releaseUsageHeldWork} from './provider-usage';
import {claudeAccountSelection,claudeHomeProven,recordClaudeHomeProof} from './provider-account-selection';
import {log} from './log';
import {claudeAccountWorks,releaseAuthHold} from './provider-activation';

/**
 * What an extra Claude home keeps for itself: its own login and the per-login state Claude writes
 * beside it. Everything else in the default home (settings and allowed commands, global
 * instructions, hooks, skills, agents, plugins, conversation history and memory) is the machine's
 * one shared set, and an extra home only links to it. Claude reads all of that from the folder it
 * starts in, so a home that only linked history ran agents with no settings: on 2026-10-07 every
 * command needed an approval nobody could give, for ten minutes after a switch that "worked".
 */
// Per-login also covers what Claude stamps with the signed-in account and deletes at logout
// (remote settings and policy limits), so one account never reads another's.
// It also covers sign-in state and the locks Claude takes while it renews a login (`.storage-write`,
// `.oauth_refresh.lock*`): linking a lock to the main folder's would tie this account's renewals to
// whatever a terminal there is doing, and a lock that happened to exist during a switch would be
// left dangling (GPT-6 Astra's stand-in review, 2026-10-07).
const PER_LOGIN=new Set(['.credentials.json','.claude.json','.claude.json.lock','.account-email','backups',
  'remote-settings.json','policy-limits.json','policy-limits.json.stamp.json',
  'hfi-auth.json','.session_ingress_token','.storage-write']);
const isPerLogin=(name:string)=>PER_LOGIN.has(name)||/^\.(credentials|claude)\.json\./.test(name)||/^\.oauth_refresh\.lock/.test(name);
/**
 * Runtime scratch Claude recreates per process. Shared when possible, but a private copy is
 * harmless and is never moved: a live process may be using it (one was, at the 19:40 repair on
 * 2026-10-07).
 */
const SCRATCH=new Set(['sessions','session-env','shell-snapshots','cache','statsig','paste-cache','.last-cleanup',
  '.last-update-result.json','mcp-needs-auth-cache.json','teams','jobs','daemon']);

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
  if(existsSync(join(home,'.credentials.json')))return true;
  if(process.platform!=='darwin')return false;
  const service=`Claude Code-credentials-${createHash('sha256').update(home.replace(/\/+$/,'')).digest('hex').slice(0,8)}`;
  return spawnSync('/usr/bin/security',['find-generic-password','-s',service],{stdio:'ignore',timeout:5_000}).status===0;
}

export function sharedClaudeHome(account:string,home=accountHome('claude-code',profileId(account)),prepare=false,claim=prepare):string|null {
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
export function markClaudeHomeVerified(home:string|null){if(home){provenHomes.add(home);failedAt.delete(home);recordClaudeHomeProof(home,true);}}
export function markClaudeHomeRefused(home:string|null){if(home){provenHomes.delete(home);failedAt.set(home,Date.now());recordClaudeHomeProof(home,false);}}
/** A newly filed login or an explicit switch starts the home's evidence over. */
export function forgetClaudeHomeCheck(home:string|null){if(home){provenHomes.delete(home);failedAt.delete(home);recordClaudeHomeProof(home,false);}}
function provenOrProve(account:string,home:string):boolean{
  if(provenHomes.has(home))return true;
  if(claudeHomeProven(home)){provenHomes.add(home);return true;}
  if(Date.now()-(failedAt.get(home)??0)<RECHECK_AFTER_FAILURE_MS)return false;
  if(!proving.has(home)){
    proving.add(home);
    void claudeAccountWorks(home,account).then(check=>{
      // Work held because no account had room may now have one: release it to try again.
      if(check.ok){markClaudeHomeVerified(home);releaseUsageHeldWork('claude-code');releaseAuthHold('claude-code','home_proven');}
      else {failedAt.set(home,Date.now());log('warn','claude_account_home_unproven',{account,reason:check.reason});}
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
  for(const account of accounts){
    const home=sharedClaudeHome(account,undefined,false,false);
    if(home)provenOrProve(account,home);
  }
}
function isLink(path:string):boolean {try {return lstatSync(path).isSymbolicLink();} catch {return false;}}

/** An extra Codex process must see the same conversation files as the default daemon. */
function sharedCodexHome(home:string):string|null {
  if(!existsSync(join(home,'auth.json')))return null;
  const sessions=join(homedir(),'.codex','sessions'),borrowed=join(home,'sessions');
  try {
    if(!existsSync(sessions))return null;
    if(!existsSync(borrowed))symlinkSync(sessions,borrowed,'dir');
    return realpathSync(borrowed)===realpathSync(sessions)?home:null;
  } catch {return null;}
}

/** Homes with credentials that this owner can use without switching a live login. */
function accountUsedPercent(provider:ProviderKey,account:AccountUsage):number|null {
  if(provider==='claude-code'&&claudeAccountCachedReset(account.label))return 100;
  return account.windows.length?Math.max(...account.windows.map(window=>window.usedPercent)):null;
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
  return keptProfileCount('claude-code')>0;
}

/** The account selected for agents and its home, when that is one of the homes (never the main folder's login). */
export function selectedClaudeHome():{label:string;home:string}|null {
  const selection=claudeAccountSelection();
  if(!selection||selection.profileId==='default')return null;
  return {label:selection.label,home:accountHome('claude-code',selection.profileId)};
}

/** The home a Claude account launches from: the selected account's complete home, or another proven one. */
function launchableClaudeHome(account:string,selected:string|null,prepare:boolean,home?:string):string|null {
  const complete=sharedClaudeHome(account,home,prepare,false);
  // The selected account was proven when he chose it and stays his choice across restarts; a
  // sign-in refusal from it holds the work for a sign-in. Proof only gates automatic moves.
  return complete&&(account===selected||provenOrProve(account,complete))?complete:null;
}

export function savedWorkAccountRooms(provider:ProviderKey,usage:ProviderUsage,now=Date.now()):AccountRoom[] {
  const ownHomes=provider==='claude-code'&&claudeRunsFromOwnHomes();
  const defaultLabel=ownHomes?null:currentAccount(provider)?.label;
  const selected=provider==='claude-code'?selectedClaudeHome()?.label??null:null;
  const profiles=listProfiles(provider);
  return usage.accounts.map(account=>{
    const isDefault=account.label===defaultLabel;
    const profile=profiles.find(item=>item.label===account.label);
    const home=isDefault?null:profile?accountHome(provider,profile.id):null;
    const ready=home&&(provider==='claude-code'?launchableClaudeHome(account.label,selected,false,home)===home:sharedCodexHome(home)===home);
    const fresh=Date.parse(account.readAt??usage.observedAt)>=now-6*60_000&&!usage.problem;
    return {account:account.label,home:ready?home:null,isDefault,
      tightestUsedPercent:fresh?accountUsedPercent(provider,account):null,
      problem:!fresh?'Usage reading is stale.':account.problem};
  });
}

/**
 * Whether a Claude account other than `refused` can take the work now, by the same rules dispatch
 * uses (selection, proof, usage, the refused account's recorded limit), so the two never disagree.
 */
export function claudeAccountWithRoomBesides(refused:string|null):boolean{
  try {
    const next=chooseClaudeDispatch(refused);
    return !!next&&next.account!==refused;
  } catch { return false; }
}

/** Held for a sign-in, never run on the main folder's login instead (the message is a sign-in refusal on purpose). */
const noOwnClaudeLogin=()=>new ProviderDispatchError({failureClass:'parked_access',terminalConfirmed:true,
  message:'Not logged in: no Claude account on this machine has a working sign-in of its own. Sign in to one in Accounts.'});

export function chooseClaudeDispatch(prefer:string|null,seenSelectionRevision=0):{account:string;home:string|null;because:AccountReason;expected:string|null;selectionRevision:number}|null {
  const usage=providerAccountUsage('claude-code');
  const ownHomes=claudeRunsFromOwnHomes();
  // Never the main folder's login where accounts have homes of their own; see claudeRunsFromOwnHomes.
  const defaultAccount=ownHomes?null:currentAccount('claude-code')?.label??usage?.accounts.find(account=>account.current)?.label??null;
  const selection=claudeAccountSelection();
  const selectedAccount=selection&&selection.revision>seenSelectionRevision?selection.label:null;
  const selected=selectedClaudeHome()?.label??null;
  // Without a reading of the selected account (none at all, or the usage reader does not know an
  // account just signed in through Accounts) nothing can be compared, so the work runs where he chose.
  if(ownHomes&&(!usage||(selected&&!usage.accounts.some(account=>account.label===selected)))){
    const home=selected?launchableClaudeHome(selected,selected,true):null;
    if(home)return {account:selected!,home,because:'stayed-on-its-account',expected:selected,selectionRevision:selection?.revision??0};
    if(!usage)throw noOwnClaudeLogin();
  }
  // An ordinary one-home installation follows its existing path, including its existing
  // usage refusal and retry handling. A stale or absent reading cannot justify a move.
  if(!usage||(!ownHomes&&!defaultAccount))return null;
  // Add any link a new shared entry needs before choosing; a home still incomplete is skipped.
  const homes=new Map(usage.accounts.filter(account=>account.label!==defaultAccount)
    .map(account=>[account.label,launchableClaudeHome(account.label,selected,true)] as const));
  const extraHomes=usage.accounts.filter(account=>homes.get(account.label));
  if(!extraHomes.length){
    if(ownHomes)throw noOwnClaudeLogin();
    return null;
  }
  const rooms=usage.accounts.map(account=>{
    const home=account.label===defaultAccount?null:homes.get(account.label)??null;
    // The usage reader keeps its own copies of each login and reads with them; when it cannot,
    // that says nothing about the selected account's own login. Its work is tried there, and a
    // real limit comes back from Claude with its reset time as an ordinary usage hold.
    const trusted=ownHomes&&account.label===selected&&!!home;
    return {
      account:account.label,
      tightestUsedPercent:accountUsedPercent('claude-code',account)??(trusted?0:null),
      home,
      isDefault:account.label===defaultAccount,
      problem:trusted?null:account.problem,
    };
  });
  // Where his work runs when nothing else decides: the account he selected in Provider accounts,
  // else this machine's default login. A conversation that has never run anywhere prefers it, so
  // it starts where everything starts instead of on whichever account happens to be roomiest —
  // which is what makes "started somewhere else" true whenever it is said, rather than a sentence
  // the caller has to reason its way to.
  const usual=selection?.label??defaultAccount;
  // Where he would expect this turn to run, which is the one thing a notice is measured against.
  const expected=selectedAccount??prefer??usual;
  const choice=chooseAccountForTurn({accounts:rooms,bound:null,prefer:expected});
  if(choice.account===null){
    const resets=usage.accounts.filter(account=>rooms.some(room=>room.account===account.label&&(room.home||room.isDefault)))
      .map(account=>Math.max(claudeAccountCachedReset(account.label)??-Infinity,
        ...account.windows.filter(window=>window.usedPercent>=100).map(window=>Date.parse(window.resetsAt??''))))
      .filter(reset=>Number.isFinite(reset)&&reset>Date.now());
    throw new ProviderDispatchError({message:'Every available Claude account is out of room.',failureClass:'parked_terminal',
      terminalConfirmed:true,clearsAtMs:resets.length?Math.min(...resets):null});
  }
  return {account:choice.account,home:choice.home,because:choice.because,expected,selectionRevision:selection?.revision??0};
}
