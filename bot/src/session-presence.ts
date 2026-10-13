import type {Database} from 'bun:sqlite';
import {agentDisplayName} from './aliases';
import {TURN_STATE} from './session-receipt-state';
import {localSessionNumber} from './peer-identity';
import {sessionCatalogueLabels} from './session-labels';
import type {AuthorSession} from './provider-history';

/**
 * What every surface shows about an agent: who it is (provider, model, effort and the name he
 * reads) and what it is doing (running, queued, completed…, and its timing). One rule, here, for
 * the full session view, the sidebar card and a message's author, so no two places can disagree.
 *
 * It exists because they did. The sidebar card was computed by the presentation worker with its
 * own copy of the running/completed rule, the session page by the owner with another, and a
 * thread answer was named after the provider of the session being viewed (the Inbox, Claude)
 * rather than the agent that wrote it. On 2026-10-13 one Gemini agent read "Gemini 3.8 Flash" in
 * the sidebar and "Claude" on its answer, and its card said "running 7m" while its page said
 * "Completed · 58s" (Tejas: "How are there a hundred different sources of information about what
 * an agent is?"). `check-agent-presence.ts` refuses a second derivation in the build.
 *
 * `presenceRevision` is the newest change-journal sequence for this session at the moment the
 * presence was read. Every read of the same session is ordered by it, so a client holding two
 * copies (a card and a full view) shows the newer one everywhere instead of whichever arrived.
 * Storage-neutral: it takes the ledger connection, so the read-only presentation worker and the
 * owner run the same code.
 */
export type AgentIdentity=Readonly<{provider:string|null;model:string|null;reasoningEffort:string|null;agentName:string|null}>;
export type SessionTiming=Readonly<{startedAt:string|null;endedAt:string|null;workStartedAt:string|null;running:boolean;workMs:number|null}>;
export type SessionPresence=AgentIdentity&Readonly<{execution:string;timing:SessionTiming|null;presenceRevision:number}>;

type PresenceSession={id:number;provider_id:string|null;agent_session_uuid:string|null};
type PresenceMeta={model?:unknown;reasoningEffort?:unknown;codexLifecycle?:any};
type TurnFacts={id:number;status:string;native_run_id:string|null;provider_turn_id:string|null;started_at:string|null;ended_at:string|null;
  provider_input_acknowledged_at:string|null;provider_duration_ms:number|null};

const iso=(value:string|null|undefined)=>value?new Date(value.includes('T')?value:value+'Z').toISOString():null;


/** Who the agent is, from the session's own record. A missing fact stays null; nothing is assumed. */
export function agentIdentity(session:{provider_id:string|null},meta:PresenceMeta):AgentIdentity {
  const provider=session.provider_id||null;
  const model=typeof meta.model==='string'&&meta.model?meta.model:null;
  const reasoningEffort=typeof meta.reasoningEffort==='string'&&meta.reasoningEffort?meta.reasoningEffort:null;
  return {provider,model,reasoningEffort,agentName:agentDisplayName(provider,model)};
}

/** The turn facts behind the status, for callers that also need run identities or the queue length. */
export function sessionExecution(source:Database,session:PresenceSession,meta:PresenceMeta) {
  const fields='id,status,native_run_id,provider_turn_id,started_at,ended_at,provider_input_acknowledged_at,provider_duration_ms';
  const latest=source.query(`SELECT ${fields} FROM turns WHERE session_id=? ORDER BY id DESC LIMIT 1`).get(session.id) as TurnFacts|null;
  const active=source.query(`SELECT ${fields} FROM turns WHERE session_id=? AND status IN ('running','delivering') ORDER BY id DESC LIMIT 1`).get(session.id) as TurnFacts|null;
  const queued=(source.query("SELECT count(*) AS count FROM turns WHERE session_id=? AND status='queued'").get(session.id) as {count:number}).count;
  const observed=session.provider_id==='codex'&&meta.codexLifecycle?.threadId===session.agent_session_uuid?meta.codexLifecycle:null;
  const lastStarted=source.query("SELECT started_at FROM turns WHERE session_id=? AND status<>'queued' AND started_at IS NOT NULL ORDER BY id DESC LIMIT 1")
    .get(session.id) as {started_at:string}|null;
  // External provider work has no owner input/run. Project its evidence without manufacturing one.
  const matchingExternal=observed?.turnId?source.query('SELECT 1 FROM turns WHERE session_id=? AND provider_turn_id=? LIMIT 1').get(session.id,observed.turnId):null;
  const external=observed&&observed.state!=='idle'&&!active&&!matchingExternal
    &&(!lastStarted||Date.parse(observed.startedAt??observed.observedAt)>=Date.parse(iso(lastStarted.started_at)!))?observed:null;
  const execution:string=active?'running':external&&['running','uncertain'].includes(external.state)?external.state:
    queued?'queued':external?external.state:latest?TURN_STATE[latest.status]??'idle':'idle';
  const timedRun=active??latest;
  const timing:SessionTiming|null=external
    ?{startedAt:external.startedAt??null,endedAt:external.endedAt??null,workStartedAt:external.startedAt??null,running:external.state==='running',workMs:external.workMs??null}
    :timedRun?{startedAt:iso(timedRun.started_at),endedAt:iso(timedRun.ended_at),workStartedAt:iso(timedRun.provider_input_acknowledged_at),
      running:['running','delivering'].includes(timedRun.status),workMs:timedRun.provider_duration_ms??null}:null;
  return {latest,active,queued,external,execution,timing};
}

/** The newest journal sequence that touched this session; read before the facts, so the facts are at least that new. */
export function presenceRevision(source:Database,sessionId:number):number {
  const row=source.query('SELECT MAX(sequence) AS sequence FROM presentation_change_log WHERE session_id=?').get(sessionId) as {sequence:number|null}|null;
  return row?.sequence??0;
}

/**
 * The session a message came from, named by the same identity rule. Local sessions read their own
 * record; a peer's read this machine's last catalogue of that peer. The owner and the prepared
 * Inbox worker both call this; there is no other author-session rule.
 */
export function authorSessionOf(source:Database,id:string):AuthorSession|undefined {
  const local=localSessionNumber(id);
  if(local!==null){
    const row=source.query('SELECT provider_id,native_metadata_json,slack_channel_id,slack_thread_ts FROM sessions WHERE id=?')
      .get(local) as {provider_id:string|null;native_metadata_json:string|null;slack_channel_id:string|null;slack_thread_ts:string|null}|null;
    if(!row)return undefined;
    return {id:`concierge:${local}`,title:sessionCatalogueLabels(source,row).title,...agentIdentity(row,JSON.parse(row.native_metadata_json||'{}'))};
  }
  const colon=id.indexOf(':');if(colon<=0)return undefined;
  const peer=id.slice(0,colon),remote=id.slice(colon+1);
  const row=source.query(`SELECT view_json FROM session_peer_catalogue WHERE peer=? AND remote_session_id IN (?,?)
    ORDER BY updated_at_ms DESC LIMIT 1`).get(peer,remote,`concierge:${remote}`) as {view_json:string}|null;
  const view=row?JSON.parse(row.view_json):null;
  // A peer session this machine has no record of is unknown. It used to default to Claude.
  const identity=agentIdentity({provider_id:typeof view?.provider==='string'?view.provider:null},view??{});
  return {id,title:view?.title??`Session on ${peer}`,...identity,agentName:typeof view?.agentName==='string'?view.agentName:identity.agentName};
}

export function sessionPresence(source:Database,session:PresenceSession,meta:PresenceMeta) {
  const revision=presenceRevision(source,session.id);
  const facts=sessionExecution(source,session,meta);
  const presence:SessionPresence={...agentIdentity(session,meta),execution:facts.execution,timing:facts.timing,presenceRevision:revision};
  return {presence,facts};
}
