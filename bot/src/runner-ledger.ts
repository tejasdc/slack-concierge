import type {RunnerLeases as Leases} from './runner-leases';
import {RunnerLeases} from './runner-leases';

/**
 * The owner's one lease engine over its ledger, opened on first use so that importing runner code
 * opens no database. A check supplies an in-memory ledger instead (runner-turn-check.ts).
 */
let leases:Leases|null=null;
export function runnerLedger():Leases {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return leases??=new RunnerLeases(require('./state-database').db);
}
export function useRunnerLedger(engine:Leases){leases=engine;}
