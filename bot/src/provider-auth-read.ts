import { providerDisplayName } from "./aliases";
import {currentAccount,listProfiles,type ProviderKey} from './provider-accounts';
import {providerAccountUsage,type ProviderUsage} from './provider-account-usage';
import {accountReadingFresh,includedAllowanceWindows,markUncurrentAccountReadings} from './account-allowance-observation';
import {withResetAdvice} from './provider-usage-forecast';
import {claudeRunsFromOwnHomes} from './provider-account-dispatch';
import {claudeAccountSelection} from './provider-account-selection';
import {noticeTime} from './provider-free-notice';
import {db} from './state-database';
import type {ProviderAuthEphemera} from './provider-auth-ephemera';
import type {ProviderAuthView} from './session-execution-host';

function claudeInUseSentence(chosen:string,usage:ProviderUsage|null):string {
  const reading=usage?.accounts.find(item=>item.label===chosen);
  if(!usage||!reading||!accountReadingFresh('claude-code',usage,reading))return '';
  const full=includedAllowanceWindows('claude-code',reading).filter(window=>window.usedPercent>=100&&window.resetsAt);
  if(!full.length)return '';
  const until=Math.max(...full.map(window=>Date.parse(window.resetsAt!)));
  const other=usage.accounts.find(item=>item.label!==chosen&&accountReadingFresh('claude-code',usage,item)
    &&includedAllowanceWindows('claude-code',item).length>0
    &&includedAllowanceWindows('claude-code',item).every(window=>window.usedPercent<100));
  const when=noticeTime(db,until);
  return other
    ?`${chosen} is at its limit until ${when}, so new Claude work runs on ${other.label} until then.`
    :`${chosen} is at its limit until ${when}, and no other account has confirmed room. New Claude work checks again before routing and waits if none is available.`;
}

/** Account listing runs in an isolated reader. Login state comes from the command owner. */
export function providerAuthRead(ephemera:ProviderAuthEphemera):readonly ProviderAuthView[] {
  return [...(['claude-code','codex'] as const).map(provider=>providerAuthView(provider,ephemera)),antigravityAuthView(ephemera)];
}

export function antigravityAuthView(ephemera:ProviderAuthEphemera):ProviderAuthView {
  const stored=providerAccountUsage('antigravity');
  const usage=stored?{...markUncurrentAccountReadings('antigravity',stored),refreshing:ephemera.usageRefreshing}:null;
  const current=usage?.accounts.find(item=>item.current&&item.label===ephemera.antigravityAccount?.label
    &&accountReadingFresh('antigravity',usage,item))??null;
  const account=current?{id:current.label,label:current.label,detail:current.plan}:null;
  const signedIn=!!account&&!current?.signedOut;
  return {provider:'antigravity',mode:'host-managed',pending:false,signInKeepsCurrent:true,
    pendingFor:null,pendingUrl:null,lastSignIn:null,
    message:signedIn?'':usage?.problem??'Google has not been signed in on this machine.',
    signedIn,account,profiles:[],usage,checking:ephemera.checking};
}

function providerAuthView(provider:ProviderKey,ephemera:ProviderAuthEphemera):ProviderAuthView {
  const defaultAccount=currentAccount(provider)??ephemera.accountFallback[provider];
  const selection=provider==='claude-code'?claudeAccountSelection():null;
  const saved=listProfiles(provider);
  const ownHomes=provider==='claude-code'&&claudeRunsFromOwnHomes();
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
  const storedUsage=providerAccountUsage(provider);
  // Each account row carries what a reset would do for it right now (provider-reset-facts.ts).
  // This reader answers the Accounts page; the command owner's own view says the same.
  const usage=storedUsage?{...markUncurrentAccountReadings(provider,withResetAdvice(provider,storedUsage)),
    refreshing:ephemera.usageRefreshing}:null;
  const refused=new Set((usage?.accounts??[]).filter(entry=>entry.signedOut).map(entry=>entry.label));
  const brokenInUse=provider==='codex'&&ephemera.codexSignIn==='signed-out';
  const listed=provider==='codex'&&account&&!profiles.some(profile=>profile.current)
    ?[{id:'in-use',label:account.label,detail:account.detail,current:true,signedIn:true},...profiles.filter(profile=>profile.label!==account.label)]
    :profiles;
  const checked=listed.map(profile=>({...profile,signedIn:profile.signedIn!==false&&!refused.has(profile.label)&&!(brokenInUse&&profile.current)}));
  const pending=provider==='codex'?ephemera.codexPending:ephemera.claudePending;
  const lastSignIn=ephemera.lastSignIn[provider];
  if(provider==='codex'&&account)return {provider,mode:'device',pending,signInKeepsCurrent:true,pendingFor:null,pendingUrl:null,
    lastSignIn,message:brokenInUse||refused.has(account.label)?`Codex on this machine is signed out: the sign-in for ${account.label} stopped working. Sign in again to run Codex work here.`:'',
    signedIn:!(brokenInUse||refused.has(account.label)),account,profiles:checked,usage,checking:ephemera.checking};
  return {provider,mode:provider==='codex'?'device':'interactive',pending,signInKeepsCurrent:true,
    pendingFor:provider==='claude-code'?ephemera.claudePendingFor:null,
    pendingUrl:provider==='claude-code'?ephemera.claudePendingUrl:null,
    lastSignIn,message:account?(provider==='claude-code'?claudeInUseSentence(account.label,usage):'')
      :ownHomes?'No Claude account is selected for agents on this machine. Sign in to one or switch to one below.'
      :`This machine has no ${providerDisplayName(provider)??provider} account yet.`,
    account,profiles:checked,usage,checking:ephemera.checking};
}
