import type {AccountIdentityProvider} from './provider-accounts';
import type {AccountUsage,ProviderUsage} from './provider-account-usage';

export const ACCOUNT_READING_MAX_AGE_MS=6*60_000;

/** A copied or tool-active login cannot select the account this machine runs agents on. */
export function withLocalCurrentAccount(usage:ProviderUsage,selected:string|null):ProviderUsage {
  return {...usage,accounts:usage.accounts.map(account=>({...account,current:account.label===selected}))};
}

/** A window that refills within hours (Claude's and Codex's five-hour, Gemini's five-hour).
 * It can stop a turn now, but says nothing about how much a long-lived session can do. */
export function refillsWithinHours(window:AccountUsage['windows'][number]):boolean {
  return window.durationMinutes!=null?window.durationMinutes<=300:/5-hour/.test(window.name);
}

/** Windows that constrain the ordinary Claude Opus start; Fable has a separate weekly cap.
 * The five-hour window is counted when the reading has one, never required: Anthropic
 * removes it from verified Ultra accounts (email of 2026-10-30), and a reading without it
 * must still show room rather than read as an unreadable account. */
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
    const required=['Weekly',...(model===null||/fable/i.test(model??'')?['Weekly · Fable only']:[])];
    return required.every(name=>relevant.some(window=>window.name===name))?relevant:[];
  }
  return account.windows;
}

/** A reading may be too old to rank room while still proving a full window has not reset. */
export function hasActiveFullAllowanceWindow(provider:AccountIdentityProvider,account:AccountUsage,
  model:string|null|undefined,now=Date.now()):boolean {
  return account.windows.some(window=>{
    if(provider==='claude-code'&&window.name==='Weekly · Fable only'
      &&model!==null&&!/fable/i.test(model??''))return false;
    const reset=Date.parse(window.resetsAt??'');
    return window.usedPercent>=100&&Number.isFinite(reset)&&reset>now;
  });
}

/** OpenAI can charge this account's existing credits after its included Codex week is spent.
 * The credit flag and balance come from the same account reading as the allowance bars. */
export function codexCreditsCanCover(account:AccountUsage,now=Date.now()):boolean {
  const at=Date.parse(account.usageCredits?.observedAt??'');
  return account.usageCredits?.enabled===true&&Number.isFinite(at)&&at<=now
    &&now-at<ACCOUNT_READING_MAX_AGE_MS;
}

export function accountCanTakeWork(provider:AccountIdentityProvider,account:AccountUsage,
  model?:string|null):boolean {
  const windows=includedAllowanceWindows(provider,account,model);
  return windows.length>0 && (windows.every(window=>window.usedPercent<100)
    || provider==='codex'&&codexCreditsCanCover(account));
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
  // The peer contributes usage, never this machine's sign-in state. A Mac home can be
  // signed out while the same account still has a good reading on the server.
  const borrowed=():AccountUsage=>({...peer,current:local.current,signedOut:local.signedOut,
    ...(local.signedOut?{problem:local.problem}:{})});
  if(!local.windows.length)return borrowed();
  if(!peer.windows.length)return local;
  const localFresh=accountReadingFresh(provider,local.viaPeer?{...localUsage,problem:null}:localUsage,local,now);
  const peerFresh=accountReadingFresh(provider,{observedAt:peer.readAt??'',accounts:[peer],problem:null},peer,now);
  if(localFresh!==peerFresh)return peerFresh?borrowed():local;
  return (accountReadingAt(peer)??-Infinity)>(accountReadingAt(local)??-Infinity)
    ?borrowed():local;
}

/**
 * Keep historical bars visible with a source-time status, never a current room claim.
 *
 * As of 2026-11-19 (§10 of the rebuild), the `hasRoom` field is derived from the
 * authority `canTakeAnyWork` rather than from the raw `/usage` percentages alone, so
 * the UI can never show "room remains" while dispatch says "no room": the cached
 * refusal path now feeds this badge. See `bot/src/account-authority.ts` and the
 * architecture doc §10.
 */
export function markUncurrentAccountReadings(provider:AccountIdentityProvider,usage:ProviderUsage,
  now=Date.now()):ProviderUsage {
  // Lazy-load to avoid a circular import; authority imports back into this module.
  const { canTakeAnyWork } = require('./account-authority') as typeof import('./account-authority');
  return {...usage,accounts:usage.accounts.map(account=>{
    const at=accountReadingAt(account);
    // Accounts displays every window, so its whole row expires if any displayed window
    // resets. Dispatch instead supplies its actual model and evaluates only its windows.
    const validUntil=accountReadingValidUntil(provider,account,null);
    const fresh=accountReadingFresh(provider,usage,account,now,undefined,null);
    // Authority answer: the model-agnostic "can this account take any work right now?".
    // Provider boundary: `canTakeAnyWork` understands claude-code / codex / antigravity.
    // The authority incorporates cached refusals, so when it says false the UI must not
    // say "room remains" from a stale reading — a verdict's `ok` is the only input
    // to `hasRoom`. On a no-signal verdict (no reading AND no cache), the authority
    // returns ok=false with reason='unknown'; the UI reads `null` for that case.
    // M3 (2026-11-19): if the authority itself throws (e.g. a DB read fails during
    // a diagnostic path), surface the row as unknown AND log the throw so the
    // silent-regression path has evidence. Fabricating a reading-only badge here
    // was explicitly rejected by the review — one source of truth.
    let hasRoom:boolean|null=null;
    try {
      const verdict=canTakeAnyWork(provider as "claude-code"|"codex"|"antigravity",{provider:provider as "claude-code"|"codex"|"antigravity",label:account.label},now);
      hasRoom=verdict.reason==='unknown'?null:verdict.ok;
    } catch (error) {
      hasRoom=null;
      try {
        const { log } = require('./log') as typeof import('./log');
        log('warn','authority_threw_for_account',{
          provider, account:account.label,
          error_name:error instanceof Error?error.name:'unknown',
          error_message:error instanceof Error?error.message:String(error),
        });
      } catch { /* log module unavailable during teardown; swallow */ }
    }
    const status:NonNullable<AccountUsage['allowance']>['status']=account.problem||usage.problem
      ?'unreadable':at===null?'unknown':fresh?'current':'old';
    const allowance:NonNullable<AccountUsage['allowance']>={observedAt:at===null?null:new Date(at).toISOString(),
      evaluatedAt:new Date(now).toISOString(),
      validUntil:validUntil===null?null:new Date(validUntil).toISOString(),status,
      hasRoom};
    return {...account,allowance};
  })};
}
