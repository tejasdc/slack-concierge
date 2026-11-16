/**
 * Which thread messages give an Inbox thread its time, its unread mark and its place in his
 * Threads list. A thread rises when something changes for him: his own message, an answer, a
 * question, a result. It never rises for agent upkeep on it: an agent handing the thread's work to
 * another agent (the `request:` handoff card, including every re-send) or a progress-only partial
 * reply (a `return:` that is not the worker's final answer; a partial that answers him is also
 * posted, and the post counts).
 *
 * On 2026-11-11 the Inbox re-sent about thirty old requests and each re-send put its thread at the
 * top of Threads, so he "couldn't find anything" (bug report topic:7375afd2). Housekeeping on the
 * thread record (renames, links, flags, settling) already moved nothing; this closes the same gap
 * for the agent-to-agent messages that are shown in the conversation. They stay visible there.
 * A thread's opening message counts: an agent's report to him opens its thread with the
 * handoff itself, and that thread is new to him. Concierge's own upkeep notices never count,
 * even as an opening message: the Inbox router files each recovery notice into the thread whose
 * request it concerns, which makes it a root there. On 2026-11-12 about thirty recovery notices
 * filed that way lifted a week of old threads to the top together (topic:ea98c6e2). Under such a
 * notice only a deliberate post or an agent's final answer counts: the router's own working output
 * in the turn that handled the notice is filed under it too, and after the first fix it still
 * lifted threads (topic:fb6aba45 at 20:30:10 the same day).
 */
export type ThreadEntryKind='final'|'post'|'other';

/** Inputs the owner itself sends the Inbox router about existing work: never news for him. */
export const OWNER_UPKEEP_INPUT_PREFIXES=['thread-upkeep:','unfiled-wake:'] as const;

const isOwnerUpkeep=(id:string)=>OWNER_UPKEEP_INPUT_PREFIXES.some(prefix=>id.startsWith(prefix));
const upkeepSql=(column:string)=>`(${OWNER_UPKEEP_INPUT_PREFIXES.map(prefix=>`${column} LIKE '${prefix}%'`).join(' OR ')})`;

export function movesThreadForHim(messageId:string,entryKind:ThreadEntryKind,root:string):boolean {
  if(isOwnerUpkeep(messageId))return false;
  if(isOwnerUpkeep(root))return entryKind==='final'||entryKind==='post';
  if(messageId===root)return true;
  if(messageId.startsWith('request:'))return false;
  if(messageId.startsWith('return:')&&entryKind!=='final')return false;
  return true;
}

/** The same rule over the prepared message table's columns. */
export const movesThreadForHimSql=`(NOT ${upkeepSql('message_id')}
  AND (NOT ${upkeepSql('root_input_id')} OR entry_kind IN ('final','post'))
  AND (message_id=root_input_id OR NOT (message_id LIKE 'request:%' OR (message_id LIKE 'return:%' AND entry_kind<>'final'))))`;
