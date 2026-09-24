#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { db, getSessionById } from '../src/state';
import { getAcceptedSessionInput, queueTurnContinuation, recordSessionEvent, sessionMetadata, stablePayload } from '../src/session-inputs';

// The operator invokes this bounded safeguard outside provider admission. It
// never deploys, runs a provider, or reuses an expired source as a live actor.
const [command, id, file] = process.argv.slice(2);
if (!id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('An exact continuation ID is required.');
const eventId = `continuation:${id}`;
const savedEvent = () => db.query('SELECT * FROM session_owner_events WHERE event_id=?').get(eventId) as any;
const sourceTurn = (input: any) => db.query('SELECT * FROM turns WHERE id=? AND session_id=?').get(input.turn_id, input.session_id) as any;
const output = (value: unknown) => console.log(JSON.stringify(value));

if (command === 'enroll') {
  const payload = JSON.parse(readFileSync(file, 'utf8'));
  const prior = savedEvent();
  if (prior) {
    if (stablePayload(JSON.parse(prior.payload_json)) !== stablePayload(payload)) throw new Error('Continuation identity conflict.');
    output({status:'enrolled', eventId, sessionId:prior.session_id, duplicate:true});
  } else {
    const source = getAcceptedSessionInput(payload.sourceInputId);
    const turn = source && sourceTurn(source);
    const steering = source?.steering_id ? db.query('SELECT status FROM turn_steering_messages WHERE id=?').get(source.steering_id) as any : null;
    if (!source || !turn || turn.native_run_id !== payload.sourceRunId || turn.status !== 'running'
      || !turn.provider_admission_intended_at || turn.stop_requested_at
      || (steering && !['sending','sent'].includes(steering.status))) throw new Error('Enrollment requires the exact admitted live source.');
    if (!/^[a-f0-9]{40}$/.test(payload.requiredCommit) || typeof payload.brief !== 'string' || !payload.brief.trim()
      || !Number.isSafeInteger(payload.deadlineMs) || payload.deadlineMs <= Date.now()) throw new Error('Commit, continuation brief and future deadline are required.');
    const session = getSessionById(source.session_id)!;
    if (session.status === 'archived' || sessionMetadata(session).suspended
      || sessionMetadata(session).interactionPolicy === 'consultation-only') throw new Error('Session cannot enroll work.');
    recordSessionEvent({eventId,sessionId:source.session_id,inputId:source.id,turnId:turn.id,kind:'native_continuation_enrolled',payload});
    output({status:'enrolled',eventId,sessionId:source.session_id,sourceTurnId:turn.id,deadlineMs:payload.deadlineMs});
  }
} else if (command === 'tick') {
  const event = savedEvent();
  if (!event) throw new Error('Continuation was not enrolled.');
  const payload = JSON.parse(event.payload_json);
  const inputId = `turn-continuation:${event.turn_id}`;
  const existing = getAcceptedSessionInput(inputId);
  if (existing) {
    const turn = sourceTurn(existing);
    output({status:turn?.status??'retained',inputId,sessionId:existing.session_id,runId:turn?.native_run_id??null,
      complete:!!turn?.provider_admission_intended_at || ['error','cancelled','parked','interrupted'].includes(turn?.status)});
  } else {
    const session = getSessionById(event.session_id);
    const stopped = db.query('SELECT id FROM turns WHERE session_id=? AND id>=? AND stop_requested_at IS NOT NULL LIMIT 1').get(event.session_id,event.turn_id);
    if (!session || session.status === 'archived' || sessionMetadata(session).suspended || stopped) {
      recordSessionEvent({eventId:`${eventId}:canceled`,sessionId:event.session_id,kind:'native_continuation_canceled',payload:{reason:'Stop, pause or archive'}});
      output({status:'canceled',complete:true});
    } else if (db.query("SELECT 1 FROM turns WHERE session_id=? AND status IN ('running','delivering','queued') LIMIT 1").get(event.session_id)) {
      output({status:'waiting_for_owner_yield',complete:false});
    } else {
      let health: Record<string,unknown> = {ready:false};
      try {
        const manifest = JSON.parse(readFileSync('/var/lib/slack-concierge-deployment/current/manifest.json','utf8'));
        const run = db.query("SELECT id,status,deployed_commit,service_invocation_id FROM deployment_runs WHERE status='succeeded' AND deployed_commit=? ORDER BY completed_at DESC LIMIT 1").get(manifest.git_commit) as any;
        const contains = Bun.spawnSync(['git','-C',process.env.CONCIERGE_REPO || '/root/workspace/slack-concierge','merge-base','--is-ancestor',payload.requiredCommit,manifest.git_commit]);
        if (run && contains.exitCode === 0) {
          const response = await fetch('http://localhost/sessions/v1/inbox', {unix:`${process.env.CONCIERGE_STATE_DIR}/requests.sock`,signal:AbortSignal.timeout(5000)} as any);
          const body = response.ok ? await response.json() as any : null;
          health = {ready:response.ok && body && Object.hasOwn(body,'session'),runId:run.id,commit:manifest.git_commit,serviceInvocationId:run.service_invocation_id,receiverStatus:response.status};
        } else health = {ready:false,commit:manifest.git_commit,successfulRun:run?.id??null};
      } catch (error) { health = {ready:false,error:error instanceof Error ? error.message : String(error)}; }
      const latest = db.query('SELECT id,status,repair_state,desired_commit,error FROM deployment_runs ORDER BY created_at DESC LIMIT 1').get();
      if (!health.ready && Date.now() < payload.deadlineMs) output({status:'waiting_for_health',health,deployment:latest,complete:false});
      else {
        const reason = health.ready ? 'Deployment and native Inbox readiness confirmed.' : 'The authorized activation deadline elapsed; readiness remains unconfirmed. Investigate the retained deployment evidence and report the concrete blocker.';
        const accepted=queueTurnContinuation(event.turn_id,{kind:'boundary',detail:
          `${reason}\n${JSON.stringify({health,deployment:latest})}\n${payload.brief}`});
        if(!accepted){output({status:'canceled',complete:true,reason:'The source stopped, was superseded, or its session is paused.'});}
        else {
          const turn=sourceTurn(accepted);
          output({status:'queued',inputId,sessionId:event.session_id,runId:turn?.native_run_id??null,health,complete:false});
        }
      }
    }
  }
} else throw new Error('Use enroll <id> <json-file> or tick <id>.');
