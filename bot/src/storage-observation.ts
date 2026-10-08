import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { observeSynchronousStorage } from './storage-interval';

/** Result bytes are measured from values, without making a second JSON copy. They exclude
 * object overhead and wire encoding: response bytes and RSS are separate observations. */
export type StorageWork = {
  db_calls: number;
  db_duration_ms: number;
  db_rows: number;
  db_result_bytes: number;
  db_errors: number;
  db_slowest_fingerprint: string | null;
  db_slowest_ms: number;
};
type Scope = { work: StorageWork; closed: boolean };
const scopes = new AsyncLocalStorage<Scope>();
export type StorageReadBudget={maxCalls:number;maxRows:number;maxResultBytes:number};
const readBudgets=new AsyncLocalStorage<StorageReadBudget>();
export class StorageReadBudgetError extends Error {
  readonly code='READ_BUDGET_EXCEEDED';
  constructor(readonly reason:'unbounded_collection'|'write_in_reader'|'calls'|'rows'|'bytes'){
    super(`Interactive read refused: ${reason}.`);
  }
}
export function withStorageReadBudget<T>(budget:StorageReadBudget,read:()=>T):T {
  // A caller cannot accidentally disable enforcement by omitting telemetry setup.
  return scopes.getStore()&&!scopes.getStore()!.closed?readBudgets.run(budget,read):
    observeStorageOperation('bounded-read',()=>readBudgets.run(budget,read),()=>{});
}
function admitRead(sql:string,method:string,work:StorageWork){
  const budget=readBudgets.getStore();if(!budget)return;
  // WITH can prefix UPDATE/DELETE ... RETURNING as well as SELECT. Prepared readers
  // currently need only SELECT; extending this grammar needs an engine-backed check.
  if(!/^\s*SELECT\b/i.test(sql)||method==='run'||method==='exec')throw new StorageReadBudgetError('write_in_reader');
  if(method==='iterate'||(['all','values'].includes(method)&&!/\bLIMIT\s+(?:\?|\$[\w]+|[0-9]+)(?:\s+OFFSET\s+(?:\?|[0-9]+))?\s*;?\s*$/i.test(sql)))
    throw new StorageReadBudgetError('unbounded_collection');
  if(work.db_calls>=budget.maxCalls)throw new StorageReadBudgetError('calls');
}
function checkRead(work:StorageWork){
  const budget=readBudgets.getStore();if(!budget)return;
  if(work.db_rows>budget.maxRows)throw new StorageReadBudgetError('rows');
  if(work.db_result_bytes>budget.maxResultBytes)throw new StorageReadBudgetError('bytes');
}
let observationFailures = 0;
export const storageObservationFailures = () => observationFailures;
const empty = (): StorageWork => ({ db_calls: 0, db_duration_ms: 0, db_rows: 0,
  db_result_bytes: 0, db_errors: 0, db_slowest_fingerprint: null, db_slowest_ms: 0 });

export function observeStorageOperation<T>(operation: string, callback: () => T,
  finished: (work: StorageWork) => void): T {
  // The caller owns the bounded operation vocabulary; neither SQL nor parameters leave here.
  void operation;
  const scope: Scope = { work: empty(), closed: false };
  const finish = () => {
    if (scope.closed) return;
    scope.closed = true;
    // Observation failures must never replace the product's result or exception.
    try { finished({ ...scope.work }); } catch { observationFailures++; }
  };
  return scopes.run(scope, () => {
    try {
      const result = callback();
      if (result && typeof (result as any).then === 'function')
        return Promise.resolve(result).finally(finish) as T;
      finish();
      return result;
    } catch (error) { finish(); throw error; }
  });
}

function rowBytes(row: unknown): number {
  if (!row || typeof row !== 'object') return 0;
  let bytes = 0;
  for (const key in row) {
    const value = (row as Record<string, unknown>)[key];
    if (typeof value === 'string') bytes += Buffer.byteLength(value);
    else if (typeof value === 'number' || typeof value === 'bigint') bytes += 8;
    else if (ArrayBuffer.isView(value)) bytes += value.byteLength;
  }
  return bytes;
}

/** Wrap once at the existing ledger boundary; future query callers are observed automatically.
 * Weak maps do not extend a prepared statement's lifetime. No per-query history is retained. */
export function observedDatabase(database: Database): Database {
  const statements = new WeakMap<object, object>();
  const transactions = new WeakMap<Function, Function>();
  const fingerprintOf = (sql: string) => createHash('sha256').update(sql).digest('hex').slice(0, 16);
  function transaction(raw: Function): Function {
    const prior = transactions.get(raw);
    if (prior) return prior;
    const wrapped = function(this: unknown, ...args: any[]) {
      return observeSynchronousStorage('transaction', null, () => Reflect.apply(raw, this, args));
    };
    transactions.set(raw, wrapped);
    // Bun's variants are non-configurable properties: proxying those to different values
    // violates JavaScript's proxy invariant. Copy their descriptors onto our callable instead.
    for (const key of Reflect.ownKeys(raw)) {
      if (['arguments', 'caller', 'prototype'].includes(String(key))) continue;
      const descriptor = Object.getOwnPropertyDescriptor(raw, key)!;
      if (['default', 'deferred', 'immediate', 'exclusive'].includes(String(key)) && typeof descriptor.value === 'function')
        descriptor.value = transaction(descriptor.value);
      Object.defineProperty(wrapped, key, descriptor);
    }
    return wrapped;
  }
  function statement(raw: any, sql: string): any {
    const prior = statements.get(raw);
    if (prior) return prior;
    const fingerprint = fingerprintOf(sql);
    const measured = <T>(read: () => T): T => observeSynchronousStorage('statement', () => fingerprint, read);
    const record = (scope: Scope, started: number, result: any, method: string, failed: boolean, count = true) => {
      if (scope.closed) return;
      const elapsed = performance.now() - started;
      const work = scope.work;
      if (count) work.db_calls++;
      work.db_duration_ms += elapsed;
      if (failed) work.db_errors++;
      if (method === 'all' || method === 'values') {
        work.db_rows += result?.length ?? 0;
        if (result) for (const row of result) work.db_result_bytes += rowBytes(row);
      } else if (method === 'get' && result != null) {
        work.db_rows++;
        work.db_result_bytes += rowBytes(result);
      }
      if (elapsed > work.db_slowest_ms) {
        work.db_slowest_ms = elapsed;
        work.db_slowest_fingerprint = fingerprint;
      }
    };
    const proxy = new Proxy(raw, { get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property === 'as') return (...args: any[]) => statement(Reflect.apply(value, target, args), sql);
      if (property === 'iterate') return (...args: any[]) => {
        const scope = scopes.getStore();
        if(scope&&!scope.closed)admitRead(sql,'iterate',scope.work);
        const iterator = measured(() => Reflect.apply(value, target, args));
        let first = true;
        return new Proxy(iterator, { get(iter, key) {
          if (key === Symbol.iterator) return function() { return this; };
          const member = Reflect.get(iter, key, iter);
          if (typeof member !== 'function') return member;
          if (key !== 'next') return (...args: any[]) => measured(() => Reflect.apply(member, iter, args));
          return (...nextArgs: any[]) => {
            const started = performance.now();
            try {
              const result = measured(() => Reflect.apply(member, iter, nextArgs));
              if (scope && !scope.closed) record(scope, started, result.done ? null : result.value, 'get', false, first);
              first = false;
              return result;
            } catch (error) { if (scope && !scope.closed) record(scope, started, null, 'get', true, first); first = false; throw error; }
          };
        }});
      };
      if (!['get', 'all', 'values', 'run'].includes(String(property))) return value.bind(target);
      return (...args: any[]) => {
        const scope = scopes.getStore();
        if (!scope || scope.closed) return measured(() => Reflect.apply(value, target, args));
        admitRead(sql,String(property),scope.work);
        const started = performance.now();
        let result:any;
        try {
          result = measured(() => Reflect.apply(value, target, args));
        } catch (error) { record(scope, started, null, String(property), true); throw error; }
        record(scope,started,result,String(property),false);
        checkRead(scope.work);
        return result;
      };
    }});
    statements.set(raw, proxy);
    return proxy;
  }
  return new Proxy(database, { get(target, property) {
    const value = Reflect.get(target, property, target);
    if (property === 'query' || property === 'prepare')
      return (sql: string, ...args: any[]) => statement(observeSynchronousStorage('statement', () => fingerprintOf(sql), () => Reflect.apply(value, target, [sql, ...args])), sql);
    if (property === 'transaction')
      return (...args: any[]) => transaction(Reflect.apply(value, target, args));
    if (property === 'exec' || property === 'run') return (...args: any[]) => {
      const scope = scopes.getStore();
      const measured = () => observeSynchronousStorage('statement', () => fingerprintOf(String(args[0])), () => Reflect.apply(value, target, args));
      if (!scope || scope.closed) return measured();
      admitRead(String(args[0]),String(property),scope.work);
      const started = performance.now();
      scope.work.db_calls++;
      try { return measured(); }
      catch (error) { scope.work.db_errors++; throw error; }
      finally { scope.work.db_duration_ms += performance.now() - started; }
    };
    return typeof value === 'function' ? value.bind(target) : value;
  }});
}
