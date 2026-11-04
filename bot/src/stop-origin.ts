import type {Database} from 'bun:sqlite';

/** A human Stop names one exact run; pause and recovery stop requests do not count. */
export function humanStopForRun(source:Database,runId:string):{inputId:string;atMs:number}|null{
  const row=source.query(`SELECT id,created_at FROM session_inputs WHERE kind='stop' AND origin='human'
    AND json_extract(payload_json,'$.runId')=? ORDER BY created_at LIMIT 1`).get(runId) as {id:string;created_at:string}|null;
  return row?{inputId:row.id,atMs:Date.parse(`${row.created_at.replace(' ','T')}Z`)}:null;
}
