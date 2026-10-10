import { currentAccount, listProfiles } from './provider-accounts';
import { providerAccountUsage } from './provider-account-usage';
import { savedWorkAccountRooms } from './provider-account-dispatch';
import { NOTICE_AT_PERCENT, usagePressureBrief } from './provider-usage-forecast';
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
    const storedClaude = provider === 'claude-code'
      ? new Set(listProfiles(provider).filter(profile => profile.signedIn).map(profile => profile.label)) : null;
    for (const room of rooms) {
      const cachedReset = provider === 'claude-code' ? claudeAccountCachedReset(room.account) : null;
      // A real usage refusal can make an account fail a fresh launch proof until its reset.
      // It is still a valid *wait* target when its stored login and reset are known.
      const canWaitForReset = !!cachedReset && !!storedClaude?.has(room.account);
      if (room.problem || room.tightestUsedPercent === null || (!room.home && !room.isDefault && !canWaitForReset)) continue;
      const account = usage.accounts.find(value => value.label === room.account);
      if (!account) continue;
      if (provider === 'codex' && account.label !== currentAccount('codex')?.label) continue;
      const relevant = account.windows.filter(window => window.name !== 'Weekly · Fable only');
      if (!relevant.length || relevant.some(window => !Number.isFinite(window.usedPercent))) continue;
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

/** A running Claude agent's independent helper can use Codex while its own allowance is under pressure. */
export function codexRoomForClaudeDelegation(now = Date.now()): { claudeUsed: number; codexUsed: number } | null {
  const claude = newWorkCapacity('claude-code', now);
  const codex = newWorkCapacity('codex', now);
  if (!claude || !codex || codex.used >= 100 || codex.used >= claude.used) return null;
  if (claude.used < NOTICE_AT_PERCENT && !usagePressureBrief('claude-code')) return null;
  return { claudeUsed: claude.used, codexUsed: codex.used };
}

/** The same fresh account evidence used for delegation is named in each agent budget brief. */
export function budgetBriefWithProviderRoom(provider: 'claude-code' | 'codex', now = Date.now()): string | null {
  const forecast = usagePressureBrief(provider);
  const own = newWorkCapacity(provider, now);
  if (!forecast && (!own || own.used < NOTICE_AT_PERCENT)) return null;
  const other = provider === 'claude-code' ? 'codex' : 'claude-code';
  const elsewhere = newWorkCapacity(other, now);
  const name = (key: 'claude-code' | 'codex') => key === 'codex' ? 'Codex' : 'Claude';
  const facts = `${name(provider)} new-session allowance: ${own ? `${own.used}% used` : 'unverified'}. `
    + `${name(other)} new-session allowance: ${elsewhere ? `${elsewhere.used}% used` : 'unverified'}. `
    + 'The owner checks again when a helper request is created.';
  const codex = provider === 'claude-code' ? codexRoomForClaudeDelegation(now) : null;
  const action = codex
    ? 'Delegate bounded implementation to an independent Codex session through sessions ask --project without --provider. The owner makes that choice automatically while this pressure and Codex room persist. Review its result before you finish; this running Claude session keeps its provider.'
    : 'Continue the accepted work. A helper request without a provider uses the owner\'s current account choice; no other provider has been established as the roomier delegation target.';
  return [forecast ?? `Budget: this ${name(provider)} provider is at or above ${NOTICE_AT_PERCENT}% of its usable allowance.`, facts, action].join(' ');
}

export function chooseProviderForNewWork(canStart: (provider: 'claude-code' | 'codex') => boolean,
  now = Date.now(), delegatedFromClaude = false): 'claude-code' | 'codex' {
  const candidates = candidatesForNewWork(now).filter(candidate => canStart(candidate.provider));
  if (delegatedFromClaude && canStart('codex') && codexRoomForClaudeDelegation(now)) return 'codex';
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
