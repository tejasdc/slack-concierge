import {db,executionChanged,finishTurn,getSessionById} from './state';
import {enqueueSessionInput,getAcceptedSessionInput,recordSessionEvent,sessionMetadata,updateSessionMetadata} from './session-inputs';
import {newWorkCapacity} from './provider-start-choice';
import {log} from './log';

// The October 10 outside budget intervention used ordinary, indefinite Pause actions.
// Covered inputs have retained Codex or Inbox evidence; future and unmatched due
// firings remain queued. The taste-mining request is settled separately from retained
// Codex evidence before its session can join this pause repair.
const inboxReconciliation='request:9e48c7e7-029c-4a39-928b-8a62ce267dcf';
const codexDuty='request:51c8eb6e-280a-4526-9d9a-4dc0048df623';
const tasteRequest='63885d87-11d6-4bb6-8832-4601b61d48a0';
const tasteInput=`request:${tasteRequest}`;
const tasteCoverageEvent=`october-taste-coverage:${tasteRequest}`;
const incident:ReadonlyArray<readonly [number,readonly string[],string,string,readonly string[]?]>=[
  // The scheduled fallback was due after Codex checked the watch queue. It remains
  // the session's next real check; only the two earlier watch firings were covered.
  [4650,['watch:932fd5f05223:fired','watch:3e46e8578af0:fired'],codexDuty,'Thread reader',['saved-repeat:5865:2']],
  [4927,['return:325f1f58-fc9f-41d3-b94f-ba30f91c0a20'],inboxReconciliation,'4927'],
  [4616,['return:b5bc9b36-c258-42c1-855f-af5a751d771f'],inboxReconciliation,'4616'],
  [4926,['return:581fc44f-fdd3-466d-938e-4aa188d0a2ef'],inboxReconciliation,'4926'],
  [4543,['repair-notice:grafana:2f1c5471715a91fe9968b7568d77650331d6039ca471e31fd8ccdf0866847fe4:resolved',
    'repair-notice:grafana:2f1c5471715a91fe9968b7568d77650331d6039ca471e31fd8ccdf0866847fe4:firing'],codexDuty,'Repair agent'],
  [4923,[],inboxReconciliation,'4923'],
  [4746,['request:898c3a49-7b20-4f87-9e06-0065b21ee2c0'],inboxReconciliation,'4746'],
  // The overnight Codex report covered the *previous* review. This queued firing is
  // tomorrow's review and must remain runnable after the stale pause is removed.
  [4166,[],codexDuty,'Nightly review',['saved-repeat:5174:3']],
  [4863,['request:f52849fb-7d4f-4787-987c-2064e8e73fa8'],inboxReconciliation,'4863'],
  [4780,['request:136e826c-8be5-4c6f-a3d1-8fd8f9c93dfd'],inboxReconciliation,'4780'],
  // The Codex check was at 5:03 AM. This firing became due at 5:58 AM and is
  // the next check, not a duplicate of the completed one.
  [4026,[],codexDuty,'Adidas watch',['saved-repeat:4787:11']],
  [4572,['saved-repeat:5679:1'],codexDuty,'Daily journal review'],
  [4966,[tasteInput],codexDuty,'Taste mining'],
];

/** Credit the original request to the actual Codex answer and retire only its untouched
 * October 10 firing. No reply is attributed to Claude. A failed precondition leaves its
 * pause, request and queue intact for human investigation. */
export function reconcileCoveredTasteRequest():boolean {
  try {
    const reconciled=db.transaction(()=>{
      const request=db.query('SELECT * FROM session_communication_requests WHERE request_id=?')
        .get(tasteRequest) as {source_session_id:number;source_input_id:string|null;target_session_id:number;
          target_input_id:string|null;target_turn_id:number|null;outcome:string|null;payload_json:string}|null;
      if(!request||request.outcome!==null||request.source_session_id!==4626||request.target_session_id!==4966
        ||request.target_input_id!==tasteInput||request.target_turn_id!==6428
        ||request.source_input_id!=='request:7326362a-4f04-46ff-b313-40206bc986b3')return false;
      const requested=JSON.parse(request.payload_json);
      if(requested.requestedEffect!=='work'||requested.text!=='Run ~/workspace/skills/interface-decisions-skill/references/mining-runbook.md exactly, start to finish.'
        ||requested.saved?.atMs!==1791626400000||requested.saved?.repeatEveryMs!==86400000)return false;
      const source=getAcceptedSessionInput(request.source_input_id);
      const accepted=getAcceptedSessionInput(tasteInput);
      if(!source||source.session_id!==4626||!accepted||accepted.session_id!==4966
        ||accepted.kind!=='create'||accepted.turn_id!==6428||accepted.request_id!==tasteRequest
        ||accepted.source_input_id!==request.source_input_id||accepted.source_run_id!== '247140db-c150-454d-bacb-c8b237919319'
        ||accepted.receipt_json!==null)return false;
      const turn=db.query('SELECT * FROM turns WHERE id=?').get(6428) as {session_id:number;status:string;
        accepted_input_id:string|null;saved_kind:string|null;saved_root_id:number|null;saved_sequence:number|null;
        saved_fire_at_ms:number|null;saved_repeat_ms:number|null;dispatch_attempt:number;
        provider_admission_intended_at:string|null;provider_started_at:string|null;provider_turn_id:string|null;
        provider_input_acknowledged_at:string|null}|null;
      if(!turn||turn.session_id!==4966||turn.status!=='queued'||turn.accepted_input_id!==tasteInput
        ||turn.saved_kind!=='scheduled'||turn.saved_root_id!==6428||turn.saved_sequence!==0
        ||turn.saved_fire_at_ms!==1791626400000||turn.saved_repeat_ms!==86400000
        ||turn.dispatch_attempt!==0||turn.provider_admission_intended_at||turn.provider_started_at
        ||turn.provider_turn_id||turn.provider_input_acknowledged_at)return false;
      const session=getSessionById(4966);
      if(!session||session.provider_id!=='claude-code'||session.status==='archived'||!sessionMetadata(session).suspended)return false;
      const latest=db.query(`SELECT payload_json FROM session_owner_events WHERE session_id=4966 AND kind='action'
        AND json_extract(payload_json,'$.action.kind') IN ('pause','continue') ORDER BY sequence DESC LIMIT 1`)
        .get() as {payload_json:string}|null;
      if(!latest||JSON.parse(latest.payload_json).clientActionId!=='budget-pause-2026-10-10-4966')return false;
      if(db.query("SELECT 1 FROM turns WHERE session_id=4966 AND status='queued' AND id<>6428 LIMIT 1").get()
        ||db.query("SELECT 1 FROM turns WHERE session_id=4966 AND status IN ('running','delivering','parked','interrupted','delivery_parked') LIMIT 1").get()
        ||db.query('SELECT 1 FROM turn_dependencies WHERE prerequisite_turn_id=6428 AND satisfied_at IS NULL LIMIT 1').get()
        ||db.query("SELECT 1 FROM session_communication_requests WHERE target_session_id=4966 AND outcome IS NULL AND request_id<>? LIMIT 1").get(tasteRequest)
        ||db.query("SELECT 1 FROM session_communication_events WHERE request_id=? AND kind='final' LIMIT 1").get(tasteRequest))return false;
      const codex=db.query('SELECT outcome,result_json,target_session_id,target_input_id,target_turn_id FROM session_communication_requests WHERE request_id=?')
        .get(codexDuty.slice('request:'.length)) as {outcome:string|null;result_json:string|null;
          target_session_id:number;target_input_id:string|null;target_turn_id:number|null}|null;
      if(!codex||codex.outcome!=='answered'||!codex.result_json||codex.target_session_id!==5014
        ||codex.target_input_id!==codexDuty||codex.target_turn_id!==6504)return false;
      const result=JSON.parse(codex.result_json);
      const final=db.query("SELECT payload_json FROM session_communication_events WHERE event_id=? AND request_id=? AND kind='final' AND superseded_by_event_id IS NULL")
        .get(result.event_id,codexDuty.slice('request:'.length)) as {payload_json:string}|null;
      const worker=db.query('SELECT status,provider_input_acknowledged_at FROM turns WHERE id=6504 AND session_id=5014')
        .get() as {status:string;provider_input_acknowledged_at:string|null}|null;
      const taste=result.text?.match(/- Taste mining: ([^\n]+)/)?.[1];
      if(!final||!worker||worker.status!=='done'||!worker.provider_input_acknowledged_at
        ||result.workDisposition!=='completed'||result.responding_session_id!=='concierge:5014'
        ||result.completionTurnId!==6504||result.event_id!=='ec9f5762-cba0-4c06-a662-7225decdc204'
        ||JSON.parse(final.payload_json).text!==result.text||!taste
        ||!taste.includes('screened 117 new human messages through 5:00 AM Eastern')
        ||!taste.includes('recorded 91 feedback points'))return false;
      const text=`The October 10 taste pass was completed by the Codex overnight worker: ${taste} The queued Claude firing was retired before provider admission. Later daily firings remain scheduled.`;
      const payload={text,summary:'October 10 taste pass completed by Codex; Claude duplicate retired and daily schedule preserved',
        final:true,workDisposition:'completed',responding_session_id:'concierge:5014',
        coverage:{kind:'completed_elsewhere',requestId:codexDuty.slice('request:'.length),
          resultEventId:result.event_id,completionTurnId:6504,sourceResult:result}};
      finishTurn(6428,'cancelled','Covered by the retained October 10 Codex taste pass; Claude was not invoked.');
      db.query("UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(JSON.stringify({state:'canceled',coverageEvidence:result.event_id}),tasteInput);
      recordSessionEvent({eventId:`october-budget-covered:${tasteInput}`,sessionId:4966,inputId:tasteInput,
        turnId:6428,kind:'provider_recovery',payload:{reason:'covered_overnight_run',coverageEvidence:result.event_id}});
      db.query(`INSERT INTO session_communication_events(event_id,request_id,kind,payload_json,created_at_ms)
        VALUES(?,?,'final',?,?)`).run(tasteCoverageEvent,tasteRequest,JSON.stringify(payload),Date.now());
      db.query("UPDATE session_communication_requests SET outcome='answered',status='settled',result_json=? WHERE request_id=?")
        .run(JSON.stringify({...payload,event_id:tasteCoverageEvent}),tasteRequest);
      recordSessionEvent({eventId:tasteCoverageEvent,sessionId:4626,inputId:request.source_input_id,
        kind:'response',payload:{requestId:tasteRequest,kind:'final',...payload}});
      const requester=getSessionById(4626)!;
      updateSessionMetadata(4626,{generation:(sessionMetadata(requester).generation??0)+1});
      return true;
    }).immediate();
    if(reconciled){log('warn','october_taste_request_covered',{request_id:tasteRequest,evidence_event_id:'ec9f5762-cba0-4c06-a662-7225decdc204'});executionChanged();}
    return reconciled;
  } catch(error){log('error','october_taste_request_reconciliation_failed',{error:error instanceof Error?error.message:String(error)});return false;}
}

function completedEvidence(requestId:string,anchor:string):boolean {
  const row=db.query('SELECT outcome,result_json FROM session_communication_requests WHERE request_id=?')
    .get(requestId.slice('request:'.length)) as {outcome:string|null;result_json:string|null}|null;
  if(row?.outcome!=='answered'||!row.result_json)return false;
  const result=JSON.parse(row.result_json);
  return (result.workDisposition==='completed'||result.declaredDisposition==='completed')
    &&typeof result.text==='string'&&result.text.includes(anchor);
}

/** One audited data repair. The owner runs it after each fresh account reading; a changed
 * pause or queue makes that session stay stopped instead of guessing. */
export function recoverOctoberBudgetPauses():number {
  const room=newWorkCapacity('claude-code');
  if(!room||room.used>=100)return 0;
  let released=0;
  for(const [sessionId,covered,evidence,anchor,preserved=[]] of incident){
    try {
      const done=db.transaction(()=>{
        const session=getSessionById(sessionId);
        if(!session||session.provider_id!=='claude-code'||session.status==='archived'||!sessionMetadata(session).suspended)return false;
        if(!completedEvidence(evidence,anchor))return false;
        const action=db.query(`SELECT payload_json FROM session_owner_events WHERE session_id=? AND kind='action'
          AND json_extract(payload_json,'$.action.kind') IN ('pause','continue') ORDER BY sequence DESC LIMIT 1`)
          .get(sessionId) as {payload_json:string}|null;
        const payload=action?JSON.parse(action.payload_json):null;
        if(payload?.clientActionId!==`budget-pause-2026-10-10-${sessionId}`||payload?.action?.kind!=='pause')return false;
        const queued=db.query("SELECT id,accepted_input_id,saved_kind FROM turns WHERE session_id=? AND status='queued' ORDER BY id")
          .all(sessionId) as {id:number;accepted_input_id:string|null;saved_kind:string|null}[];
        if(queued.some(turn=>!turn.accepted_input_id||(!covered.includes(turn.accepted_input_id)&&!preserved.includes(turn.accepted_input_id))))return false;
        if(preserved.some(id=>!queued.some(turn=>turn.accepted_input_id===id&&turn.saved_kind==='scheduled')))return false;
        // Interrupted turns are terminal historical evidence. The owner does
        // not claim them again; later accepted inputs may run past them.
        if(db.query(`SELECT 1 FROM turns WHERE session_id=? AND status IN ('running','delivering','parked','delivery_parked') LIMIT 1`).get(sessionId))return false;
        const orphaned=db.query(`SELECT id FROM session_inputs WHERE session_id=? AND kind IN ('input','create')
          AND turn_id IS NULL AND receipt_json IS NULL ORDER BY rowid`).all(sessionId) as {id:string}[];
        const expectedOrphan=sessionId===4923?'watch:a2045cc2f32b:expired'
          :null;
        // Alert intake kept accepting notices while the repair conversation was
        // suspended. An unattached, unsettled notice was never submitted, and
        // the owner can admit those exact retained inputs in their original order.
        if(orphaned.some(input=>sessionId===4543
          ? !input.id.startsWith('repair-notice:') : input.id!==expectedOrphan))return false;
        if(db.query(`SELECT 1 FROM session_communication_requests WHERE source_session_id=? AND outcome IS NULL LIMIT 1`).get(sessionId))return false;
        if(db.query(`SELECT 1 FROM session_communication_requests WHERE target_session_id=? AND outcome IS NULL LIMIT 1`).get(sessionId))return false;
        for(const id of [...covered,...preserved]){
          const input=getAcceptedSessionInput(id);
          if(!input||input.session_id!==sessionId||!input.turn_id)return false;
          const turn=db.query('SELECT status FROM turns WHERE id=?').get(input.turn_id) as {status:string}|null;
          if(!turn||!['queued','cancelled'].includes(turn.status))return false;
          if(turn.status==='cancelled'&&JSON.parse(input.receipt_json??'{}').state!=='canceled')return false;
          if(preserved.includes(id)&&(turn.status!=='queued'||JSON.parse(input.receipt_json??'{}').state==='canceled'))return false;
          if(db.query(`SELECT 1 FROM session_communication_requests WHERE target_input_id=? AND outcome IS NULL LIMIT 1`).get(id))return false;
          if(input.kind==='create'&&input.request_id&&!db.query(`SELECT 1 FROM session_communication_requests
            WHERE target_input_id=? AND (outcome='canceled' OR (request_id=? AND outcome='answered'
              AND json_extract(result_json,'$.coverage.kind')='completed_elsewhere'
              AND json_extract(result_json,'$.coverage.resultEventId')=?)) LIMIT 1`)
              .get(id,tasteRequest,'ec9f5762-cba0-4c06-a662-7225decdc204'))return false;
        }
        const coveredTurns=queued.filter(turn=>covered.includes(turn.accepted_input_id!));
        for(const turn of coveredTurns){
          // A dependent request needs an attributed completion, not a synthetic
          // cancellation of the work it was waiting for.
          if(db.query('SELECT 1 FROM turn_dependencies WHERE prerequisite_turn_id=? AND satisfied_at IS NULL LIMIT 1').get(turn.id))return false;
        }
        for(const turn of coveredTurns){
          finishTurn(turn.id,'cancelled','This exact overnight run was covered by Codex; later runs remain scheduled.');
          db.query(`UPDATE session_inputs SET receipt_json=json_set(coalesce(receipt_json,'{}'),
            '$.state','canceled','$.coverageEvidence',?),updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(evidence,turn.accepted_input_id);
          recordSessionEvent({eventId:`october-budget-covered:${turn.accepted_input_id}`,sessionId,inputId:turn.accepted_input_id!,
            turnId:turn.id,kind:'provider_recovery',payload:{reason:'covered_overnight_run',coverageEvidence:evidence}});
        }
        if(sessionId===4923){
          const discarded=db.query(`SELECT turn.accepted_input_id AS input_id FROM turns turn
            JOIN session_owner_events event ON event.turn_id=turn.id AND event.kind='continuation_discarded'
            WHERE turn.id=6454 AND turn.session_id=? AND turn.status='cancelled'
              AND json_extract(event.payload_json,'$.why')='pause' LIMIT 1`).get(sessionId) as {input_id:string|null}|null;
          if(!discarded?.input_id)throw new Error('The paused continuation changed before incident reconciliation.');
          db.query(`UPDATE session_inputs SET receipt_json=json_set(coalesce(receipt_json,'{}'),
            '$.state','canceled','$.coverageEvidence',?),updated_at=CURRENT_TIMESTAMP WHERE id=?`)
            .run(evidence,discarded.input_id);
          recordSessionEvent({eventId:'october-budget-covered-continuation:6454',sessionId,inputId:discarded.input_id,
            turnId:6454,kind:'provider_recovery',payload:{reason:'covered_discarded_continuation',coverageEvidence:evidence}});
          if(orphaned.length){
            const retired=db.query(`UPDATE session_inputs SET receipt_json=json_set(coalesce(receipt_json,'{}'),
              '$.state','canceled','$.coverageEvidence',?),updated_at=CURRENT_TIMESTAMP WHERE id=? AND turn_id IS NULL AND receipt_json IS NULL`)
              .run(evidence,expectedOrphan);
            if(retired.changes!==1)throw new Error('The obsolete watch result changed before incident reconciliation.');
            recordSessionEvent({eventId:'october-budget-covered-watch-expiry:4923',sessionId,inputId:expectedOrphan!,
              kind:'provider_recovery',payload:{reason:'superseded_review_watch',coverageEvidence:evidence}});
          }
        }
        updateSessionMetadata(sessionId,{suspended:false});
        if(sessionId===4543)for(const input of orphaned){
          if(!enqueueSessionInput(input.id).turn_id)
            throw new Error('A retained repair notice did not become runnable.');
        }
        recordSessionEvent({eventId:`october-budget-pause-released:${sessionId}`,sessionId,kind:'provider_recovery',
          payload:{reason:'budget_pause_stale_after_fresh_capacity',pauseActionId:payload.clientActionId,coveredInputIds:covered,
            preservedInputIds:preserved,coverageEvidence:evidence}});
        return true;
      }).immediate();
      if(done)released++;
    } catch(error){log('error','october_budget_pause_recovery_failed',{session_id:sessionId,error:error instanceof Error?error.message:String(error)});}
  }
  if(released){log('warn','october_budget_pauses_released',{sessions:released});executionChanged();}
  return released;
}
