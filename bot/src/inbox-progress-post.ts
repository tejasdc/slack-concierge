/** A progress-only request receipt belongs in Work, not as another Inbox conversation
 * message. Prompt answers and deliberately notified partials remain conversation posts. */
export const unrequestedProgressPostSql=`event.kind='post'
  AND event.event_id GLOB 'post:forward:*'
  AND json_extract(event.payload_json,'$.replyKind')='partial'
  AND coalesce(json_extract(event.payload_json,'$.answersQuestion'),0)=0
  AND json_extract(event.payload_json,'$.postedBy')='owner-forward'
  AND coalesce(json_extract(event.payload_json,'$.requestedNotification'),0)=0
  AND (EXISTS (SELECT 1 FROM session_communication_events progress
      WHERE progress.event_id=substr(event.event_id,14) AND progress.kind='progress')
    OR EXISTS (SELECT 1 FROM session_peer_events progress
      WHERE progress.event_id=substr(event.event_id,14) AND progress.kind='progress'))
  AND NOT EXISTS (SELECT 1 FROM session_owner_events notification
    WHERE notification.event_id='needs_you:requested:' || event.event_id)`;
