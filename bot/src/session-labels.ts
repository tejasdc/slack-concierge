import type {Database} from 'bun:sqlite';

/** One canonical label rule for interactive and prepared session cards. */
export function sessionCatalogueLabels(database:Database,session:{
  slack_channel_id:string|null;slack_thread_ts:string|null;native_metadata_json:string|null
}) {
  const meta=JSON.parse(session.native_metadata_json||'{}');
  const channel=session.slack_channel_id
    ?database.query('SELECT name,code_path FROM channels WHERE slack_channel_id=?').get(session.slack_channel_id) as {name:string|null;code_path:string|null}|null:null;
  const retainedTitle=!meta.title&&session.slack_channel_id&&session.slack_thread_ts
    ?database.query(`SELECT desired_title AS title FROM slack_agent_session_title_projections WHERE slack_channel_id=? AND slack_thread_ts=?
        UNION ALL SELECT initial_title AS title FROM slack_agent_session_status_projections
          WHERE slack_channel_id=? AND slack_thread_ts=? AND initial_title IS NOT NULL LIMIT 1`)
      .get(session.slack_channel_id,session.slack_thread_ts,session.slack_channel_id,session.slack_thread_ts) as {title:string}|null:null;
  return {title:(meta.title??retainedTitle?.title??channel?.name??'Agent session') as string,
    summary:(meta.summary??'') as string,project:(meta.project??meta.cwd??channel?.code_path??null) as string|null};
}
