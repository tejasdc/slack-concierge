import type {AccountIdentityProvider} from './provider-accounts';
import type {AccountUsage,ProviderUsage} from './provider-account-usage';

export const ACCOUNT_READING_MAX_AGE_MS=6*60_000;

/** A copied or tool-active login cannot select the account this machine runs agents on. */
export function withLocalCurrentAccount(usage:ProviderUsage,selected:string|null):ProviderUsage {
  return {...usage,accounts:usage.accounts.map(account=>({...account,current:account.label===selected}))};
}

/** Windows that constrain the ordinary Claude Opus start; Fable has a separate weekly cap. */
export function includedAllowanceWindows(provider:AccountIdentityProvider,account:AccountUsage,
  model?:string|null):AccountUsage['windows'] {
  if(provider==='codex')
    return account.windows.length&&account.windows.every(window=>Number.isSafeInteger(window.durationMinutes)
      &&(window.durationMinutes??0)>0)?account.windows:[];
  // A null model is genuinely unknown: include the Fable cap so a launch cannot be
  // authorized on an assumption. Undefined is the ordinary Automatic Opus view.
  if(provider==='claude-code'){
    const relevant=model!==null&&!/fable/i.test(model??'')
      ?account.windows.filter(window=>window.name!=='Weekly · Fable only'):account.windows;
    const required=['5-hour','Weekly',...(model===null||/fable/i.test(model??'')?['Weekly · Fable only']:[])];
    return required.every(name=>relevant.some(window=>window.name===name))?relevant:[];
  }
  return account.windows;
}

/** A provider observation belongs to an account, not to the batch or peer transfer. */
export function accountReadingAt(account:AccountUsage):number|null {
  // Every reader writes readAt; old records without it remain unknown. The batch timestamp
  // can be new even when a cached per-account reading or peer copy is old.
  const at=Date.parse(account.readAt??'');
  return Number.isFinite(at)?at:null;
}

export function accountReadingValidUntil(provider:AccountIdentityProvider,account:AccountUsage,
  model?:string|null):number|null {
  const source=accountReadingAt(account);
  if(source===null)return null;
  const resets=includedAllowanceWindows(provider,account,model).map(window=>Date.parse(window.resetsAt??''))
    .filter(value=>Number.isFinite(value)&&value>source);
  return Math.min(source+ACCOUNT_READING_MAX_AGE_MS,...resets);
}

export function accountReadingFresh(provider:AccountIdentityProvider,usage:ProviderUsage,
  account:AccountUsage,now=Date.now(),maxAgeMs=ACCOUNT_READING_MAX_AGE_MS,model?:string|null):boolean {
  const at=accountReadingAt(account);
  const validUntil=accountReadingValidUntil(provider,account,model);
  return !usage.problem&&!account.problem&&at!==null&&at<=now&&validUntil!==null
    &&now<Math.min(validUntil,at+maxAgeMs);
}

/** Compare source observations for one label; a peer match is label-only, never credential proof. */
export function chooseAccountObservation(provider:AccountIdentityProvider,localUsage:ProviderUsage,
  local:AccountUsage,peer:AccountUsage,now=Date.now()):AccountUsage {
  if(local.label!==peer.label)throw new Error('Cannot compare different account labels.');
  if(!local.windows.length)return {...peer,current:local.current};
  if(!peer.windows.length)return local;
  const localFresh=accountReadingFresh(provider,local.viaPeer?{...localUsage,problem:null}:localUsage,local,now);
  const peerFresh=accountReadingFresh(provider,{observedAt:peer.readAt??'',accounts:[peer],problem:null},peer,now);
  if(localFresh!==peerFresh)return peerFresh?{...peer,current:local.current}:local;
  return (accountReadingAt(peer)??-Infinity)>(accountReadingAt(local)??-Infinity)
    ?{...peer,current:local.current}:local;
}

/** Keep historical bars visible with a source-time status, never a current room claim. */
export function markUncurrentAccountReadings(provider:AccountIdentityProvider,usage:ProviderUsage,
  now=Date.now()):ProviderUsage {
  return {...usage,accounts:usage.accounts.map(account=>{
    const at=accountReadingAt(account);
    // Accounts displays every window, so its whole row expires if any displayed window
    // resets. Dispatch instead supplies its actual model and evaluates only its windows.
    const validUntil=accountReadingValidUntil(provider,account,null);
    const fresh=accountReadingFresh(provider,usage,account,now,undefined,null);
    const status:NonNullable<AccountUsage['allowance']>['status']=account.problem||usage.problem
      ?'unreadable':at===null?'unknown':fresh?'current':'old';
    const allowance:NonNullable<AccountUsage['allowance']>={observedAt:at===null?null:new Date(at).toISOString(),
      evaluatedAt:new Date(now).toISOString(),
      validUntil:validUntil===null?null:new Date(validUntil).toISOString(),status,
      hasRoom:fresh&&includedAllowanceWindows(provider,account).length>0
        ?includedAllowanceWindows(provider,account).every(window=>window.usedPercent<100):null};
    return {...account,allowance};
  })};
}
