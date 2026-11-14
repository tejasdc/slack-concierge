import {db,getSessionById,EARLIER_TURN_BLOCKS_SQL,queuePrecedesSql,globalPauseHoldsSession} from './state';
import {providerRunnerForSession,sessionMetadata} from './session-inputs';
import {proveAcceptedBindingContinuation,type AcceptedBindingContinuationSnapshot,
  type ContinuationBinding,type ContinuationInput,type ContinuationTurn} from './codex-accepted-binding-continuation';

const parse=(value:string|null):any=>{try{return value===null?null:JSON.parse(value);}catch{return null;}};

/** Read-only owner adapter. Run inside the caller's fenced transaction when used
 * for a reservation. Its result alone never permits dispatch or a model start. */
export function inspectAcceptedBindingContinuation(input:{sessionId:number;inputId:string;requestId:string;includeSnapshot?:boolean}) {
  return db.transaction(()=>{
    const session=getSessionById(input.sessionId);
    const getInput=(id:string)=>db.query('SELECT rowid AS ordinal,* FROM session_inputs WHERE id=?').get(id) as ContinuationInput|null;
    const selected=getInput(input.inputId);
    const request=db.query('SELECT * FROM session_communication_requests WHERE request_id=?').get(input.requestId) as any;
    const creation=db.query("SELECT rowid AS ordinal,* FROM session_inputs WHERE session_id=? AND kind='create' ORDER BY rowid LIMIT 1")
      .get(input.sessionId) as ContinuationInput|null;
    const source=selected?.source_input_id?getInput(selected.source_input_id):null;
    const getTurn=(id:number|null|undefined)=>id?db.query('SELECT * FROM turns WHERE id=?').get(id) as any:null;
    const selectedTurn=getTurn(selected?.turn_id),creationTurn=getTurn(creation?.turn_id);
    // report-back custody is the exact returning run, which need not be the
    // source input's first turn. Never substitute recency or the request's run.
    const sourceTurn=selected?.source_run_id?db.query('SELECT * FROM turns WHERE native_run_id=? AND session_id=?')
      .get(selected.source_run_id,source?.session_id??-1) as any:null;
    if(!session||!selected||!source||!creation||!selectedTurn||!creationTurn||!sourceTurn||!request)
      return {proven:false,diagnosticOnly:true,authorizesProviderStart:false,
        reasons:[{code:'EXACT_RETAINED_CONTINUATION_ROWS_MISSING',evidence:[input.inputId,input.requestId]}]};
    const metadata=sessionMetadata(session),runner=providerRunnerForSession(session);
    const binding:ContinuationBinding={sessionId:session.id,provider:session.provider_id,threadId:session.agent_session_uuid??'',
      generation:session.binding_generation,model:metadata.model??'',effort:metadata.reasoningEffort??'',
      runner:runner.status==='bound'?runner.runner:''};
    const inputs=db.query('SELECT rowid AS ordinal,* FROM session_inputs WHERE session_id=? AND rowid>=? ORDER BY rowid')
      .all(session.id,creation.ordinal) as ContinuationInput[];
    const turns=db.query('SELECT * FROM turns WHERE session_id=? ORDER BY id').all(session.id) as any[];
    const events=db.query('SELECT * FROM session_owner_events WHERE session_id=? ORDER BY sequence').all(session.id) as any[];
    const intervalInputs=inputs.filter(row=>row.ordinal>=selected.ordinal);
    const handoffs=db.query("SELECT * FROM session_handoffs WHERE predecessor_session_id=? AND state IN ('proposed','accepted') ORDER BY id")
      .all(session.id) as any[];
    const predecessors=db.query(`SELECT older.* FROM turns older JOIN turns current ON current.id=?
      WHERE older.session_id=? AND ${queuePrecedesSql('older','current')} AND ${EARLIER_TURN_BLOCKS_SQL}
      ORDER BY older.queue_priority DESC,older.id`).all(selectedTurn.id,session.id) as any[];
    const active=db.query("SELECT * FROM turns WHERE session_id=? AND id<>? AND status IN ('running','delivering') ORDER BY id")
      .all(session.id,selectedTurn.id) as any[];
    const steering=db.query('SELECT s.* FROM turn_steering_messages s JOIN turns t ON t.id=s.turn_id WHERE t.session_id=? ORDER BY s.id')
      .all(session.id) as any[];
    const deliveries=db.query('SELECT d.* FROM turn_artifact_deliveries d JOIN turns t ON t.id=d.turn_id WHERE t.session_id=? ORDER BY d.artifact_id')
      .all(session.id);
    const requests=db.query('SELECT * FROM session_communication_requests WHERE target_session_id=? OR source_session_id=? ORDER BY rowid')
      .all(session.id,session.id) as any[];
    const nativeWitness=(row:ContinuationInput,turn:ContinuationTurn)=>{
      const admission=parse(row.receipt_json)?.admission;
      if(admission?.nativeBinding?.sessionId===binding.threadId&&admission.bindingGeneration===binding.generation)
        return {reference:`admission:${row.id}`,binding:{...binding}};
      const result=events.find(event=>event.kind==='result'&&event.input_id===row.id&&event.turn_id===turn.id
        &&parse(event.payload_json)?.sessionUUID===binding.threadId
        &&parse(event.payload_json)?.model===binding.model
        &&parse(event.payload_json)?.runId===turn.native_run_id);
      // Result witnesses establish the native conversation; accepted receipt
      // generation and the stable first-run runner establish its other identity.
      return result&&admission?.bindingGeneration===binding.generation
        ?{reference:result.event_id,binding:{...binding}}:null;
    };
    const classify=(row:ContinuationInput)=>{
      if(row.id===selected.id)return {inputId:row.id,reference:row.id,significance:'selected' as const};
      const related=requests.find(request=>request.target_input_id===row.id
        ||row.origin==='service'&&row.id===`report-back:${request.request_id}`&&request.request_id===row.request_id);
      const effect=related?parse(related.payload_json)?.requestedEffect:null;
      // An informational payload identifies scope only. Native emptiness remains
      // separate. Actions, controls, human inputs and work inputs stay unknown.
      const laterTurn=turns.find(turn=>turn.id===row.turn_id);
      const terminal=laterTurn?['done','parked'].includes(laterTurn.status)
        :['failed','completed','cancelled','withdrawn'].includes(parse(row.receipt_json)?.state);
      const informational=['input','request','consultation'].includes(row.kind)&&row.origin!=='human'
        &&effect==='informational'&&related?.outcome!==null&&terminal;
      return {inputId:row.id,reference:row.id,significance:informational?'neutral' as const:'unknown' as const};
    };
    const admittedBindings=inputs.flatMap(row=>{
      const a=parse(row.receipt_json)?.admission;
      return a&&(a.provider!==binding.provider||a.model!==binding.model||a.bindingGeneration!==binding.generation)
        ?[{reference:row.id,kind:'binding' as const}]:[];
    });
    // A retained control/action matters even when no turn was ever admitted.
    // Unknown historical controls are refused rather than silently projected away.
    const unresolvedControls=inputs.filter(row=>!['input','create','request','consultation','comparison'].includes(row.kind))
      .map(row=>({reference:row.id,kind:'control' as const}));
    const sourceLinked=sourceTurn.accepted_input_id===source.id||source.turn_id===sourceTurn.id
      ||steering.some(row=>row.turn_id===sourceTurn.id&&row.accepted_input_id===source.id);
    const snapshot:AcceptedBindingContinuationSnapshot={binding,creation:{input:creation,turn:creationTurn},
      // Retain the original row in ownerSnapshot. The pure policy's turn link
      // projection is allowed only after checking the exact owner relationship.
      source:{input:sourceLinked?{...source,turn_id:sourceTurn.id}:source,turn:sourceTurn},selected:{input:selected,turn:selectedTurn},
      request,creationBinding:nativeWitness(creation,creationTurn),selectedBinding:nativeWitness(selected,selectedTurn),
      events,controls:{reference:`session:${session.id}`,outside:!!metadata.outside,suspended:!!metadata.suspended||globalPauseHoldsSession(session.id),
        archived:session.status==='archived',consultationOnly:metadata.interactionPolicy==='consultation-only',
        stopRequested:!!selectedTurn.stop_requested_at||active.length>0,activeHandoffIds:handoffs.map(row=>String(row.id))},
      interval:{complete:true,fromOrdinal:selected.ordinal,throughOrdinal:intervalInputs.at(-1)!.ordinal,inputs:intervalInputs,
        classifications:intervalInputs.map(classify),mutationCoverage:{complete:true,reference:`owner-inputs:${creation.ordinal}:${inputs.at(-1)!.ordinal}`,
          fromInputId:creation.id,changes:[...admittedBindings,...unresolvedControls]},fifo:{complete:true,reference:`scheduler:${selectedTurn.id}`,
          selectedInputId:selected.id,runnablePredecessorInputIds:predecessors.map(row=>row.accepted_input_id??`turn:${row.id}`)}},
      ownerSnapshot:{session,inputs,turns,events,requests,handoffs,predecessors,active,steering,deliveries,source,sourceTurn}};
    const result=proveAcceptedBindingContinuation(snapshot);
    return {...result,interval:{acceptedWatermark:intervalInputs.at(-1)!.ordinal,eventWatermark:events.at(-1)?.sequence??0,
      inputCount:intervalInputs.length,acceptedWithoutTurnCount:intervalInputs.filter(row=>row.turn_id===null&&row.steering_id===null).length},
      missingNativeProof:['COMPLETE_NATIVE_INTERVAL','RECEIVER_EXECUTION_FENCE'],
      ...(input.includeSnapshot?{snapshot}:{})};
  })();
}
