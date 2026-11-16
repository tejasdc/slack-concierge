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
