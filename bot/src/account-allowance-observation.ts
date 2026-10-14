import type {AccountIdentityProvider} from './provider-accounts';
import type {AccountUsage,ProviderUsage} from './provider-account-usage';

export const ACCOUNT_READING_MAX_AGE_MS=6*60_000;

/** A provider observation belongs to an account, not to the batch or peer transfer. */
export function accountReadingAt(account:AccountUsage):number|null {
  // Every reader writes readAt; old records without it remain unknown. The batch timestamp
  // can be new even when a cached per-account reading or peer copy is old.
  const at=Date.parse(account.readAt??'');
  return Number.isFinite(at)?at:null;
}

export function accountReadingFresh(provider:AccountIdentityProvider,usage:ProviderUsage,
  account:AccountUsage,now=Date.now(),maxAgeMs=ACCOUNT_READING_MAX_AGE_MS):boolean {
  const at=accountReadingAt(account);
  return !usage.problem&&!account.problem&&at!==null&&at<=now&&now-at<=maxAgeMs;
}

/** Keep historical bars visible with a source-time status, never a current room claim. */
export function markUncurrentAccountReadings(provider:AccountIdentityProvider,usage:ProviderUsage,
  now=Date.now()):ProviderUsage {
  return {...usage,accounts:usage.accounts.map(account=>{
    const at=accountReadingAt(account);
    const fresh=accountReadingFresh(provider,usage,account,now);
    const status:NonNullable<AccountUsage['allowance']>['status']=account.problem||usage.problem
      ?'unreadable':at===null?'unknown':fresh?'current':'old';
    const allowance:NonNullable<AccountUsage['allowance']>={observedAt:at===null?null:new Date(at).toISOString(),
      evaluatedAt:new Date(now).toISOString(),
      validUntil:at===null?null:new Date(at+ACCOUNT_READING_MAX_AGE_MS).toISOString(),status,
      hasRoom:fresh&&account.windows.length>0?account.windows.every(window=>window.usedPercent<100):null};
    return {...account,allowance};
  })};
}
