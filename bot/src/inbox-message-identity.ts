// Queue admission and later steering can both accept the same retained input.
// Its first acceptance owns the message's position; later delivery events remain
// audit history, not another message. The input index bounds this exact lookup.
export const firstInboxAcceptanceSql=`(event.kind<>'accepted' OR NOT EXISTS (
  SELECT 1 FROM session_owner_events earlier
  WHERE earlier.input_id=event.input_id AND earlier.session_id=event.session_id
    AND earlier.kind='accepted' AND earlier.sequence<event.sequence
))`;

/** Only the owner's saved-context event for this exact retained input is dialogue. */
export const savedContextMessageSql=`event.kind='message' AND event.session_id=input.session_id
  AND event.event_id='context:'||input.id AND json_extract(event.payload_json,'$.message.id')=event.event_id
  AND json_extract(event.payload_json,'$.message.inputId')=input.id
  AND json_extract(event.payload_json,'$.message.role')='user'
  AND json_extract(event.payload_json,'$.message.responseMode')='context'
  AND json_extract(input.payload_json,'$.responseMode')='context'`;
