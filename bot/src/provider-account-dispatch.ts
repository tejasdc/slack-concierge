import {existsSync,realpathSync,symlinkSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {chooseAccountForTurn,accountChosenSentence,accountMovedSentence} from './provider-account-choice';
import {accountHome,currentAccount,listProfiles,profileId,type ProviderKey} from './provider-accounts';
import {providerAccountUsage} from './provider-account-usage';
import type {AccountUsage,ProviderUsage} from './provider-account-usage';
import type {AccountRoom} from './provider-account-choice';
import {ProviderDispatchError} from './provider-failures';
import {claudeAccountCachedReset} from './provider-usage';
import {claudeAccountSelection} from './provider-account-selection';

/** Only launch from an extra home when it sees the same conversation history. */
export function sharedClaudeHome(account:string,home=accountHome('claude-code',profileId(account)),prepare=false):string|null {
  const projects=join(home,'projects');
  try {
    if(!existsSync(join(home,'.credentials.json')))return null;
    const history=realpathSync(join(homedir(),'.claude','projects'));
    // A legacy account may have been moved into its home without the history link.
    // Prepare only for an explicit switch; never replace an existing path or touch a login.
    if(prepare&&!existsSync(projects))symlinkSync(history,projects,'dir');
    return realpathSync(projects)===history?home:null;
  } catch {return null;}
}

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

export function savedWorkAccountRooms(provider:ProviderKey,usage:ProviderUsage,now=Date.now()):AccountRoom[] {
  const defaultLabel=currentAccount(provider)?.label;
  const profiles=listProfiles(provider);
  return usage.accounts.map(account=>{
    const isDefault=account.label===defaultLabel;
    const profile=profiles.find(item=>item.label===account.label);
    const home=isDefault?null:profile?accountHome(provider,profile.id):null;
    const ready=home&&(provider==='claude-code'?sharedClaudeHome(account.label,home)===home:sharedCodexHome(home)===home);
    const fresh=Date.parse(account.readAt??usage.observedAt)>=now-6*60_000&&!usage.problem;
    return {account:account.label,home:ready?home:null,isDefault,
      tightestUsedPercent:fresh?accountUsedPercent(provider,account):null,
      problem:!fresh?'Usage reading is stale.':account.problem};
  });
}

export function chooseClaudeDispatch(prefer:string|null,seenSelectionRevision=0):{account:string;home:string|null;notice:string|null;selectionRevision:number}|null {
  const usage=providerAccountUsage('claude-code');
  const defaultAccount=currentAccount('claude-code')?.label??usage?.accounts.find(account=>account.current)?.label??null;
  const selection=claudeAccountSelection();
  const selectedAccount=selection&&selection.revision>seenSelectionRevision?selection.label:null;
  // An ordinary one-home installation follows its existing path, including its existing
  // usage refusal and retry handling. A stale or absent reading cannot justify a move.
  if(!usage||!defaultAccount)return null;
  const extraHomes=usage.accounts.filter(account=>account.label!==defaultAccount&&sharedClaudeHome(account.label));
  if(!extraHomes.length)return null;
  const rooms=usage.accounts.map(account=>({
    account:account.label,
    tightestUsedPercent:accountUsedPercent('claude-code',account),
    home:account.label===defaultAccount?null:sharedClaudeHome(account.label),
    isDefault:account.label===defaultAccount,
    problem:account.problem,
  }));
  const choice=chooseAccountForTurn({accounts:rooms,bound:null,prefer:selectedAccount??prefer});
  if(choice.account===null){
    const resets=usage.accounts.filter(account=>rooms.some(room=>room.account===account.label&&(room.home||room.isDefault)))
      .map(account=>Math.max(claudeAccountCachedReset(account.label)??-Infinity,
        ...account.windows.filter(window=>window.usedPercent>=100).map(window=>Date.parse(window.resetsAt??''))))
      .filter(reset=>Number.isFinite(reset)&&reset>Date.now());
    throw new ProviderDispatchError({message:'Every available Claude account is out of room.',failureClass:'parked_terminal',
      terminalConfirmed:true,clearsAtMs:resets.length?Math.min(...resets):null});
  }
  const selected=rooms.find(room=>room.account===choice.account)!;
  const notice=prefer===choice.account?null:prefer
    ?accountMovedSentence({from:prefer,to:choice.account,usedPercent:selected.tightestUsedPercent!})
    :accountChosenSentence({account:choice.account,usedPercent:selected.tightestUsedPercent!,alternatives:rooms.filter(room=>room.account!==choice.account&&(room.home||room.isDefault)&&!room.problem).length});
  return {account:choice.account,home:choice.home,notice,selectionRevision:selection?.revision??0};
}
