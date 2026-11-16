import { createHash } from 'node:crypto';

/**
 * Spread starts across providers in proportion to each provider's total room across its accounts,
 * a stable request identity choosing the point, so equal readings still mix providers and the
 * same request always gets the same answer. Pure, so it can be run on readings without the ledger.
 *
 * `providerRoom` is the provider's whole remaining weekly room summed over every account it can run
 * on (one free account is 100 points); when no total is known the candidate's own room stands in.
 */
export function pickByProviderRoom<T extends { providerRoom: number; used: number }>(pool: readonly T[], choiceKey: string): T {
  const weight = (candidate: T) => candidate.providerRoom > 0 ? candidate.providerRoom : Math.max(0, 100 - candidate.used);
  const total = pool.reduce((sum, candidate) => sum + weight(candidate), 0);
  const fraction = createHash('sha256').update(choiceKey).digest().readUInt32BE(0) / 0x1_0000_0000;
  let point = fraction * total;
  for (const candidate of pool) {
    point -= weight(candidate);
    if (point < 0) return candidate;
  }
  return pool.at(-1)!;
}
