import { currentAccount } from './provider-accounts';
import { providerAccountUsage } from './provider-account-usage';
import { savedWorkAccountRooms } from './provider-account-dispatch';
import { NOTICE_AT_PERCENT } from './provider-usage-forecast';
import { claudeAccountCachedReset } from './provider-usage';

type Candidate = { provider: 'claude-code' | 'codex'; used: number; resetsAt: number | null; windowResetAt: number | null };
const FRESH_MS = 6 * 60_000;

/** New, unbound work only. A running session never changes provider. */
function candidatesForNewWork(now: number): Candidate[] {
  const candidates: Candidate[] = [];
  for (const provider of ['claude-code', 'codex'] as const) {
    const usage = providerAccountUsage(provider);
    const observedAt = Date.parse(usage?.observedAt ?? '');
    if (!usage || usage.problem || !Number.isFinite(observedAt) || observedAt < now - FRESH_MS) continue;
    const rooms = savedWorkAccountRooms(provider, usage, now);
    for (const room of rooms) {
      if (room.problem || room.tightestUsedPercent === null || (!room.home && !room.isDefault)) continue;
      const account = usage.accounts.find(value => value.label === room.account);
      if (!account) continue;
      if (provider === 'codex' && account.label !== currentAccount('codex')?.label) continue;
      const relevant = account.windows.filter(window => window.name !== 'Weekly · Fable only');
      if (!relevant.length || relevant.some(window => !Number.isFinite(window.usedPercent))) continue;
      const cachedReset = provider === 'claude-code' ? claudeAccountCachedReset(account.label) : null;
      const used = cachedReset ? 100 : Math.max(...relevant.map(window => window.usedPercent));
      const spent = relevant.filter(window => window.usedPercent >= 100)
        .map(window => Date.parse(window.resetsAt ?? '')).filter(Number.isFinite);
      if (cachedReset) spent.push(cachedReset);
      const tightest = relevant.reduce((best, window) => window.usedPercent > best.usedPercent ? window : best);
      const windowResetAt = Date.parse(tightest.resetsAt ?? '');
      candidates.push({ provider, used, resetsAt: spent.length ? Math.max(...spent) : null,
        windowResetAt: Number.isFinite(windowResetAt) ? windowResetAt : null });
    }
  }
  return candidates;
}

export function newWorkHeadroom(provider: 'claude-code' | 'codex', now = Date.now()): number | null {
  return newWorkCapacity(provider, now)?.used ?? null;
}

export function newWorkCapacity(provider: 'claude-code' | 'codex', now = Date.now()): Candidate | null {
  return candidatesForNewWork(now).filter(candidate => candidate.provider === provider)
    .sort((a,b) => a.used - b.used || (a.windowResetAt ?? Infinity) - (b.windowResetAt ?? Infinity))[0] ?? null;
}

export function chooseProviderForNewWork(canStart: (provider: 'claude-code' | 'codex') => boolean,
  now = Date.now()): 'claude-code' | 'codex' {
  const candidates = candidatesForNewWork(now).filter(candidate => canStart(candidate.provider));
  const available = candidates.filter(candidate => candidate.used < 100);
  if (available.length) {
    const claude = available.filter(candidate => candidate.provider === 'claude-code')
      .sort((a,b) => a.used - b.used)[0];
    if (claude && claude.used < NOTICE_AT_PERCENT) return 'claude-code';
    return available.sort((a,b) => a.used - b.used)[0]!.provider;
  }
  const resetting = candidates.filter(candidate => candidate.resetsAt !== null)
    .sort((a,b) => a.resetsAt! - b.resetsAt!);
  if (resetting.length) return resetting[0]!.provider;
  throw new Error('Current provider allowance readings cannot establish a safe start for new work.');
}
