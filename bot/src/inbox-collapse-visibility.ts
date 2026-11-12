import type {Database} from 'bun:sqlite';

// These older collapses compared separately accepted replies. Their source posts remain
// authoritative and visible under the permanent duplicate-failure decision.
const restoredReasons=[
  'One identical final answer closed several requests.',
  'One agent update appears once in the thread.',
  'One stopped turn has one visible notice.',
];
const reasons=restoredReasons.map(reason=>`'${reason.replaceAll("'","''")}'`).join(',');
export const activePostCollapseSql=(alias:string,postIdSql:string)=>
  `${alias}.event_id='post:collapse:' || ${postIdSql} AND coalesce(json_extract(${alias}.payload_json,'$.reason'),'') NOT IN (${reasons})`;

export function postIsCollapsed(db:Database,postId:string):boolean {
  return !!db.query(`SELECT 1 FROM session_owner_events collapse_event WHERE ${activePostCollapseSql('collapse_event','?')}`).get(postId);
}
