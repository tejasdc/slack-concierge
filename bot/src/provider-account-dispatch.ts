import {existsSync,realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {chooseAccountForTurn,accountChosenSentence,accountMovedSentence} from './provider-account-choice';
import {accountHome,currentAccount,profileId} from './provider-accounts';
import {providerAccountUsage} from './provider-account-usage';
import {ProviderDispatchError} from './provider-failures';
import {claudeAccountCachedReset} from './provider-usage';
import {claudeAccountSelection} from './provider-account-selection';

/** Only launch from an extra home when it sees the same conversation history. */
function sharedClaudeHome(account:string):string|null {
  const home=accountHome('claude-code',profileId(account));
  const projects=join(home,'projects');
  try {
    return existsSync(join(home,'.credentials.json'))&&existsSync(projects)
      &&realpathSync(projects)===realpathSync(join(homedir(),'.claude','projects'))?home:null;
  } catch {return null;}
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
    tightestUsedPercent:claudeAccountCachedReset(account.label)?100:
      account.windows.length?Math.max(...account.windows.map(window=>window.usedPercent)):null,
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
