// Queue admission and later steering can both accept the same retained input.
// Its first acceptance owns the message's position; later delivery events remain
// audit history, not another message. The input index bounds this exact lookup.
export const firstInboxAcceptanceSql=`(event.kind<>'accepted' OR NOT EXISTS (
  SELECT 1 FROM session_owner_events earlier
  WHERE earlier.input_id=event.input_id AND earlier.session_id=event.session_id
    AND earlier.kind='accepted' AND earlier.sequence<event.sequence
))`;
