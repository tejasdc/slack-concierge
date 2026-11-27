import {db,getSessionById} from './state';
import {localSessionNumber} from './peer-identity';
import {sessionMetadata} from './session-inputs';
import {REQUEST_PROTOCOL_POINTER} from './request-protocol';

/**
 * Thread followers: sessions that hear every message Tejas writes in one Inbox thread and answer
 * only when it touches their own work. Tejas, 2026-11-26, in "Engineering an argument": "Bring in
 * other relevant sessions, and turn on notifications for them so they can respond whenever a
 * relevant question comes in — but they don't have to respond all the time, only if it's relevant
 * to their context." The follower list is a projection of topic events (change 'followed' and
 * 'unfollowed'), so a replay rebuilds it like every other topic table. A session on his Mac follows
 * exactly as a server one does [decision: mac-sessions-have-parity].
 */
export type ThreadFollower={sessionId:string;addedBy:string;addedAt:string};

export function topicFollowers(topicId:string):ThreadFollower[] {
  return (db.query('SELECT session_id,added_by,added_at FROM inbox_topic_followers WHERE topic_id=? ORDER BY added_at,session_id').all(topicId) as
    {session_id:string;added_by:string;added_at:string}[]).map(row=>({sessionId:row.session_id,addedBy:row.added_by,addedAt:row.added_at}));
}

/** Projection of one follow change; a replay applies the same rows. */
export function projectFollowerChange(payload:{topicId?:unknown;followed?:ThreadFollower|null;unfollowed?:{sessionId:string}|null}) {
  if(typeof payload.topicId!=='string')return;
  if(payload.followed)db.query(`INSERT INTO inbox_topic_followers(topic_id,session_id,added_by,added_at) VALUES(?,?,?,?)
    ON CONFLICT(topic_id,session_id) DO NOTHING`).run(payload.topicId,payload.followed.sessionId,payload.followed.addedBy,payload.followed.addedAt);
  if(payload.unfollowed)db.query('DELETE FROM inbox_topic_followers WHERE topic_id=? AND session_id=?').run(payload.topicId,payload.unfollowed.sessionId);
}

/**
 * The canonical session ID (`concierge:12`, `mac:86`) for what a caller named: that ID itself, an
 * exact local address (`session:…`), or a peer address (`mac/session:…`) as the peer catalogue
 * carries it. Null when nothing this owner knows matches.
 */
export function followerSessionId(named:string):{sessionId:string;title:string|null;inbox:boolean}|null {
  const value=named.trim();
  const local=(id:number)=>{const row=getSessionById(id);return row?{sessionId:`concierge:${row.id}`,title:sessionMetadata(row).title??null,inbox:!!sessionMetadata(row).inbox}:null;};
  if(value.startsWith('session:')){
    try{
      const tuple=JSON.parse(Buffer.from(value.slice(8),'base64url').toString());
      if(Array.isArray(tuple)&&tuple[0]===2&&Number.isSafeInteger(tuple[1])){
        const row=getSessionById(tuple[1]);
        if(row&&(row.binding_generation??1)===tuple[2])return local(row.id);
      }
    }catch{/* not an address this owner issued */}
    return null;
  }
  const byCatalogue=(where:string,key:string)=>{
    const row=db.query(`SELECT view_json FROM session_peer_catalogue WHERE json_extract(view_json,'$.${where}')=?`).get(key) as {view_json:string}|null;
    if(!row)return null;
    const view=JSON.parse(row.view_json);
    return typeof view.id==='string'?{sessionId:view.id,title:typeof view.title==='string'?view.title:null,inbox:false}:null;
  };
  if(/^[a-z][a-z0-9-]*\/session:/.test(value))return byCatalogue('address',value);
  if(/^[a-z][a-z0-9-]*:[1-9]\d*$/.test(value)){
    const number=localSessionNumber(value);
    return number!==null?local(number):byCatalogue('id',value);
  }
  return null;
}

/** What a follower reads with his new message: the judgment first, and both ways to close it. */
export function followerFraming(input:{requestId:string;text:string;topicId:string;topicTitle:string|null}) {
  const id=input.requestId;
  return `Session request ${id}: you follow the thnkr.ing Inbox thread ${input.topicTitle?`“${input.topicTitle}” `:''}(${input.topicId}), and Tejas just wrote the message below in it. Following means you hear every message he writes there; it does not mean every message is for you. Answer ONLY if it touches your own context or work. To read the thread for context: sessions topics read ${input.topicId}.

If it is relevant to your work, answer in the thread: sessions reply ${id} --partial --answers-question --mine "<what of your work it is about>" -- "<answer, TL;DR first, product language>", then close the request with sessions reply ${id} --silent --summary "<one line: what you answered>" (a silent close posts nothing more).

If it is not relevant, close it without a word in the thread: sessions reply ${id} --silent --summary "<one line: why it is not about your work>". Nothing is posted, nobody is notified, and nobody is waiting on you. Do not pass it to the Inbox: the message already reached whoever he addressed. ${REQUEST_PROTOCOL_POINTER}

${input.text}`;
}
