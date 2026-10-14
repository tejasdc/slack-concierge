import {createHash} from 'node:crypto';
import { BUDGET_NOTICE_MAX_AGE_MS, currentAccount, listProfiles } from './provider-accounts';
import { providerAccountUsage } from './provider-account-usage';
import { accountReadingFresh,includedAllowanceWindows } from './account-allowance-observation';
import { savedWorkAccountRooms } from './provider-account-dispatch';
import { NOTICE_AT_PERCENT, storedUsage } from './provider-usage-forecast';
import { claudeAccountCachedReset } from './provider-usage';
import {AUTOMATIC_PROVIDER_ALIASES,resolveProviderAlias, providerDisplayName } from './aliases';
import {modelCapacityRefused} from './provider-model-capacity';

export type AutomaticProvider = keyof typeof AUTOMATIC_PROVIDER_ALIASES;
type Candidate = { provider: AutomaticProvider; account: string; used: number; resetsAt: number | null; windowResetAt: number | null };

/** New, unbound work only. A running session never changes provider. */
function candidatesForNewWork(now: number): Candidate[] {
  const candidates: Candidate[] = [];
  for (const provider of Object.keys(AUTOMATIC_PROVIDER_ALIASES) as AutomaticProvider[]) {
    const model=resolveProviderAlias(AUTOMATIC_PROVIDER_ALIASES[provider]).model;
    if(model&&modelCapacityRefused(provider,model,now))continue;
    const usage = providerAccountUsage(provider);
    if (!usage || usage.problem) continue;
    const rooms = savedWorkAccountRooms(provider, usage, now, model);
    const storedClaude = provider === 'claude-code'
      ? new Set(listProfiles(provider).filter(profile => profile.signedIn).map(profile => profile.label)) : null;
    for (const room of rooms) {
      const cachedReset = provider === 'claude-code' ? claudeAccountCachedReset(room.account,model) : null;
      // A real usage refusal can make an account fail a fresh launch proof until its reset.
      // It is still a valid *wait* target when its stored login and reset are known.
      const canWaitForReset = !!cachedReset && !!storedClaude?.has(room.account);
      if (room.problem || room.tightestUsedPercent === null || (!room.home && !room.isDefault && !canWaitForReset)) continue;
      const account = usage.accounts.find(value => value.label === room.account);
      if (!account || !accountReadingFresh(provider,usage,account,now,undefined,model)) continue;
      if (provider === 'codex' && account.label !== currentAccount('codex')?.label) continue;
      const relevant = includedAllowanceWindows(provider,account,model);
      if (!relevant.length || relevant.some(window => !Number.isFinite(window.usedPercent))) continue;
      const used = cachedReset ? 100 : Math.max(...relevant.map(window => window.usedPercent));
      const spent = relevant.filter(window => window.usedPercent >= 100)
        .map(window => Date.parse(window.resetsAt ?? '')).filter(Number.isFinite);
      if (cachedReset) spent.push(cachedReset);
      const tightest = relevant.reduce((best, window) => window.usedPercent > best.usedPercent ? window : best);
      const windowResetAt = Date.parse(tightest.resetsAt ?? '');
      candidates.push({ provider, account: account.label, used, resetsAt: spent.length ? Math.max(...spent) : null,
        windowResetAt: Number.isFinite(windowResetAt) ? windowResetAt : null });
    }
  }
  return candidates;
}

export function newWorkHeadroom(provider: 'claude-code' | 'codex', now = Date.now()): number | null {
  return newWorkCapacity(provider, now)?.used ?? null;
}

export function newWorkCapacity(provider: AutomaticProvider, now = Date.now()): Candidate | null {
  return candidatesForNewWork(now).filter(candidate => candidate.provider === provider)
    .sort((a,b) => a.used - b.used || (a.windowResetAt ?? Infinity) - (b.windowResetAt ?? Infinity))[0] ?? null;
}

/** A running Claude agent's independent helper can use Codex while its own allowance is under pressure. */
export function codexRoomForClaudeDelegation(now = Date.now(), accountLabel?: string): { claudeUsed: number; codexUsed: number } | null {
  const usage = storedUsage('claude-code');
  const selected = usage?.accounts.find(account => account.current)?.label;
  // Automatic dispatch compares the selected launchable account. A run on another
  // account must not be promised Codex delegation from that comparison.
  if (accountLabel && selected !== accountLabel) return null;
  if (!measuredBudgetPressure('claude-code', accountLabel, now)) return null;
  const claude = newWorkCapacity('claude-code', now);
  const codex = newWorkCapacity('codex', now);
  if (!claude || !codex || codex.used >= 100 || codex.used >= claude.used) return null;
  return { claudeUsed: claude.used, codexUsed: codex.used };
}

/** A threshold notice is an Accounts reading, never a dispatch estimate or cached refusal. */
export function measuredBudgetPressure(provider: 'claude-code' | 'codex', accountLabel?: string, now = Date.now()) {
  const usage = storedUsage(provider);
  if (!usage || usage.problem) return null;
  const account = accountLabel
    ? usage.accounts.find(value => value.label === accountLabel)
    : usage.accounts.find(value => value.current);
  if (!account || !accountReadingFresh(provider,usage,account,now,BUDGET_NOTICE_MAX_AGE_MS)) return null;
  const observedAt = Date.parse(account.readAt!);
  const window = account.windows.filter(value => value.name !== 'Weekly · Fable only'
    && Number.isFinite(value.usedPercent) && value.usedPercent >= NOTICE_AT_PERCENT)
    .sort((left, right) => right.usedPercent - left.usedPercent)[0];
  return window ? { account: account.label, window: window.name, usedPercent: window.usedPercent,
    resetsAt: window.resetsAt, observedAt: new Date(observedAt).toISOString() } : null;
}

/** State the measured threshold separately from the operational choice for a new helper. */
export function budgetBriefWithProviderRoom(provider: 'claude-code' | 'codex', now = Date.now(), accountLabel?: string): string | null {
  const pressure = measuredBudgetPressure(provider, accountLabel, now);
  if (!pressure) return null;
  const name = (key: 'claude-code' | 'codex') => providerDisplayName(key) ?? key;
  const codex = provider === 'claude-code' ? codexRoomForClaudeDelegation(now, pressure.account) : null;
  const action = codex
    ? 'Delegate bounded implementation to an independent Codex session through sessions ask --project without --provider. The owner makes that choice automatically while this pressure and Codex room persist. Review its result before you finish; this running Claude session keeps its provider.'
    : 'Continue the accepted work. A helper request without a provider uses the owner\'s current account choice; no other provider has been established as the roomier delegation target.';
  const machine = process.platform === 'darwin' ? 'your Mac' : 'the server';
  return [`Budget: Accounts on ${machine} measured ${name(provider)} account ${pressure.account}, ${pressure.window}: ${pressure.usedPercent}% used at ${pressure.observedAt}.`,
    `This is the provider's usage reading. New helper dispatch checks account availability again when requested; a prior refusal can hold a request even when this reading shows room.`,
    action].join(' ');
}

/** A stable request ID spreads starts in proportion to verified remaining allowance.
 * The 90% warning is already the reserve boundary: use accounts below it first. */
export function chooseProviderForNewWork(canStart: (provider: AutomaticProvider) => boolean,
  choiceKey: string, now = Date.now(), delegatedFromClaude = false, smallTask = false): AutomaticProvider {
  if (!choiceKey) throw new Error('Automatic provider choice needs the accepted action identity.');
  const eligible = (smallTask ? ['claude-code','codex','antigravity'] : ['claude-code','codex']) as AutomaticProvider[];
  const rooms = candidatesForNewWork(now);
  const candidates = eligible.flatMap(provider => {
    const candidate = rooms.filter(room => room.provider === provider)
      .sort((a,b) => a.used - b.used || (a.windowResetAt ?? Infinity) - (b.windowResetAt ?? Infinity))[0];
    return candidate && canStart(provider) ? [candidate] : [];
  });
  if (!smallTask && delegatedFromClaude && canStart('codex') && codexRoomForClaudeDelegation(now)) return 'codex';
  const available = candidates.filter(candidate => candidate.used < 100);
  if (available.length) {
    const belowReserve = available.filter(candidate => candidate.used < NOTICE_AT_PERCENT);
    const pool = belowReserve.length ? belowReserve : available;
    const total = pool.reduce((sum,candidate) => sum + 100 - candidate.used, 0);
    const fraction = createHash('sha256').update(choiceKey).digest().readUInt32BE(0) / 0x1_0000_0000;
    let point = fraction * total;
    for (const candidate of pool) {
      point -= 100 - candidate.used;
      if (point < 0) return candidate.provider;
    }
    return pool.at(-1)!.provider;
  }
  const resetting = candidates.filter(candidate => candidate.resetsAt !== null)
    .sort((a,b) => a.resetsAt! - b.resetsAt!);
  if (resetting.length) return resetting[0]!.provider;
  throw new Error('Current provider allowance readings cannot establish a safe start for new work.');
}
