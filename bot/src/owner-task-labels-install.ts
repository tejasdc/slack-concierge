/** Installed before anything else in the owner process, so timers started at import time are labelled. */
import {installOwnerTaskLabels} from './owner-task-labels';
import {openStorageStep, startStorageIntervals} from './storage-interval';
installOwnerTaskLabels();
// Ledger time counts from the first statement, so the watchdog's ledger_wait_ms covers startup too.
// It was enabled only once the owner object existed, and a 126 s start reported 0 ms (incident ce2c2192).
startStorageIntervals();
/** Ledger work done while the owner's modules load (their schema and migration statements run at import). */
export const closeModuleLoadStorage = openStorageStep();
