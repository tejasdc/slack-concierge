import type {ThinkeringSessionAcceptance} from '../support/thinkering-session';
import type {UnifiedSessionSandbox} from '../support/unified-session';

export function assertChatGptIntentResult(request:any,target:any,operation:any,events:any[],failures:any[]) {
  if(target.provider_id!=='chatgpt'||target.slack_channel_id!==null||target.slack_thread_ts!==null
    ||operation.origin!=='agent'||operation.kind!=='create'||operation.inputId!==request.target_input_id
    ||operation.sessionId!==`concierge:${request.target_session_id}`||operation.requestId!==request.request_id
    ||request.routed_request_id!==null||JSON.parse(request.payload_json).provider!=='chatgpt')throw new Error('Explicit ChatGPT intent did not retain its exact native creation and agent authority.');
  const final=events.filter(event=>event.kind==='final');
  if(final.length!==1||events.some(event=>event.request_id!==request.request_id||event.status!=='received'||!event.accepted_input_id||event.routed_request_id!==null))throw new Error('ChatGPT result was not returned to its exact requesting session.');
  const result=JSON.parse(request.result_json);
  if(result.responding_session_id!==operation.sessionId||result.event_id!==final[0].event_id)throw new Error('ChatGPT result correlation changed.');
  if(request.outcome==='answered') {
    if(operation.state!=='completed'||!operation.acknowledgedAt||!target.agent_session_uuid||!operation.result||result.text!==operation.result)throw new Error('ChatGPT answer is not its exact acknowledged provider result.');
  } else {
    if(request.outcome!=='failed'||!['failed','uncertain'].includes(operation.state)||!operation.error?.message)throw new Error('ChatGPT failure is not retained explicitly.');
    if(!operation.admission) {
      if(operation.runId!==null||operation.error.message!=='chatgpt start unavailable.')throw new Error('Only explicit unavailable creation may fail without provider admission.');
    } else if(!failures.some(event=>event.kind==='failure'&&event.run?.inputId===operation.inputId&&event.run?.runId===operation.runId&&event.code&&event.message))throw new Error('The configured ChatGPT capability did not retain the exact failure evidence.');
  }
}

export async function runUnifiedChatGptCase(options:{fixture:UnifiedSessionSandbox;surface:ThinkeringSessionAcceptance;requesterId:string;onTarget:(id:string)=>void}) {
  const {fixture,surface,requesterId}=options;
  const baseline=fixture.slackEffects();
  const sessions=fixture.rows('SELECT id FROM sessions').map(row=>row.id);
  const input=await surface.input(requesterId,'Ask ChatGPT to explain why some garden plants tolerate shade better than others. Tell me the request ID once you have asked; I can read its answer when it arrives.');
  fixture.save('chatgpt-intent-input',input);
  const request=await fixture.until('ordinary-language ChatGPT request is retained',async()=>{
    const found=fixture.rows('SELECT * FROM session_communication_requests WHERE source_input_id=?',input.operation.inputId);
    if(found.length>1)throw new Error('One explicit ChatGPT question created multiple requests.');
    if(found.length)return found[0]!;
    const operation=await fixture.owner(`/sessions/v1/operations/${input.operation.operationId}`);
    if(['completed','failed','canceled','uncertain'].includes(operation.state))throw new Error(`The human ChatGPT input ended without its required request: ${JSON.stringify(operation)}`);
    return null;
  });
  options.onTarget(`concierge:${request.target_session_id}`);
  const settled=await fixture.until('exact ChatGPT request settles',()=>{
    const current=fixture.one('SELECT * FROM session_communication_requests WHERE request_id=?',request.request_id)!;
    return current.outcome?current:null;
  });
  const events=await fixture.until('ChatGPT final return is received',()=>{
    const values=fixture.events(request.request_id);
    if(values.some(event=>['failed','ambiguous','uncertain','canceled'].includes(event.status)))throw new Error(`ChatGPT return failed: ${JSON.stringify(values)}`);
    return values.some(event=>event.kind==='final')&&values.every(event=>event.status==='received')?values:null;
  });
  const target=fixture.one('SELECT * FROM sessions WHERE id=?',request.target_session_id)!;
  const operation=await fixture.owner(`/sessions/v1/operations/${request.target_input_id}`);
  const capabilities=fixture.rows("SELECT payload_json FROM session_owner_events WHERE input_id=? AND kind='capability'",request.target_input_id).map(row=>JSON.parse(row.payload_json));
  fixture.save('chatgpt-intent-result',{request:settled,target,operation,events,capabilities});
  assertChatGptIntentResult(settled,target,operation,events,capabilities);
  const created=fixture.rows('SELECT id FROM sessions').filter(row=>!sessions.includes(row.id));
  if(created.length!==1||created[0]!.id!==request.target_session_id)throw new Error('Explicit ChatGPT intent created a second session or provider fallback.');
  if(fixture.requests().some(row=>row.source_session_id===target.id))throw new Error('ChatGPT created an outbound session request.');
  if(JSON.stringify(fixture.slackEffects())!==JSON.stringify(baseline))throw new Error('ChatGPT intent created Slack effects while Slack was absent.');
}
