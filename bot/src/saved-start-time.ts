/** The advertised time belongs to the current scheduled firing, never a retry backoff. */
export function savedStartAt(turn:{saved_kind:string;dispatch_failure_class:string|null;dispatch_next_attempt_ms:number|null}):string|null {
 return turn.saved_kind==='scheduled'&&turn.dispatch_failure_class!=='backoff'&&turn.dispatch_next_attempt_ms
  ?new Date(turn.dispatch_next_attempt_ms).toISOString():null;
}
