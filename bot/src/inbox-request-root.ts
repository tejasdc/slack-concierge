import type {Database} from 'bun:sqlite';

/** The request's own placed root owns its answer, even if the sender named another thread. */
export function inboxRequestRoot(database:Database,requestId:string,originalRoot:string|null):string|null {
  const ownRoot=`request:${requestId}`;
  if(database.query('SELECT 1 FROM inbox_topic_roots WHERE root_input_id=?').get(ownRoot))return ownRoot;
  return originalRoot;
}
