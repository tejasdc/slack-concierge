import type { Database } from 'bun:sqlite';

/** Ledger leases count the rows they changed, not the presentation journal's trigger writes.
 * Bun's run().changes includes those writes; SQLite changes() excludes them. Read it on the
 * same connection immediately after the synchronous write, before another statement can run.
 */
export function ledgerWriteResults(database: Database): Database {
  const directChanges = database.query('SELECT changes() AS count');
  const statements = new WeakMap<object, object>();
  function run(target: object, method: Function, args: unknown[]) {
    const result = Reflect.apply(method, target, args);
    if (!result || typeof result.changes !== 'number' || result.changes === 0) return result;
    return { ...result, changes: (directChanges.get() as { count: number }).count };
  }
  function statement(raw: any): any {
    const prior = statements.get(raw);
    if (prior) return prior;
    const proxy = new Proxy(raw, { get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property === 'run') return (...args: unknown[]) => run(target, value, args);
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, target, args);
        return result === target ? proxy : result;
      };
    }});
    statements.set(raw, proxy);
    return proxy;
  }
  return new Proxy(database, { get(target, property) {
    const value = Reflect.get(target, property, target);
    if (property === 'query' || property === 'prepare')
      return (...args: unknown[]) => statement(Reflect.apply(value, target, args));
    if (property === 'run') return (...args: unknown[]) => run(target, value, args);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
}
