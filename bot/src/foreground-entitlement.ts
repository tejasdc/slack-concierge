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
const HOUR_MS=3_600_000;

/**
 * An account dispatch would still send his work to although its reading is not fresh: the
 * account authority's own verdict (`last-showed-room` and the like), with the instant of the
 * reading its stored windows come from. Null when dispatch would not use it.
 */
export type StaleEligibility=(label:string)=>{readAtMs:number}|null;

/** One account's share of the pool, and for a stale one how much of it was taken back. */
export type PoolMember=Readonly<{
  account:string;
  room:Record<WindowKind,number>;
  limited:Record<WindowKind,boolean>;
  /** When its weekly room comes back in full, if that is known. */
  weeklyResetMs:number|null;
  stale:{hours:number;decayPercent:number}|null;
}>;

/**
 * Every account his work can run on, with the room it still has, per window kind. The pool is
 * what ordinary dispatch would use, at the level dispatch believes (decided 2026-11-26 with
 * concierge:3633): a fresh reading with room, and also an account whose reading is stale but
 * which the account authority still admits because its last reading showed room — counting it as
 * absent closed the bank when one access token expired, while his work kept running there.
 *
 * A stale level is decayed by his own measured pace over the staleness (`decayPerHour`, his
 * busiest day per hour), floored at zero. The level is only consulted when dispatch is willing to
 * send his work there, which is exactly when his work may be spending it unseen, so the error is
 * systematic and in the dangerous direction unless it is taken back. A window whose reset has
 * passed since the reading counts as a full refill, which is certain in the safe direction. A
 * stale five-hour window counts nothing until its reset has passed: his weekly pace says nothing
 * about a five-hour window, and one burst can empty it.
 *
 * An account without a window of a kind (a Claude account with no five-hour limit) is not
 * limited by it and counts as a whole window.
 */
export function poolMembers(provider:AccountIdentityProvider,usage:ProviderUsage,rooms:readonly AccountRoom[],
  model:string|null|undefined,now:number,decayPerHour:number,staleEligible:StaleEligibility=()=>null):PoolMember[] {
  const members:PoolMember[]=[];
  for(const account of usage.accounts){
    const room=rooms.find(item=>item.account===account.label);
    const fresh=!!room&&!room.problem&&room.tightestUsedPercent!==null&&room.tightestUsedPercent<100;
    const stale=fresh?null:staleEligible(account.label);
    if(!fresh&&!stale)continue;
    const windows=includedAllowanceWindows(provider,account,model);
    if(!windows.length)continue;
    const hours=stale?Math.max(0,(now-stale.readAtMs)/HOUR_MS):0;
    const decay=stale?decayPerHour*hours:0;
    const roomOf=(kind:WindowKind)=>{
      const ofKind=windows.filter(window=>kindOf(window.name)===kind);
      if(!ofKind.length)return 100;
      const reset=Math.max(...ofKind.map(window=>Date.parse(window.resetsAt??'')));
      if(stale&&Number.isFinite(reset)&&reset<=now)return 100;
      if(stale&&kind==='fiveHour')return 0;
      return Math.max(0,100-Math.max(...ofKind.map(window=>window.usedPercent))-decay);
    };
    const weekly=windows.filter(window=>kindOf(window.name)==='weekly');
    const weeklyResets=weekly.map(window=>Date.parse(window.resetsAt??''));
    members.push({account:account.label,
      room:{weekly:roomOf('weekly'),fiveHour:roomOf('fiveHour')},
      limited:{weekly:weekly.length>0,fiveHour:windows.some(window=>kindOf(window.name)==='fiveHour')},
      weeklyResetMs:weekly.length&&weeklyResets.every(Number.isFinite)?Math.max(...weeklyResets):null,
      stale:stale?{hours,decayPercent:decay}:null});
  }
  return members;
}

export function pooledRoomPercent(members:readonly PoolMember[]):Record<WindowKind,number> {
  // An empty pool is no room at all, not an unlimited one.
  if(!members.length)return {weekly:0,fiveHour:0};
  const pooled:Record<WindowKind,number>={weekly:0,fiveHour:0};
  for(const kind of ['weekly','fiveHour'] as const){
    // A kind no account in the pool is limited by protects nothing: with no five-hour window
    // anywhere there is no five-hour wall for the bank to push him into.
    pooled[kind]=members.some(member=>member.limited[kind])?members.reduce((sum,member)=>sum+member.room[kind],0):Infinity;
  }
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
  /** Accounts counted from a stale reading, with how much of their level was taken back. */
  stale:Record<string,{hours:number;decayPercent:number}>;
}>;

/**
 * The protection bound for banked work spending a window that resets in `hoursLeft`: pooled
 * room minus what is held, for the week and the five-hour window, and the smaller binds. A
 * five-hour hold does not shrink with time — it is the next burst, which can come at any hour.
 */
export function foregroundProtection(provider:AccountIdentityProvider,usage:ProviderUsage,rooms:readonly AccountRoom[],
  model:string|null|undefined,need:ForegroundNeed|null,hoursLeft:number,floorPercent:number,now=Date.now(),
  staleEligible:StaleEligibility=()=>null):ForegroundProtection {
  // His pace for the decay: his busiest day per hour; a whole account a day when unmeasured.
  const decayPerHour=(need?need.busiestDayPercent:UNMEASURED_HOLD_PERCENT)/24;
  const members=poolMembers(provider,usage,rooms,model,now,decayPerHour,staleEligible);
  const pooled=pooledRoomPercent(members);
  const held={weekly:weeklyHoldPercent(need,hoursLeft,floorPercent),fiveHour:Math.max(floorPercent,UNMEASURED_HOLD_PERCENT)};
  // Another account's week that resets before the horizon gives his work its spent share back
  // from that instant on (2026-11-26: without this, an account resetting in 20 hours made the
  // bank treat a six-day horizon as if no week would refill, leaving it 4.6% of a fresh week).
  // So the hold is checked just before each such refill, against what he could need by then,
  // and at the horizon with every earlier refill counted. A refill is credited only with what
  // the account is not counted as having now, which is the least it can give back.
  let weekly=pooled.weekly-held.weekly;
  if(Number.isFinite(pooled.weekly)){
    weekly=Infinity;
    const untilMs=now+hoursLeft*HOUR_MS;
    const refills=members.filter(member=>member.limited.weekly&&member.weeklyResetMs!==null
        &&member.weeklyResetMs>now&&member.weeklyResetMs<untilMs)
      .map(member=>({atMs:member.weeklyResetMs!,percent:Math.min(100,100-member.room.weekly)}))
      .sort((a,b)=>a.atMs-b.atMs);
    let credited=0;
    for(const refill of refills){
      const hoursToRefill=Math.max(0,(refill.atMs-now)/HOUR_MS);
      weekly=Math.min(weekly,pooled.weekly+credited-weeklyHoldPercent(need,hoursToRefill,floorPercent));
      credited+=refill.percent;
    }
    weekly=Math.min(weekly,pooled.weekly+credited-held.weekly);
  }
  const fiveHour=pooled.fiveHour-held.fiveHour;
  return {spendablePercent:Math.min(weekly,fiveHour),pooled,held,measured:!!need,
    fiveHourBinds:Number.isFinite(fiveHour)&&fiveHour<=0&&fiveHour<=weekly,
    stale:Object.fromEntries(members.filter(member=>member.stale).map(member=>[member.account,member.stale!]))};
}
