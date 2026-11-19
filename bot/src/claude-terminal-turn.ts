import {CLAUDE_TERMINAL_SCOPE, CLAUDE_TERMINAL_SOURCE, isTerminalClaude, terminalClaudeProcessKey} from './claude-terminal-process';
import {log} from './log';
import {processIdentity} from './runtime-identity';
import {supersededBy, withdrawnSuccessor} from './session-handoff';
import {nativeRunId, recordSessionEvent, retainSessionInput, sessionMetadata} from './session-inputs';
import {db, getSessionById, registerProcessInstance} from './state';

type SourceTurn = {id:number; owner_instance_id:string|null};

function closeSource(turnId:number,outcome:'done'|'error'|'cancelled') {
  db.query('UPDATE turns SET status=?,ended_at=CURRENT_TIMESTAMP WHERE id=? AND status=?')
    .run(outcome,turnId,CLAUDE_TERMINAL_SOURCE);
}

/** The terminal handles delivery. Retain a command source without queueing the prompt for replay. */
export function claudeTerminalTurn(input: {sessionId:string; pid:number; event:'start'|'stop'|'failure'; action_id:string}) {
  if (!isTerminalClaude(input.pid,input.sessionId)) throw new Error('The local Claude Code resume is unavailable.');
  if (!['start','stop','failure'].includes(input.event) || !/^[0-9a-f-]{36}$/i.test(input.action_id ?? ''))
    throw new Error('A terminal prompt needs its own action identity.');
  const process = processIdentity(input.pid);
  const processKey = terminalClaudeProcessKey(process);
  return db.transaction(() => {
    const bindings = db.query("SELECT id FROM sessions WHERE provider_id='claude-code' AND agent_session_uuid=? LIMIT 2")
      .all(input.sessionId) as {id:number}[];
    if (bindings.length !== 1) return {source:null};
    const session = getSessionById(bindings[0]!.id)!;
    const current = db.query('SELECT id,owner_instance_id FROM turns WHERE session_id=? AND status=? ORDER BY id DESC LIMIT 1')
      .get(session.id,CLAUDE_TERMINAL_SOURCE) as SourceTurn|null;
    const own = current?.owner_instance_id === processKey ? current : null;
    if (input.event !== 'start') {
      const prompt=db.query("SELECT turn_id FROM session_inputs WHERE session_id=? AND scope=? AND action_id=?")
        .get(session.id,CLAUDE_TERMINAL_SCOPE,input.action_id) as {turn_id:number|null}|null;
      if (own&&prompt?.turn_id===own.id) {
        const outcome=input.event==='failure'?'error':'done';
        closeSource(own.id,outcome);
        log('info','claude_terminal_turn_finished',{session_id:session.id,turn_id:own.id,outcome});
      }
      return {source:null};
    }
    const metadata = sessionMetadata(session);
    // The managed runner selects where app work launches. The verified local process above
    // establishes this terminal source's own machine without changing that managed binding.
    if (session.status === 'archived' || metadata.suspended
      || metadata.interactionPolicy || metadata.canvasObservation || supersededBy(session.id) || withdrawnSuccessor(session.id)
      || db.query("SELECT 1 FROM session_inputs WHERE scope='lab:invocation' AND session_id=? LIMIT 1").get(session.id))
      throw new Error('This Claude Code conversation cannot accept terminal commands on this machine.');
    const retained = retainSessionInput({sessionId:session.id,scope:CLAUDE_TERMINAL_SCOPE,actionId:input.action_id,
      kind:'input',origin:'service',payload:{text:'Claude Code terminal prompt',processKey}}).input;
    if (retained.turn_id) {
      return {source:own?.id === retained.turn_id ? {inputId:retained.id,runId:nativeRunId(own.id)} : null};
    }
    // An interrupt can skip Stop. A new prompt retires the previous command source.
    if (current) closeSource(current.id,'cancelled');
    registerProcessInstance(processKey,process.pid,process.bootId,process.startTicks);
    const turnId = Number(db.query(`INSERT INTO turns(session_id,slack_user_msg_ts,user_text,status,turn_kind,
      accepted_input_id,owner_instance_id)
      VALUES(?,NULL,?,?,?,?,?)`)
      .run(session.id,'Claude Code terminal prompt',CLAUDE_TERMINAL_SOURCE,CLAUDE_TERMINAL_SOURCE,retained.id,processKey).lastInsertRowid);
    db.query('UPDATE session_inputs SET turn_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(turnId,retained.id);
    const runId = nativeRunId(turnId);
    recordSessionEvent({eventId:`terminal-prompt:${retained.id}`,sessionId:session.id,inputId:retained.id,turnId,
      kind:'terminal_command_source',payload:{entrance:'claude-terminal'}});
    log('info','claude_terminal_turn_admitted',{session_id:session.id,turn_id:turnId});
    return {source:{inputId:retained.id,runId}};
  })();
}
