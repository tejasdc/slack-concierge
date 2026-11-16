import {AsyncResource} from 'node:async_hooks';

/** Admission is lexical: a transaction's synchronous observers share its permission,
 * while a continuation after await must enter again. AsyncLocalStorage is deliberately
 * not used, because its inherited lifetime would authorize detached work after a freeze. */
export type LedgerSegment<T> = (() => T) & (T extends PromiseLike<unknown> ? never : unknown);

export class LedgerAdmission {
  private enabled = false;
  private depth = 0;
  private epoch = 0;
  private phase: 'serving' | 'maintenance' | 'failed' = 'serving';
  private waiting: Array<() => void> = [];
  private current: Promise<void> | null = null;
  private scheduled = false;
  private onViolation:((error:Error)=>void)|undefined;
  private onUnadmitted:((error:Error)=>void)|undefined;

  enable(onViolation?:(error:Error)=>void, onUnadmitted?:(error:Error)=>void): void { this.enabled = true;this.onViolation=onViolation;this.onUnadmitted=onUnadmitted; }

  snapshot() {
    return { enabled: this.enabled, phase: this.phase, epoch: this.epoch,
      pending: this.waiting.length, insideSegment: this.depth > 0 };
  }

  /** A statement outside a segment can only contend with the checkpoint worker while a
   * maintenance epoch holds its writer lock; that is fatal before SQLite is entered. While
   * serving, no maintenance can begin under a synchronous statement, so a missed wrap is
   * reported with its stack and allowed rather than ending the owner. */
  assertSegment(): void {
    if (this.enabled && this.depth === 0) {
      const error=new Error('LEDGER_OPERATION_NOT_ADMITTED');
      if (this.phase === 'serving') { this.onUnadmitted?.(error); return; }
      this.onViolation?.(error);
      throw error;
    }
  }

  /** Synchronous entry is only for nested work or an exit path that can spill on refusal.
   * Independently scheduled work uses run(), which preserves its closure while frozen. */
  synchronous<T>(operation: LedgerSegment<T>): T {
    if (this.enabled && this.phase !== 'serving' && this.depth === 0)
      throw new Error('LEDGER_MAINTENANCE_PENDING');
    this.depth++;
    try {
      const result = operation();
      if (result && typeof (result as { then?: unknown }).then === 'function')
        throw new Error('LEDGER_OPERATION_MUST_BE_SYNCHRONOUS');
      return result;
    } finally { this.depth--; }
  }

  run<T>(operation: LedgerSegment<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Preserve the existing request's attribution/telemetry context while its
      // closure waits. Permission itself is the depth counter, never async context.
      const execute = AsyncResource.bind(() => {
        try { resolve(this.synchronous(operation)); } catch (error) { reject(error); }
      });
      if (!this.enabled || this.depth > 0 || this.phase === 'serving' && !this.waiting.length && !this.scheduled)
        execute();
      else { this.waiting.push(execute); this.schedule(); }
    });
  }

  /** The caller owns durability proof, worker identity and native completion. On failure
   * the gate stays closed: an ended attempt is not evidence that its writer lock is gone. */
  maintain(operation: (epoch: number) => Promise<void>): Promise<void> {
    if (!this.enabled) return Promise.reject(new Error('LEDGER_ADMISSION_NOT_ENABLED'));
    if (this.current || this.phase !== 'serving')
      return Promise.reject(new Error('LEDGER_MAINTENANCE_ALREADY_PENDING'));
    this.phase = 'maintenance';
    const epoch = ++this.epoch;
    const current = Promise.resolve().then(() => operation(epoch)).then(() => {
      if (this.phase !== 'maintenance' || this.epoch !== epoch)
        throw new Error('LEDGER_MAINTENANCE_IDENTITY_CHANGED');
      this.phase = 'serving';
      this.current = null;
      this.schedule();
    }).catch(error => {
      this.phase = 'failed';
      throw error;
    });
    this.current = current;
    return current;
  }

  pendingMaintenance(): Promise<void> { return this.current ?? Promise.resolve(); }

  private schedule(): void {
    if (this.scheduled || this.phase !== 'serving' || !this.waiting.length) return;
    this.scheduled = true;
    // Return to the native loop between complete operations, so replaying a held callback
    // burst cannot itself starve memory-only owner control. No time-based pacing is added.
    setImmediate(() => {
      this.scheduled = false;
      if (this.phase !== 'serving') return;
      this.waiting.shift()?.();
      this.schedule();
    });
  }
}

const admission = new LedgerAdmission();
export const runLedgerSegment = <T>(operation: LedgerSegment<T>): Promise<T> => admission.run<T>(operation);
export const runSynchronousLedgerSegment = <T>(operation: LedgerSegment<T>): T => admission.synchronous<T>(operation);
export const assertLedgerSegment = (): void => admission.assertSegment();
export const enableLedgerAdmission = (onViolation?:(error:Error)=>void, onUnadmitted?:(error:Error)=>void): void => admission.enable(onViolation, onUnadmitted);
export const ledgerAdmissionSnapshot = () => admission.snapshot();
export const maintainLedger = (operation: (epoch: number) => Promise<void>): Promise<void> => admission.maintain(operation);
export const pendingLedgerMaintenance = (): Promise<void> => admission.pendingMaintenance();

/** SELECT-only housekeeping (notably original-connection total_changes) stays
 * available to the durability pump during a freeze. Unknown SQL, transactions,
 * PRAGMAs and iterator continuations all require a complete lexical operation. */
export function assertLedgerSql(sql:string):void {
  if(!/^\s*SELECT\b/i.test(sql)||sql.includes(';'))admission.assertSegment();
}

/** Each generator step is a complete synchronous operation. Yield only at existing
 * external waits: the continuation acquires a fresh lexical permit, including when
 * rejection resumes a catch/finally arm. The generator never owns permission while
 * its yielded promise is pending. */
export function runLedgerSteps<T>(steps: Generator<unknown, T, any>): Promise<Awaited<T>> {
  return new Promise((resolve, reject) => {
    const advance = (method: 'next' | 'throw', value?: unknown): void => {
      void runLedgerSegment(() => steps[method](value)).then(result => {
        if (result.done) { resolve(result.value as Awaited<T>); return; }
        Promise.resolve(result.value).then(
          value => advance('next', value),
          error => advance('throw', error),
        );
      }, reject);
    };
    advance('next');
  });
}

export function ledgerCallback<F extends (...args:any[])=>any>(callback:F) {
  return function(this:unknown,...args:Parameters<F>):Promise<Awaited<ReturnType<F>>> {
    const receiver=this;
    return runLedgerSteps((function*(){return callback.apply(receiver,args);})());
  };
}
