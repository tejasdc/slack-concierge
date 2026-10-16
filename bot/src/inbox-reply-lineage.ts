type RetainedInput={
  origin:string;
  scope:string;
  source_input_id:string|null;
  source_run_id:string|null;
  payload_json:string;
};

/** A trusted surface reply follows its named message whether the actor is Tejas or a marked agent check. */
export function retainedReplyTarget(input:RetainedInput|null|undefined):{messageId:string}|null {
  if(!input)return null;
  let payload:any;
  try { payload=JSON.parse(input.payload_json); } catch { return null; }
  const marked=payload?.agentSource;
  const trustedAgent=input.origin==='agent'&&input.scope==='surface:thinkering'
    &&typeof input.source_input_id==='string'&&typeof input.source_run_id==='string'
    &&marked?.inputId===input.source_input_id&&marked?.runId===input.source_run_id;
  const reply=input.origin==='human'||trustedAgent?payload?.replyToMessage:null;
  return typeof reply?.messageId==='string'?{messageId:reply.messageId}:null;
}
