import type {AccountIdentityProvider} from './provider-accounts';
import type {AccountUsage,ProviderUsage} from './provider-account-usage';

export const ACCOUNT_READING_MAX_AGE_MS=6*60_000;

/** Windows that constrain the ordinary Claude Opus start; Fable has a separate weekly cap. */
export function includedAllowanceWindows(provider:AccountIdentityProvider,account:AccountUsage):AccountUsage['windows'] {
  return provider==='claude-code'
    ?account.windows.filter(window=>window.name!=='Weekly · Fable only')
    :account.windows;
}

/** A provider observation belongs to an account, not to the batch or peer transfer. */
export function accountReadingAt(account:AccountUsage):number|null {
  // Every reader writes readAt; old records without it remain unknown. The batch timestamp
  // can be new even when a cached per-account reading or peer copy is old.
  const at=Date.parse(account.readAt??'');
  return Number.isFinite(at)?at:null;
}

export function accountReadingValidUntil(provider:AccountIdentityProvider,account:AccountUsage):number|null {
  const source=accountReadingAt(account);
  if(source===null)return null;
  const resets=includedAllowanceWindows(provider,account).map(window=>Date.parse(window.resetsAt??''))
    .filter(value=>Number.isFinite(value)&&value>source);
  return Math.min(source+ACCOUNT_READING_MAX_AGE_MS,...resets);
}

export function accountReadingFresh(provider:AccountIdentityProvider,usage:ProviderUsage,
  account:AccountUsage,now=Date.now(),maxAgeMs=ACCOUNT_READING_MAX_AGE_MS):boolean {
  const at=accountReadingAt(account);
  const validUntil=accountReadingValidUntil(provider,account);
  return !usage.problem&&!account.problem&&at!==null&&at<=now&&validUntil!==null
    &&now<Math.min(validUntil,at+maxAgeMs);
}

/** Keep historical bars visible with a source-time status, never a current room claim. */
export function markUncurrentAccountReadings(provider:AccountIdentityProvider,usage:ProviderUsage,
  now=Date.now()):ProviderUsage {
  return {...usage,accounts:usage.accounts.map(account=>{
    const at=accountReadingAt(account);
    const validUntil=accountReadingValidUntil(provider,account);
    const fresh=accountReadingFresh(provider,usage,account,now);
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
