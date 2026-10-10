/**
 * A helper process must never outlive the process that started it. Linux children are started
 * under `setpriv --pdeathsig KILL`, but macOS has no equivalent, and a graceful stop can wait on
 * a connection that never closes. On 2026-10-10 the Mac's 12:45 AM update stopped the owner while
 * its foreground gateway was still finishing a graceful stop: the gateway outlived it, kept its
 * readers' sockets, and every one of ~580 restarts over two hours refused to start, so the server
 * could not reach the Mac at all.
 *
 * Two rules, both enforced here so no caller has to remember them:
 * - once a stop begins, the process exits by a deadline whether or not the stop finished;
 * - a process whose parent is gone (re-parented, on any platform) stops at once and exits by the
 *   short deadline, because nobody is left to enforce the parent's own kill timer.
 */
const PARENT_GONE_EXIT_MS=5_000;
const PARENT_CHECK_MS=1_000;

let exitAt=Number.POSITIVE_INFINITY;
let exitTimer:ReturnType<typeof setTimeout>|null=null;

/** Exit no later than `ms` from now; an earlier deadline already armed is kept. */
export function exitWithin(ms:number) {
  const at=Date.now()+ms;
  if(at>=exitAt)return;
  exitAt=at;
  if(exitTimer)clearTimeout(exitTimer);
  exitTimer=setTimeout(()=>process.exit(0),ms);
}

/** Calls `stop` when the parent process goes away, and exits within five seconds of that. */
export function exitWithParent(stop:()=>void) {
  const parent=process.ppid;
  const check=setInterval(()=>{
    if(process.ppid===parent)return;
    clearInterval(check);
    exitWithin(PARENT_GONE_EXIT_MS);
    stop();
  },PARENT_CHECK_MS);
  check.unref();
}

export {PARENT_GONE_EXIT_MS};
