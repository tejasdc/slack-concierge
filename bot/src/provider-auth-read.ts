import {createHash} from 'node:crypto';
import { providerDisplayName } from "./aliases";
import {currentAccount,listProfiles,type ProviderKey} from './provider-accounts';
import {providerAccountUsage,type ProviderUsage} from './provider-account-usage';
import {accountReadingFresh,includedAllowanceWindows,markUncurrentAccountReadings} from './account-allowance-observation';
import {withResetAdvice} from './provider-usage-forecast';
import {claudeRunsFromOwnHomes} from './provider-account-dispatch';
import {claudeAccountSelection} from './provider-account-selection';
import {noticeTime} from './provider-free-notice';
import {providerRunnerTarget} from './provider-runner-target';
import {db} from './state-database';
import {API_CREDITS_BUDGET_USD,apiCreditsNextGrantAt,apiCreditsConfigured,apiCreditsCycle,apiCreditsLine} from './claude-api-route';
import type {ProviderAuthEphemera} from './provider-auth-ephemera';
import type {ApiCreditsFacts} from './claude-account-facts';
import type {ProviderAuthView} from './session-execution-host';

function claudeInUseSentence(chosen:string,usage:ProviderUsage|null):string {
  const reading=usage?.accounts.find(item=>item.label===chosen);
  if(!usage||!reading||!accountReadingFresh('claude-code',usage,reading))return '';
  const full=includedAllowanceWindows('claude-code',reading).filter(window=>window.usedPercent>=100&&window.resetsAt);
  if(!full.length)return '';
  const until=Math.max(...full.map(window=>Date.parse(window.resetsAt!)));
  // §10 UI consolidation (2026-11-19): "any other account has included room" is the
  // authority's answer, not a raw `/usage` percentage. On 2026-11-19 a cached refusal
  // made hey@tejas.nyc unlaunchable while its reading still showed room; the sentence
  // must agree with the dispatcher.
  const { canTakeAnyWork } = require('./account-authority') as typeof import('./account-authority');
  const other=usage.accounts.find(item=>{
    if(item.label===chosen)return false;
    try{ return canTakeAnyWork('claude-code',{provider:'claude-code',label:item.label}).ok; }
    catch{
      // Defensive fallback: the pre-§10 reading-only check.
      return accountReadingFresh('claude-code',usage,item)
        &&includedAllowanceWindows('claude-code',item).length>0
        &&includedAllowanceWindows('claude-code',item).every(window=>window.usedPercent<100);
    }
  });
  const when=noticeTime(db,until);
  return other
    ?`${chosen}'s included Claude allowance is fully used until ${when}. A fresh allowance reading shows ${other.label} has included room; new Claude work checks launch eligibility when requested.`
    :`${chosen}'s included Claude allowance is fully used until ${when}, and no other account has confirmed included room. New Claude work checks again before routing.`;
}

/** Account listing runs in an isolated reader. Login state comes from the command owner. */
export function providerAuthRead(ephemera:ProviderAuthEphemera):readonly ProviderAuthView[] {
  return [...(['claude-code','codex'] as const).map(provider=>providerAuthView(provider,ephemera)),antigravityAuthView(ephemera)];
}

/**
 * The API-credit route's one line beside the Claude accounts (claude-api-route.ts), on the row in use
 * because the credit belongs to the Console organization rather than to any one sign-in. Concierge
 * counts only its own spend; the Console is the authority and the line says so.
 */
function withApiCreditsLine<T extends {label:string;apiCredits?:ApiCreditsFacts|null}>(accounts:readonly T[],inUse:string|null):readonly T[] {
  if(!accounts.length||!apiCreditsConfigured())return accounts;
  let cycle;try{cycle=apiCreditsCycle(db);}catch{return accounts;}
  const renewsAt=new Date(apiCreditsNextGrantAt(Date.now())).toISOString();
  const routeLine=apiCreditsLine(cycle);
  const index=Math.max(0,accounts.findIndex(item=>item.label===inUse));
  // The plan-tier facts already on the row stay; the route's own count is added to its line.
  return accounts.map((item,position)=>position!==index?item:{...item,apiCredits:item.apiCredits
    ?{...item.apiCredits,line:`${item.apiCredits.line} ${routeLine}.`}
    :{line:`${routeLine}.`,monthlyUsd:API_CREDITS_BUDGET_USD,renewsAt,spentUsd:Math.round(cycle.spentUsd*100)/100,spentAsOf:new Date().toISOString(),source:null}});
}

export function antigravityAuthView(ephemera:ProviderAuthEphemera):ProviderAuthView {
  const remoteRunner=providerRunnerTarget('antigravity');
  const stored=providerAccountUsage('antigravity');
  const usage=stored?{...markUncurrentAccountReadings('antigravity',stored),refreshing:ephemera.usageRefreshing}:null;
  const current=usage?.accounts.find(item=>item.current&&(remoteRunner||item.label===ephemera.antigravityAccount?.label)
    &&accountReadingFresh('antigravity',usage,item))??null;
  const account=current?{id:current.label,label:current.label,detail:current.plan}:null;
  const signedIn=!!account&&!current?.signedOut;
  return {provider:'antigravity',mode:'host-managed',pending:false,signInKeepsCurrent:true,
    pendingFor:null,pendingUrl:null,lastSignIn:null,
    message:signedIn?'':usage?.problem??'Google has not been signed in on this machine.',
    signedIn,account,profiles:[],usage,checking:ephemera.checking};
}

function providerAuthView(provider:ProviderKey,ephemera:ProviderAuthEphemera):ProviderAuthView {
  const remoteRunner=providerRunnerTarget(provider);
  const defaultAccount=remoteRunner?ephemera.accountFallback[provider]:currentAccount(provider)??ephemera.accountFallback[provider];
  const selection=provider==='claude-code'?claudeAccountSelection():null;
  const saved=remoteRunner?[]:listProfiles(provider);
  const ownHomes=provider==='claude-code'&&claudeRunsFromOwnHomes();
  let profiles=provider==='claude-code'&&ownHomes
    ?saved.map(profile=>({...profile,current:selection?.profileId===profile.id}))
    :provider==='claude-code'&&defaultAccount
    ?[{id:'default',label:defaultAccount.label,detail:defaultAccount.detail,current:!selection||selection.profileId==='default',signedIn:true},
      ...saved.filter(profile=>profile.label!==defaultAccount.label).map(profile=>({...profile,current:selection?.profileId===profile.id}))]
    :saved;
  let account=provider==='claude-code'&&ownHomes
    ?profiles.find(profile=>profile.current)??null
    :provider==='claude-code'&&selection&&selection.profileId!=='default'
    ?profiles.find(profile=>profile.id===selection.profileId)??defaultAccount:defaultAccount;
  const storedUsage=providerAccountUsage(provider);
  // Each account row carries what a reset would do for it right now (provider-reset-facts.ts).
  // This reader answers the Accounts page; the command owner's own view says the same.
  const usage=storedUsage?{...markUncurrentAccountReadings(provider,withResetAdvice(provider,storedUsage)),
    refreshing:ephemera.usageRefreshing}:null;
  if(remoteRunner){
    profiles=(usage?.accounts??[]).map(item=>({id:`runner-${createHash('sha256').update(item.label).digest('hex').slice(0,16)}`,
      label:item.label,detail:item.problem,current:item.label===(selection?.label??usage?.accounts.find(account=>account.current)?.label),signedIn:item.signedOut!==true}));
    if(provider==='claude-code'){
      const active=profiles.find(profile=>profile.current);
      account=active?{id:active.id,label:active.label,detail:active.detail}:null;
    }
  }
  if(provider==='claude-code'&&usage)usage.accounts=withApiCreditsLine(usage.accounts,account?.label??null);
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
