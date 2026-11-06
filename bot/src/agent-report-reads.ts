import type {Database} from 'bun:sqlite';

type InputRow={id:string;session_id:number;source_input_id:string|null;source_run_id:string|null;
  origin:string;kind:string;created_at:string;client:string|null;producer:string|null;attachments:string|null};
const inputFields=`id,session_id,source_input_id,source_run_id,origin,kind,created_at,
  json_extract(payload_json,'$.capture.source.metadata.client') AS client,
  json_extract(payload_json,'$.capture.source.metadata.producer') AS producer,
  json_extract(payload_json,'$.attachments') AS attachments`;
const files=(raw:string|null):string[]=>{
  if(!raw)return [];
  try {const parsed=JSON.parse(raw);return Array.isArray(parsed)?parsed.filter((file):file is string=>typeof file==='string'):[];}
  catch{return [];}
};
const presented=(row:InputRow)=>({id:row.id,session:row.session_id,sourceInput:row.source_input_id,
  sourceRun:row.source_run_id,origin:row.origin,kind:row.kind,createdAt:row.created_at,
  client:row.client,producer:row.producer,attachments:files(row.attachments)});
const reportMarker=(row:InputRow)=>row.client==='thinkering-bug-report'&&/^capture:[a-f0-9]{64}$/.test(row.id);

/** Same eight-hop and carried-file precedence as thnkr.ing's report-input-chain.mjs. */
export function reportSourceChain(db:Database,id:string){
  if(id.length>128||!/^[A-Za-z0-9:_-]+$/.test(id))
    throw new Error('An exact accepted input or request ID is required.');
  if(/^[0-9a-f-]{36}$/.test(id))id=`request:${id}`;
  const input=db.query(`SELECT ${inputFields} FROM session_inputs WHERE id=?`);
  const carried=db.query(`SELECT DISTINCT capture.id AS id FROM session_communication_requests request,
    json_each(request.payload_json,'$.attachments') file,session_inputs capture,
    json_each(capture.payload_json,'$.attachments') own
    WHERE request.request_id=? AND capture.id LIKE 'capture:%' AND own.value=file.value
      AND json_extract(capture.payload_json,'$.capture.source.metadata.client')='thinkering-bug-report'
    ORDER BY capture.created_at,capture.id`);
  const requestFiles=db.query("SELECT json_extract(payload_json,'$.attachments') AS attachments FROM session_communication_requests WHERE request_id=?");
  const hops:(ReturnType<typeof presented>&{requestFiles?:string[]})[]=[];
  const carriedReports:string[]=[];
  let current:string|null=id;
  for(let count=0;count<=8&&current;count++){
    const row=input.get(current) as InputRow|null;
    if(!row)break;
    if(count===8&&!current.startsWith('capture:'))break;
    const carriedByRequest=current.startsWith('request:')
      ?files((requestFiles.get(current.slice(8)) as {attachments:string|null}|null)?.attachments??null):undefined;
    hops.push({...presented(row),...(carriedByRequest?{requestFiles:carriedByRequest}:{})});
    if(current.startsWith('capture:'))break;
    if(current.startsWith('request:')){
      for(const match of carried.all(current.slice(8)) as {id:string}[])if(!carriedReports.includes(match.id))carriedReports.push(match.id);
    }
    current=row.source_input_id;
  }
  if(!hops.length)throw new Error('The accepted input was not found in this owner ledger.');
  const end=hops.at(-1)?.id.startsWith('capture:')?hops.at(-1)!.id:null;
  const resolved=!carriedReports.length||carriedReports.includes(end??'')?end:carriedReports[0]??null;
  const report=resolved?input.get(resolved) as InputRow|null:null;
  const dispatches=new Set(hops.filter(hop=>hop.id.startsWith('request:')).map(hop=>hop.id.slice(8)));
  const direct=new Set(id.startsWith('request:')?[id.slice(8)]:[]);
  // A caller may name the sending input, before its request input exists in the ancestry.
  for(const child of db.query("SELECT id FROM session_inputs WHERE source_input_id=? AND id LIKE 'request:%'").all(id) as {id:string}[]){
    dispatches.add(child.id.slice(8));
    direct.add(child.id.slice(8));
  }
  const inboxLinks:{dispatchRequestId:string;direct:boolean;inboxRequestId:string;topicId:string;
    sources:{inputId:string;inAppReport:boolean;capture:ReturnType<typeof presented>|null}[]}[]=[];
  for(const dispatch of dispatches){
    const rows=bounded(db.query(`SELECT request_id,topic_id,sources_json,dispatches_json
      FROM inbox_requests WHERE dispatches_json LIKE ? LIMIT ${MAX_ROWS+1}`)
      .all(`%${dispatch}%`) as {request_id:string;topic_id:string;sources_json:string;dispatches_json:string}[],'Inbox links');
    for(const row of rows){
      const entries=JSON.parse(row.dispatches_json) as {requestId?:string}[];
      if(!entries.some(entry=>entry.requestId===dispatch))continue;
      const sources=(JSON.parse(row.sources_json) as {inputId?:string}[]).flatMap(source=>{
        if(!source.inputId)return [];
        const capture=input.get(source.inputId) as InputRow|null;
        return [{inputId:source.inputId,inAppReport:!!capture&&capture.origin==='human'&&reportMarker(capture),
          capture:capture?presented(capture):null}];
      });
      inboxLinks.push({dispatchRequestId:dispatch,direct:direct.has(dispatch),inboxRequestId:row.request_id,topicId:row.topic_id,sources});
    }
  }
  return {input:id,hops,carriedReports,resolvedCapture:resolved,
    inAppReport:report&&reportMarker(report)?presented(report):null,inboxLinks};
}

const utc=(value:string|null)=>{
  if(!value||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)||!Number.isFinite(Date.parse(value)))
    throw new Error('A UTC timestamp in YYYY-MM-DDTHH:MM:SSZ form is required.');
  return value.slice(0,10)+' '+value.slice(11,19);
};
const MAX_ROWS=5000;
function bounded<T>(rows:T[],name:string):T[]{
  if(rows.length>MAX_ROWS)throw new Error(`${name} exceeds the report read limit; choose a shorter window.`);
  return rows;
}
// Every owner event insert omits created_at, so sequence order is also time order. Bisection
// starts the posts scan near the requested time without a new index and its ledger-copy migration.
function firstEventAt(db:Database,since:string):number{
  const max=(db.query('SELECT COALESCE(MAX(sequence),0) AS value FROM session_owner_events').get() as {value:number}).value;
  const at=db.query('SELECT sequence,created_at FROM session_owner_events WHERE sequence>=? ORDER BY sequence LIMIT 1');
  let low=1,high=max+1;
  while(low<high){
    const middle=Math.floor((low+high)/2);
    const row=at.get(middle) as {sequence:number;created_at:string}|null;
    if(!row||row.created_at>=since)high=middle;
    else low=row.sequence+1;
  }
  return low;
}

/** The exact reporter window and its request/post state, read in an isolated read executor. */
export function reportWindow(db:Database,sinceRaw:string|null,untilRaw:string|null){
  const since=utc(sinceRaw),until=utc(untilRaw);
  if(!db.query('SELECT 1 FROM session_inputs LIMIT 1').get())
    throw new Error('This owner ledger contains no accepted inputs; an empty report window cannot be trusted.');
  if(until<=since)throw new Error('The report window must advance.');
  const reports=bounded(db.query(`SELECT ${inputFields} FROM session_inputs WHERE created_at>=? AND created_at<?
    AND id GLOB 'capture:*' AND json_extract(payload_json,'$.capture.source.metadata.client')='thinkering-bug-report'
    ORDER BY created_at,id LIMIT ${MAX_ROWS+1}`).all(since,until) as InputRow[],'Reports');
  const human=bounded(db.query(`SELECT ${inputFields} FROM session_inputs WHERE created_at>=? AND created_at<?
    AND origin='human' AND kind='input' ORDER BY created_at,id LIMIT ${MAX_ROWS+1}`).all(since,until) as InputRow[],'Human inputs');
  const related=db.query(`SELECT id FROM session_inputs WHERE source_input_id=? AND id LIKE 'request:%'`);
  const request=db.query(`SELECT outcome,target_session_id AS session,created_at_ms AS createdAtMs
    FROM session_communication_requests WHERE request_id=?`);
  const posts=bounded(db.query(`SELECT event_id AS eventId,created_at AS createdAt,
      json_extract(payload_json,'$.requestId') AS requestId
    FROM session_owner_events WHERE sequence>=? AND kind='post' AND created_at>=?
      AND json_extract(payload_json,'$.requestId') IS NOT NULL
    ORDER BY sequence LIMIT ${MAX_ROWS+1}`).all(firstEventAt(db,since),since) as
      {eventId:string;createdAt:string;requestId:string}[],'Thread posts');
  const postsByRequest=new Map<string,{eventId:string;createdAt:string}[]>();
  for(const post of posts){
    const found=postsByRequest.get(post.requestId)??[];
    found.push({eventId:post.eventId,createdAt:post.createdAt});
    postsByRequest.set(post.requestId,found);
  }
  const reportFiles=new Set(reports.flatMap(row=>files(row.attachments)));
  const matched=new Map<string,string[]>();
  for(const row of reports)matched.set(row.id,(related.all(row.id) as {id:string}[]).map(item=>item.id.slice(8)));
  // The Inbox's exact obligation-to-dispatch links survive re-routing and shared dispatches.
  for(const row of bounded(db.query(`SELECT sources_json,dispatches_json FROM inbox_requests LIMIT ${MAX_ROWS+1}`)
    .all() as {sources_json:string;dispatches_json:string}[],'Inbox requests')){
    const sources=JSON.parse(row.sources_json) as {inputId?:string}[];
    const dispatches=JSON.parse(row.dispatches_json) as {requestId?:string}[];
    for(const source of sources){
      const ids=source.inputId&&matched.get(source.inputId);
      if(!ids)continue;
      for(const dispatch of dispatches)if(dispatch.requestId&&!ids.includes(dispatch.requestId))ids.push(dispatch.requestId);
    }
  }
  if(reportFiles.size){
    const attached=bounded(db.query(`SELECT request_id,payload_json FROM session_communication_requests
      WHERE created_at_ms>=? AND json_extract(payload_json,'$.attachments') IS NOT NULL
      ORDER BY created_at_ms,request_id LIMIT ${MAX_ROWS+1}`).all(Date.parse(sinceRaw!)) as {request_id:string;payload_json:string}[],'Requests');
    for(const item of attached){
      const candidate=files(JSON.stringify(JSON.parse(item.payload_json).attachments??[]));
      if(!candidate.some(file=>reportFiles.has(file)))continue;
      for(const row of reports)if(files(row.attachments).some(file=>candidate.includes(file))){
        const ids=matched.get(row.id)!;if(!ids.includes(item.request_id))ids.push(item.request_id);
      }
    }
  }
  const requestState=(id:string)=>{
    const state=request.get(id) as {outcome:string|null;session:number;createdAtMs:number}|null;
    const threadPosts=postsByRequest.get(id)??[];
    return {id,known:!!state,outcome:state?.outcome??null,session:state?.session??null,createdAtMs:state?.createdAtMs??null,
      answeredInThread:threadPosts.length>0,threadPosts};
  };
  const requestsFor=(row:InputRow)=>bounded((related.all(row.id) as {id:string}[]).map(item=>requestState(item.id.slice(8))),'Routed requests');
  return {since,until,reports:reports.map(row=>({...presented(row),requests:(matched.get(row.id)??[]).map(requestState)})),
    humanInputs:human.map(row=>({...presented(row),requests:requestsFor(row)}))};
}
