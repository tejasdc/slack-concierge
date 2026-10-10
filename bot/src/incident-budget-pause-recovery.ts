import {db,executionChanged,finishTurn,getSessionById} from './state';
import {enqueueSessionInput,getAcceptedSessionInput,recordSessionEvent,sessionMetadata,updateSessionMetadata} from './session-inputs';
import {newWorkCapacity} from './provider-start-choice';
import {log} from './log';

// The October 10 outside budget intervention used ordinary, indefinite Pause actions.
// Covered inputs have retained Codex or Inbox evidence; future and unmatched due
// firings remain queued. The still-open taste-mining request is deliberately absent: its requester has
// not settled the original obligation, so releasing that conversation could duplicate it.
const inboxReconciliation='request:9e48c7e7-029c-4a39-928b-8a62ce267dcf';
const codexDuty='request:51c8eb6e-280a-4526-9d9a-4dc0048df623';
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
];

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
          :sessionId===4543?'repair-notice:outside-monitor:f16bfc4e-3e1e-4e99-b261-dc6fdfb7d061:reopened:9':null;
        if(orphaned.some(input=>input.id!==expectedOrphan))return false;
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
            WHERE target_input_id=? AND outcome='canceled' LIMIT 1`).get(id))return false;
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
        if(sessionId===4543&&orphaned.length&&!enqueueSessionInput(expectedOrphan!).turn_id)
          throw new Error('The retained repair notice did not become runnable.');
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
