import {basename,relative} from 'node:path';
import {realpathSync} from 'node:fs';
import {db,getSessionById,type SessionRow} from './state';
import {sessionMetadata,updateSessionMetadata} from './session-inputs';
import {containingProject,sessionProject} from './session-projects';
import {sessionAddress} from './session-address';
import {REPAIR_AGENT_TITLE} from './repair-notices';

/** One folder owns each continuing job. Paths are relative to this machine's workspace root. */
export const STANDING_AGENTS = [
  {role:'inbox',project:'slack-inbox',description:'Sort and route incoming work.',wake:'New Inbox captures and addressed replies.'},
  {role:'journal-keeper',project:'journal-keeper',description:'Keep observations from saved journal entries.',wake:'A saved journal entry or check-in.'},
  {role:'messaging',project:'messaging-agent',description:'Draft and send Tejas’s messages.',wake:'Addressed writing and sending requests.'},
  {role:'thread-reader',project:'thread-reader',description:'Read and follow named threads.',wake:'Thread reading requests and watches.'},
  {role:'reader-parsing-repair',project:'agents/reader-parsing-repair',description:'Repair Reader parsing failures.',wake:'Reader parsing failures.'},
  {role:'reader-intake-sorting',project:'agents/reader-intake-sorting',description:'Sort incoming Reader items.',wake:'Reader intake requests.'},
  {role:'todo',project:'agents/todo-agent',description:'Manage Tejas’s to-dos.',wake:'To-do requests from the Inbox and other agents.'},
  {role:'email-reader',project:'agents/email-reader',description:'Read and triage email.',wake:'Email reading requests.'},
  {role:'concierge-repair',project:'agents/concierge-repair',description:'Investigate and repair Concierge failures.',wake:'Retained health and deployment notices.'},
  {role:'thinkering-nightly-review',project:'agents/thinkering-nightly-review',description:'Review Thinkering each night.',wake:'Its repeating nightly schedule.'},
  {role:'taste-mining',project:'agents/taste-mining',description:'Turn Tejas’s feedback into his taste profile.',wake:'Its repeating schedule.'},
  {role:'ai-provider-watch',project:'agents/ai-provider-watch',description:'Watch Anthropic and OpenAI changes and suggest what to adopt.',wake:'Its repeating schedule.'},
  {role:'agent-instructions-upkeep',project:'agents/agent-instructions-upkeep',description:'Keep agent instructions useful: route new rules and failure lessons to their owners.',wake:'Its nightly schedule.'},
  {role:'workspace-organizer',project:'agents/workspace-organizer',description:'Choose placement for new persistent workspace projects and review the layout.',wake:'A project placement consultation or its recurring review.'},
] as const;

export type StandingAgentRole = typeof STANDING_AGENTS[number]['role'];
for(const agent of STANDING_AGENTS) {
  if(!/^[a-z][a-z0-9-]*$/.test(agent.role)
    || !/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/.test(agent.project))
    throw new Error(`Invalid standing agent folder for ${agent.role}: ${agent.project}`);
}
if(new Set(STANDING_AGENTS.map(agent=>agent.role)).size!==STANDING_AGENTS.length
  || new Set(STANDING_AGENTS.map(agent=>agent.project)).size!==STANDING_AGENTS.length)
  throw new Error('Standing agent roles and folders must be unique.');

export function standingAgent(role:string){return STANDING_AGENTS.find(agent=>agent.role===role)??null;}

export function standingAgentProject(workspaceRoot:string,role:string) {
  const agent=standingAgent(role);
  if(!agent)return null;
  // sessionProject is the same registered-folder gate used by sessions ask --project.
  const project=sessionProject(workspaceRoot,agent.project,{inside:true})
    ?? sessionProject(workspaceRoot,agent.project.split('/').at(-1)!,{inside:true});
  return project&&relative(realpathSync(workspaceRoot),project.cwd)===agent.project?project:null;
}

export function standingAgentForCwd(workspaceRoot:string,cwd:string|null|undefined) {
  if(!cwd)return null;
  const folder=relative(workspaceRoot,cwd);
  return STANDING_AGENTS.find(agent=>agent.project===folder)??null;
}

export function standingAgentForSession(workspaceRoot:string,session:SessionRow) {
  const meta=sessionMetadata(session);
  if(!meta.standingRole)return null;
  if(typeof meta.providerRunner==='string'&&meta.providerRunner.trim()) {
    const agent=standingAgent(meta.standingRole);
    return agent&&meta.projectName===basename(agent.project)&&(!meta.projectPath||meta.projectPath==='')?agent.role:null;
  }
  return standingAgentForCwd(workspaceRoot,meta.cwd)?.role===meta.standingRole?meta.standingRole:null;
}

export function assertStandingAgentFolder(workspaceRoot:string,role:string,cwd:string|null|undefined) {
  const project=standingAgentProject(workspaceRoot,role);
  if(!project||cwd!==project.cwd)throw new Error(`The ${role} binding requires a session in its declared agent folder.`);
}

export function assertStandingAgentPlacement(workspaceRoot:string,role:string,meta:ReturnType<typeof sessionMetadata>) {
  const agent=standingAgent(role);
  if(!agent)throw new Error(`Unknown standing agent role ${role}; use sessions agents.`);
  if(typeof meta.providerRunner==='string'&&meta.providerRunner.trim()) {
    if(meta.projectName!==basename(agent.project)||meta.projectPath&&meta.projectPath!=='')
      throw new Error(`The ${role} binding requires its declared project on its bound runner.`);
    return;
  }
  assertStandingAgentFolder(workspaceRoot,role,meta.cwd);
}

export function assertStandingAgentSession(workspaceRoot:string,role:string,session:SessionRow) {
  assertStandingAgentPlacement(workspaceRoot,role,sessionMetadata(session));
}

/** The target and every former holder change in one owner transaction. */
export function bindStandingAgentSession(workspaceRoot:string,role:string,session:SessionRow) {
  db.transaction(()=>{
    const agent=standingAgent(role);
    if(!agent)throw new Error(`Unknown standing agent role ${role}; use sessions agents.`);
    if(session.status==='archived')throw new Error('An archived session cannot hold a standing agent role.');
    assertStandingAgentSession(workspaceRoot,agent.role,session);
    db.query(`UPDATE sessions SET native_metadata_json=json_remove(native_metadata_json,'$.standingRole')
      WHERE id<>? AND json_extract(native_metadata_json,'$.standingRole')=?`).run(session.id,agent.role);
    updateSessionMetadata(session.id,{standingRole:agent.role});
  })();
}

export function canOwnStandingWork(workspaceRoot:string,cwd:string|null|undefined):boolean {
  if(!cwd)return false;
  let root:string,actual:string;
  try {root=realpathSync(workspaceRoot);actual=realpathSync(cwd);} catch {return false;}
  return !!containingProject(root,actual);
}

export const STANDING_WORK_REFUSAL =
  'New repeating schedules and renewing watches need a registered project folder. '
  + 'Ask the workspace organizer to place a new project before creating one.';

export function standingAgentSession(workspaceRoot:string,role:string):SessionRow|null {
  const agent=standingAgent(role);
  if(!agent)return null;
  const bound=db.query(`SELECT * FROM sessions WHERE status!='archived'
    AND json_extract(native_metadata_json,'$.standingRole')=? ORDER BY id DESC`).all(role) as SessionRow[];
  const remote=bound.find(row=>{
    const meta=sessionMetadata(row);
    return typeof meta.providerRunner==='string'&&!!meta.providerRunner.trim()
      &&meta.projectName===basename(agent.project)&&(!meta.projectPath||meta.projectPath==='');
  });
  if(remote)return remote;
  const project=standingAgentProject(workspaceRoot,role);
  return project?db.query(`SELECT * FROM sessions WHERE status!='archived'
    AND json_extract(native_metadata_json,'$.cwd')=?
    AND json_extract(native_metadata_json,'$.standingRole')=?
    ORDER BY id DESC LIMIT 1`).get(project.cwd,role) as SessionRow|null:null;
}

function hasStandingAgentBinding(role:string):boolean {
  return !!db.query(`SELECT 1 FROM sessions WHERE json_extract(native_metadata_json,'$.standingRole')=? LIMIT 1`).get(role);
}

export function unboundJournalKeeperSession(workspaceRoot:string):SessionRow|null {
  // 2026-10-29: concierge:4571 is the known keeper until sessions agents bind journal-keeper has run.
  if(hasStandingAgentBinding('journal-keeper'))return null;
  const session=getSessionById(4571);
  if(session&&session.status!=='archived'){
    const meta=sessionMetadata(session),agent=standingAgent('journal-keeper');
    if(typeof meta.providerRunner==='string'&&meta.providerRunner.trim()
      &&meta.projectName===basename(agent!.project)&&(!meta.projectPath||meta.projectPath===''))return session;
  }
  const project=standingAgentProject(workspaceRoot,'journal-keeper');
  if(!project||!session||session.status==='archived')return null;
  return sessionMetadata(session).cwd===project.cwd?session:null;
}

export function unboundRepairAgentSession(workspaceRoot:string):SessionRow|null {
  // 2026-10-29: exact-title repair delivery ends once sessions agents bind concierge-repair has run.
  if(hasStandingAgentBinding('concierge-repair'))return null;
  const agent=standingAgent('concierge-repair');
  const remote=db.query(`SELECT * FROM sessions WHERE status!='archived'
    AND json_extract(native_metadata_json,'$.title')=? ORDER BY id DESC`).all(REPAIR_AGENT_TITLE) as SessionRow[];
  const runnerSession=remote.find(session=>{
    const meta=sessionMetadata(session);
    return typeof meta.providerRunner==='string'&&!!meta.providerRunner.trim()
      &&meta.projectName===basename(agent!.project)&&(!meta.projectPath||meta.projectPath==='');
  });
  if(runnerSession)return runnerSession;
  const project=standingAgentProject(workspaceRoot,'concierge-repair');
  return project?db.query(`SELECT * FROM sessions WHERE status!='archived'
    AND json_extract(native_metadata_json,'$.cwd')=?
    AND json_extract(native_metadata_json,'$.title')=?
    ORDER BY id DESC LIMIT 1`).get(project.cwd,REPAIR_AGENT_TITLE) as SessionRow|null:null;
}

export function standingAgentRows(workspaceRoot:string) {
  return STANDING_AGENTS.map(agent=>{
    const row=standingAgentSession(workspaceRoot,agent.role);
    return {...agent,session:row?{id:`concierge:${row.id}`,address:sessionAddress(row)}:null,
      binding:row?'bound':'unbound'};
  });
}
