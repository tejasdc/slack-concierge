import {CLAUDE_TERMINAL_SCOPE, isTerminalClaude, terminalClaudeProcessKey} from './claude-terminal-process';
import {log} from './log';
import {processIdentity} from './runtime-identity';
import {supersededBy, withdrawnSuccessor} from './session-handoff';
import {nativeRunId, recordSessionEvent, retainSessionInput, sessionMetadata} from './session-inputs';
import {db, finishTurn, getSessionById, registerProcessInstance} from './state';

type LiveTurn = {id:number; owner_instance_id:string|null};

/** The terminal already sent the prompt. Retain a command source without queueing it for replay. */
export function claudeTerminalTurn(input: {sessionId:string; pid:number; event:'start'|'stop'; action_id?:string}) {
  if (!isTerminalClaude(input.pid,input.sessionId)) throw new Error('The local Claude Code resume is unavailable.');
  if (input.event !== 'stop' && (input.event !== 'start' || !/^[0-9a-f-]{36}$/i.test(input.action_id ?? '')))
    throw new Error('A terminal prompt needs its own action identity.');
  const process = processIdentity(input.pid);
  const processKey = terminalClaudeProcessKey(process);
  return db.transaction(() => {
    const bindings = db.query("SELECT id FROM sessions WHERE provider_id='claude-code' AND agent_session_uuid=? LIMIT 2")
      .all(input.sessionId) as {id:number}[];
    if (bindings.length !== 1) return {source:null};
    const session = getSessionById(bindings[0]!.id)!;
    const live = db.query("SELECT id,owner_instance_id FROM turns WHERE session_id=? AND status IN ('running','delivering') ORDER BY id DESC LIMIT 2")
      .all(session.id) as LiveTurn[];
    const own = live.find(turn => turn.owner_instance_id === processKey);
    if (input.event === 'stop') {
      if (own) {
        finishTurn(own.id,'done',null);
        log('info','claude_terminal_turn_finished',{session_id:session.id,turn_id:own.id});
      }
      return {source:null};
    }
    const metadata = sessionMetadata(session);
    if (session.status === 'archived' || metadata.suspended || metadata.providerRunner
      || metadata.interactionPolicy || metadata.canvasObservation || supersededBy(session.id) || withdrawnSuccessor(session.id)
      || db.query("SELECT 1 FROM session_inputs WHERE scope='lab:invocation' AND session_id=? LIMIT 1").get(session.id))
      throw new Error('This Claude Code conversation cannot accept terminal commands on this machine.');
    if (live.some(turn => turn !== own)) throw new Error('Concierge already has a running turn in this conversation.');
    const retained = retainSessionInput({sessionId:session.id,scope:CLAUDE_TERMINAL_SCOPE,actionId:input.action_id!,
      kind:'input',origin:'service',payload:{text:'Claude Code terminal prompt',processKey}}).input;
    if (retained.turn_id) {
      return {source:own?.id === retained.turn_id ? {inputId:retained.id,runId:nativeRunId(own.id)} : null};
    }
    // An interrupt can skip Stop. The next submitted prompt supersedes only this process's turn.
    if (own) finishTurn(own.id,'cancelled',null);
    registerProcessInstance(processKey,process.pid,process.bootId,process.startTicks);
    const turnId = Number(db.query(`INSERT INTO turns(session_id,slack_user_msg_ts,user_text,status,turn_kind,
      accepted_input_id,owner_instance_id,provider_admission_intended_at,provider_started_at)
      VALUES(?,NULL,?,'running','native',?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
      .run(session.id,'Claude Code terminal prompt',retained.id,processKey).lastInsertRowid);
    db.query('UPDATE session_inputs SET turn_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(turnId,retained.id);
    const runId = nativeRunId(turnId);
    recordSessionEvent({eventId:`terminal-prompt:${retained.id}`,sessionId:session.id,inputId:retained.id,turnId,
      kind:'accepted',payload:{origin:'service',entrance:'claude-terminal'}});
    log('info','claude_terminal_turn_admitted',{session_id:session.id,turn_id:turnId});
    return {source:{inputId:retained.id,runId}};
  })();
}
