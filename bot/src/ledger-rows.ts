import type {Database} from 'bun:sqlite';

/**
 * Rows one at a time for a loop that may stop early. Always use this instead of a statement's
 * own `iterate()`: a loop that breaks out of `iterate()` leaves the statement open, which keeps
 * this connection reading the ledger as it was at that moment. As soon as another process
 * commits (the deployment runner checking whether it may drain, a router command), every later
 * write on the connection fails at once with "database is locked", without waiting. On
 * 2026-10-07 a session search did exactly that, and the next write after the waiting
 * deployment's check took the whole service down twice in half an hour. Finalizing the
 * statement when the loop ends, however it ends, releases the snapshot. The release build
 * refuses a bare `.iterate(` anywhere else (scripts/retry-architecture-lint.ts).
 */
export function* ledgerRows<T>(database:Database,sql:string,...params:any[]):Generator<T> {
  const statement=database.prepare(sql);
  try {
    for(const row of statement.iterate(...params))yield row as T;
  } finally {
    statement.finalize();
  }
}
