/** The canonical thread resolver records this marker when a router turn posts in the thread
 * it answers. Both message readers use the marker, rather than independently resolving lineage. */
export const postedResultMarkerId=(turnId:number)=>`result:posted:${turnId}`;
export const answeredByPostResultSql=`event.kind='result' AND event.turn_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM session_owner_events marker
    WHERE marker.event_id='result:posted:' || event.turn_id
      AND marker.session_id=event.session_id AND marker.kind='result_posted')`;
