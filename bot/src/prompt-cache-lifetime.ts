/** Claude's extended cache lifetime for the main conversation and standard lifetime for helpers. */
export const CLAUDE_MAIN_CACHE_LIFETIME_MS = 60 * 60_000;
export const CLAUDE_HELPER_CACHE_LIFETIME_MS = 5 * 60_000;

/** Only the current conversation's most recent real response can justify account affinity. */
export function warmClaudeAccount(
  call:{account:string;conversation:string|null;atMs:number;cacheable:boolean}|null,
  previousAccount:string|null,conversation:string|null,nowMs:number,
):string|null {
  if(!call||!call.cacheable||!previousAccount||!conversation
    ||call.account!==previousAccount||call.conversation!==conversation)return null;
  const age=nowMs-call.atMs;
  return age>=0&&age<CLAUDE_MAIN_CACHE_LIFETIME_MS?call.account:null;
}
