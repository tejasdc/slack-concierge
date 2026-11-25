import type {Database} from 'bun:sqlite';
import {inputProvenance,type ProvenanceInput} from './input-provenance';

/**
 * The one rule for which Inbox thread an input serves, callable with any database handle.
 *
 * A thread root counts when it is a topic's root. Otherwise the input is followed to the human
 * message that started its work: that message is the root, or his reply inside a thread is named
 * by the Inbox's own request from it. The owner uses it to name a turn's thread and to store a
 * request's topic; the weekly allowance report uses it so a report-back, a watch wake or a
 * continuation of threaded work is counted under that thread. On 2026-11-16 the report kept its
 * own shorter copy that stopped at the turn's request row, and filed work Concierge itself
 * placed in a thread as "Not in a thread".
 */
export function topicRootIn(database:Database,threadRoot:string|null|undefined,sourceInputId:string|null|undefined):string|null {
  const topicOf=(root:string|null|undefined)=>root
    ?(database.query('SELECT topic_id FROM inbox_topic_roots WHERE root_input_id=?').get(root) as {topic_id:string}|null)?.topic_id??null:null;
  if(topicOf(threadRoot))return threadRoot!;
  // Work inherits the thread of the nearest request that set it going. A chain the Inbox's own
  // upkeep or a repair notice started has no human at its end, but the request it sent carries
  // its thread, and every wake, report-back and request downstream of it serves that thread.
  const seen=new Set<string>();
  for(let id=sourceInputId??null;id&&!seen.has(id)&&seen.size<32;){
    seen.add(id);
    if(id.startsWith('request:')){
      const request=database.query(`SELECT coalesce(nullif(topic_root_input_id,''),thread_root_input_id) AS root
        FROM session_communication_requests WHERE request_id=?`).get(id.slice('request:'.length)) as {root:string|null}|null;
      if(topicOf(request?.root))return request!.root;
    }
    id=(database.query('SELECT source_input_id FROM session_inputs WHERE id=?').get(id) as {source_input_id:string|null}|null)?.source_input_id??null;
  }
  const source=sourceInputId?database.query('SELECT * FROM session_inputs WHERE id=?').get(sourceInputId) as ProvenanceInput|null:null;
  // A read-only caller never names a run; the walk only needs the run for its own receipt.
  const runIdForTurn=(turnId:number)=>(database.query('SELECT native_run_id FROM turns WHERE id=?').get(turnId) as {native_run_id:string|null}|null)?.native_run_id??'';
  const human=source?(source.origin==='human'?source.id:inputProvenance(database,source,runIdForTurn)?.originatingHuman?.inputId):null;
  if(!human)return null;
  if(topicOf(human))return human;
  const routed=database.query(`SELECT thread_root_input_id AS root FROM session_communication_requests
    WHERE source_input_id=? AND thread_root_input_id IS NOT NULL ORDER BY created_at_ms DESC LIMIT 1`).get(human) as {root:string}|null;
  return routed&&topicOf(routed.root)?routed.root:null;
}

/** The thread root a turn's accepted input serves: a request by its stored thread, anything else by its human. */
export function turnTopicRootIn(database:Database,acceptedInputId:string|null|undefined):string|null {
  if(!acceptedInputId)return null;
  if(acceptedInputId.startsWith('request:')){
    const row=database.query(`SELECT thread_root_input_id AS thread,topic_root_input_id AS topic,source_input_id AS source
      FROM session_communication_requests WHERE request_id=?`).get(acceptedInputId.slice('request:'.length)) as {thread:string|null;topic:string|null;source:string|null}|null;
    return row?topicRootIn(database,row.topic||row.thread,row.source):null;
  }
  return topicRootIn(database,null,acceptedInputId);
}

/**
 * The task a turn's work belongs to: the nearest request that set it going (a request to an
 * agent is one task, and each request it makes in turn is its own task), else the message of
 * his at the start of its chain, else the turn's own input (a scheduled run). A report-back, a
 * watch wake or a continuation belongs to the task it continues. Used for cost per task:
 * Tejas asked on 2026-11-25 for the median dollar cost per task, after Kun Chen's note.
 */
export function turnTaskIn(database:Database,acceptedInputId:string|null|undefined):{id:string;kind:'request'|'message'|'other'}|null {
  if(!acceptedInputId)return null;
  const seen=new Set<string>();
  let human:string|null=null,last:string=acceptedInputId;
  for(let id:string|null=acceptedInputId;id&&!seen.has(id)&&seen.size<32;){
    seen.add(id);last=id;
    if(id.startsWith('request:'))return {id,kind:'request'};
    const row=database.query('SELECT origin,source_input_id FROM session_inputs WHERE id=?').get(id) as {origin:string;source_input_id:string|null}|null;
    if(row?.origin==='human')human=id;
    id=row?.source_input_id??null;
  }
  return human?{id:human,kind:'message'}:{id:last,kind:'other'};
}
