import type {Database} from 'bun:sqlite';

export function answerClosingLine(database:Database,sessionId:number,postId:string,answersQuestion:boolean):string|null {
  const replyEventId=postId.startsWith('post:forward:')?postId.slice('post:forward:'.length):postId;
  let rows=database.query('SELECT payload_json FROM session_owner_events WHERE event_id IN (?,?) ORDER BY sequence')
    .all(`post:closure:${replyEventId}`,`post:closure:${postId}`) as {payload_json:string}[];
  // A bodyless final attaches its closure to an earlier answer post. Its reply event ID cannot
  // be derived from the post ID, so follow the retained post association for that case.
  if(!rows.length&&answersQuestion)rows=database.query(`SELECT payload_json FROM session_owner_events
    WHERE session_id=? AND kind='answer_closure' AND json_extract(payload_json,'$.postId')=? ORDER BY sequence`)
    .all(sessionId,postId) as {payload_json:string}[];
  const lines=[...new Set(rows.map(row=>JSON.parse(row.payload_json).closingLine).filter((line):line is string=>typeof line==='string'&&!!line))];
  return lines.length?lines.join('\n'):null;
}
