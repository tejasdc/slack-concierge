import type {AccountRoom} from './provider-account-choice';
import type {AccountIdentityProvider} from './provider-accounts';
import type {ProviderUsage} from './provider-account-usage';
import {includedAllowanceWindows} from './account-allowance-observation';

/**
 * How much allowance stays held for Tejas's own work, whatever the bank does
 * (docs/plans/2026-11-26-foreground-entitlement.md).
 *
 * This is the protection question, kept apart from the forecast question on purpose. The forecast
 * (`bankedSpendablePercent` in saved-work.ts) asks whether an allowance is likely to go unspent; it
 * can be missing, and a missing projection is not a surplus. This module asks how much his own
 * work needs left to it, from what his own work actually cost over the last seven days, and it
 * always has an answer: when that week cannot be measured it holds a whole account's allowance.
 *
 * Both are in one unit: percent of one account's window. His work is not pinned to an account —
 * only banked work binds (provider-account-choice.ts) — so what protects him is the room left
 * across every account his work can run on, not the room on the one the bank is spending. The
 * bank may therefore spend only what that pooled room exceeds his entitlement by.
 */

/** What his own work cost over the measured week, per provider, in percent of one account's week. */
export type ForegroundNeed=Readonly<{
  provider:AccountIdentityProvider;
  /** The week's estimated use on every account, less standing routines' own scheduled turns. */
  weeklyPercent:number;
  /** The single busiest local day of all work in that week. */
  busiestDayPercent:number;
  computedAt:string;
}>;

/**
 * A window kind nobody has measured holds one whole account's window. For five-hour windows that
 * is the only figure there is: no account reports one today (Anthropic removed it from Ultra on
 * 2026-10-30 and Codex currently reports only its week), so his five-hour demand has never been
 * observed, and "one full account kept free" is the least that keeps a burst of his runnable.
 */
export const UNMEASURED_HOLD_PERCENT=100;

const weeklyComponents=(projection:any,provider:string)=>((projection?.components??[]) as any[])
  .filter(item=>item.provider===provider&&item.window==='Weekly'&&typeof item.usedPercent==='number');

/**
 * His own work's week, from the rolling seven-day attribution report. Null when the report has
 * no weekly estimate for this provider at all, which the caller holds as unmeasured.
 *
 * Sessions that ran banked work (`bankedSessions`, `concierge:<id>`) are subtracted too: left in,
 * the bank's own spending would raise the hold that bounds it, until a busy banked day held the
 * whole week and the bank blocked itself (independent review, 2026-11-26). The report has no
 * per-session day, so the busiest day is scaled by the share of the week that was his.
 */
export function foregroundNeed(provider:AccountIdentityProvider,report:{computedAt:string;week:Record<string,any>}|null,
  bankedSessions:ReadonlySet<string>=new Set()):ForegroundNeed|null {
  if(!report)return null;
  const accounts=((report.week.accounts??[]) as any[]).filter(account=>account.provider===provider);
  const total=accounts.flatMap(account=>weeklyComponents(account.weeklyAllowance?.estimatedUse,provider));
  if(!total.length)return null;
  const sum=(items:any[])=>items.reduce((value,item)=>value+item.usedPercent,0);
  const routines=sum(((report.week.byRoutine??[]) as any[]).flatMap(row=>weeklyComponents(row.weeklyAllowance,provider)));
  const bySession=(report.week.sessionAllowanceById??{}) as Record<string,any>;
  const banked=sum([...bankedSessions].flatMap(id=>weeklyComponents(bySession[id],provider)));
  const days=((report.week.byDay??[]) as any[]).map(day=>sum(weeklyComponents(day.weeklyAllowance,provider)));
  const all=sum(total);
  const weeklyPercent=Math.max(0,all-routines-banked);
  const share=all>0?weeklyPercent/all:0;
  return {provider,weeklyPercent,busiestDayPercent:Math.min(weeklyPercent,Math.max(0,...days)*share),computedAt:report.computedAt};
}

/**
 * What stays held across the pool for the next `hoursLeft`: his busiest day for every day left
 * (at least one whole busiest day, because his work arrives in bursts within a day, not spread
 * across it), never more than his whole week. `floorPercent` is the held-back setting, which
 * remains a minimum he can raise.
 */
export function weeklyHoldPercent(need:ForegroundNeed|null,hoursLeft:number,floorPercent:number):number {
  if(!need)return Math.max(floorPercent,UNMEASURED_HOLD_PERCENT);
  const days=Math.max(1,hoursLeft/24);
  return Math.max(floorPercent,Math.min(need.weeklyPercent,need.busiestDayPercent*days));
}

type WindowKind='weekly'|'fiveHour';
const kindOf=(name:string):WindowKind|null=>/5-hour/i.test(name)?'fiveHour':/weekly/i.test(name)?'weekly':null;

/**
 * Room his work could still use, per window kind, summed over every account it can launch on: a
 * fresh reading with room in its tightest window. An account without a window of that kind (a
 * Claude account with no five-hour limit) is not limited by it and counts as a whole window.
 */
export function pooledRoomPercent(provider:AccountIdentityProvider,usage:ProviderUsage,rooms:readonly AccountRoom[],
  model:string|null|undefined):Record<WindowKind,number> {
  const pooled:Record<WindowKind,number>={weekly:0,fiveHour:0};
  const limited:Record<WindowKind,boolean>={weekly:false,fiveHour:false};
  for(const room of rooms){
    if(room.problem||room.tightestUsedPercent===null||room.tightestUsedPercent>=100)continue;
    const account=usage.accounts.find(item=>item.label===room.account);
    if(!account)continue;
    const windows=includedAllowanceWindows(provider,account,model);
    if(!windows.length)continue;
    for(const kind of ['weekly','fiveHour'] as const){
      const used=windows.filter(window=>kindOf(window.name)===kind).map(window=>window.usedPercent);
      if(used.length)limited[kind]=true;
      pooled[kind]+=Math.max(0,100-(used.length?Math.max(...used):0));
    }
  }
  // A kind no account in the pool is limited by protects nothing: with no five-hour window
  // anywhere there is no five-hour wall for the bank to push him into.
  // An empty pool is no room at all, not an unlimited one.
  if(!limited.weekly&&!limited.fiveHour&&pooled.weekly===0)return pooled;
  for(const kind of ['weekly','fiveHour'] as const)if(!limited[kind])pooled[kind]=Infinity;
  return pooled;
}

export type ForegroundProtection=Readonly<{
  /** What the bank may still spend before his entitlement is reached, in percent of one account's window. */
  spendablePercent:number;
  pooled:Record<WindowKind,number>;
  held:Record<WindowKind,number>;
  measured:boolean;
  /** The unmeasured five-hour hold is what refuses: named on its own so the bank going quiet
   * the week five-hour windows return is visible and asks for a measurement, not a hunt. */
  fiveHourBinds:boolean;
}>;

/**
 * The protection bound for banked work spending a window that resets in `hoursLeft`: pooled
 * room minus what is held, for the week and the five-hour window, and the smaller binds. A
 * five-hour hold does not shrink with time — it is the next burst, which can come at any hour.
 */
export function foregroundProtection(provider:AccountIdentityProvider,usage:ProviderUsage,rooms:readonly AccountRoom[],
  model:string|null|undefined,need:ForegroundNeed|null,hoursLeft:number,floorPercent:number,now=Date.now()):ForegroundProtection {
  const pooled=pooledRoomPercent(provider,usage,rooms,model);
  const held={weekly:weeklyHoldPercent(need,hoursLeft,floorPercent),fiveHour:Math.max(floorPercent,UNMEASURED_HOLD_PERCENT)};
  // Another account's week that resets before the horizon gives his work its spent share back
  // from that instant on (2026-11-26: without this, an account resetting in 20 hours made the
  // bank treat a six-day horizon as if no week would refill, leaving it 4.6% of a fresh week).
  // So the hold is checked just before each such refill, against what he could need by then,
  // and at the horizon with every earlier refill counted. A refill is credited only with the
  // share used now, which is the least it can give back.
  let weekly=pooled.weekly-held.weekly;
  if(Number.isFinite(pooled.weekly)){
    weekly=Infinity;
    const refills=weeklyRefills(provider,usage,rooms,model,now,now+hoursLeft*3_600_000);
    let credited=0;
    for(const refill of refills){
      const hoursToRefill=Math.max(0,(refill.atMs-now)/3_600_000);
      weekly=Math.min(weekly,pooled.weekly+credited-weeklyHoldPercent(need,hoursToRefill,floorPercent));
      credited+=refill.percent;
    }
    weekly=Math.min(weekly,pooled.weekly+credited-held.weekly);
  }
  const fiveHour=pooled.fiveHour-held.fiveHour;
  return {spendablePercent:Math.min(weekly,fiveHour),pooled,held,measured:!!need,
    fiveHourBinds:Number.isFinite(fiveHour)&&fiveHour<=0&&fiveHour<=weekly};
}

/** Weekly windows in the pool that reset strictly before `untilMs`, soonest first, with the share each gives back. */
function weeklyRefills(provider:AccountIdentityProvider,usage:ProviderUsage,rooms:readonly AccountRoom[],
  model:string|null|undefined,now:number,untilMs:number):{atMs:number;percent:number}[] {
  const refills:{atMs:number;percent:number}[]=[];
  for(const room of rooms){
    if(room.problem||room.tightestUsedPercent===null||room.tightestUsedPercent>=100)continue;
    const account=usage.accounts.find(item=>item.label===room.account);
    const weekly=account?includedAllowanceWindows(provider,account,model).filter(window=>kindOf(window.name)==='weekly'):[];
    if(!weekly.length)continue;
    // An account's weekly room is its tightest weekly window, so it refills when the last of them does.
    const resets=weekly.map(window=>Date.parse(window.resetsAt??''));
    if(!resets.every(Number.isFinite))continue;
    const atMs=Math.max(...resets);
    if(atMs>now&&atMs<untilMs)refills.push({atMs,percent:Math.min(100,Math.max(...weekly.map(window=>window.usedPercent)))});
  }
  return refills.sort((a,b)=>a.atMs-b.atMs);
}
