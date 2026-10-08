import type {Database} from 'bun:sqlite';

/** Read only the named display facts, never materialize a declaration's question array. */
export function topicEventDisplay(source:Database,sequence:number){
 const row=source.query(`SELECT event_id,created_at,json_extract(payload_json,'$.change') AS change,
  json_extract(payload_json,'$.by') AS by_json,json_extract(payload_json,'$.reason') AS reason,
  json_extract(payload_json,'$.revision') AS revision,json_extract(payload_json,'$.topic.title') AS topic_title,
  json_extract(payload_json,'$.title') AS title,json_extract(payload_json,'$.previousTitle') AS previous_title,
  json_extract(payload_json,'$.topic.summary') AS summary,json_extract(payload_json,'$.mergedTopic.title') AS merged_title,
  json_extract(payload_json,'$.scope') AS scope,json_extract(payload_json,'$.to.title') AS to_title,
  json_extract(payload_json,'$.topic.setAside.reason') AS aside_reason,json_extract(payload_json,'$.request.title') AS request_title,
  json_extract(payload_json,'$.request.disposition') AS disposition,json_array_length(payload_json,'$.roots') AS roots_count,
  json_array_length(payload_json,'$.questions') AS questions_count,json_extract(payload_json,'$.questions[0].state') AS question_state,
  json_extract(payload_json,'$.questions[0].brief.decision') AS decision,json_array_length(payload_json,'$.mappings') AS mappings_count
  FROM session_owner_events WHERE sequence=?`).get(sequence) as any;
 if(!row)return null;
 const payload={change:row.change,by:row.by_json?JSON.parse(row.by_json):null,reason:row.reason,revision:row.revision,
  topic:{title:row.topic_title,summary:row.summary,setAside:{reason:row.aside_reason}},title:row.title,previousTitle:row.previous_title,
  mergedTopic:{title:row.merged_title},scope:row.scope,to:{title:row.to_title},request:{title:row.request_title,disposition:row.disposition},
  roots:{length:row.roots_count??0},questions:{length:row.questions_count??0,0:{state:row.question_state,brief:{decision:row.decision}}},
  mappings:{length:row.mappings_count??0}};
 return {id:`topic-event:${row.event_id}`,role:'system',content:topicEventSentence(payload),
  topicEvent:{change:payload.change,by:payload.by,reason:payload.reason,revision:payload.revision},
  createdAt:row.created_at.includes('T')?row.created_at:row.created_at.replace(' ','T')+'Z'};
}

export function topicEventSentence(payload:any):string {
  const title=payload.topic?.title??payload.title??'this thread';
  switch(payload.change) {
    case 'created':return `Filed under ${title}.`;
    case 'placed':return `Added ${payload.roots?.length??0} message${(payload.roots?.length??0)===1?'':'s'} to ${title}.`;
    case 'renamed':return `Renamed from ${payload.previousTitle} to ${title}${payload.reason?` because ${payload.reason}`:''}.`;
    case 'summary':return `Now: ${payload.topic?.summary??''}`;
    case 'merged':return `Merged ${payload.mergedTopic?.title??'another thread'} into ${title}.`;
    case 'closed':return `Closed: ${payload.reason??''}${payload.scope?` (${payload.scope})`:''}`;
    case 'reopened':return `Reopened: ${payload.reason??''}`;
    case 'forwarded':return `Your reply went straight to ${payload.to?.title??'the agent working on this'}.`;
    case 'set_aside':return `Set aside: ${payload.topic?.setAside?.reason??''}`;
    case 'resumed':return 'Picked back up.';
    case 'added':return `Request added: ${payload.request?.title??''}`;
    case 'amended':return `Request changed: ${payload.reason??payload.request?.title??''}`;
    case 'linked':return `Work linked to ${payload.request?.title??'this request'}.`;
    case 'request_closed':return `Request ${payload.request?.title??''} closed as ${payload.request?.disposition??''}: ${payload.reason??''}`;
    case 'request_reopened':return `Request ${payload.request?.title??''} reopened: ${payload.reason??''}`;
    case 'reconciled':return `Questions updated (${payload.questions?.length??0}).`;
    case 'settled':return `Question settled as ${payload.questions?.[0]?.state??''}${payload.reason?`: ${payload.reason}`:''}`;
    case 'filed':return `Filed here: ${payload.questions?.[0]?.brief?.decision??''}`;
    case 'recovered':return `${payload.questions?.length??0} earlier attention ${(payload.questions?.length??0)===1?'entry':'entries'} filed as questions${payload.reason?` (${payload.reason})`:''}.`;
    case 'recorded':return `Your answer was recorded against ${payload.mappings?.length??0} question${(payload.mappings?.length??0)===1?'':'s'}.`;
    default:return payload.change??'Updated.';
  }
}
