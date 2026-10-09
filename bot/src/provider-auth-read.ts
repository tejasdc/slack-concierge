import {currentAccount,listProfiles,type ProviderKey} from './provider-accounts';
import {providerAccountUsage,type ProviderUsage} from './provider-account-usage';
import {claudeRunsFromOwnHomes} from './provider-account-dispatch';
import {claudeAccountSelection} from './provider-account-selection';
import {noticeTime} from './provider-free-notice';
import {db} from './state-database';
import type {ProviderAuthEphemera} from './provider-auth-ephemera';
import type {ProviderAuthView} from './session-execution-host';

function claudeInUseSentence(chosen:string,usage:ProviderUsage|null):string {
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

/** Account listing runs in an isolated reader. Login state comes from the command owner. */
export function providerAuthRead(ephemera:ProviderAuthEphemera):readonly ProviderAuthView[] {
  return (['claude-code','codex'] as const).map(provider=>providerAuthView(provider,ephemera));
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
  const usage=storedUsage?{...storedUsage,refreshing:ephemera.usageRefreshing}:null;
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
      :`This machine has no ${provider==='codex'?'Codex':'Claude'} account yet.`,
    account,profiles:checked,usage,checking:ephemera.checking};
}
