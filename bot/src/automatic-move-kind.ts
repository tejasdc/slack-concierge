import {existsSync,readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {db,type SessionRow} from './state';
import {sessionMetadata} from './session-inputs';
import {isWritingSession,sessionSpace} from './session-roles';
import {handoffView} from './session-handoff';

/**
 * Whether the owner may move this session to another provider by itself when its allowance runs out.
 * Only coding work moves. A discussion, brainstorm, design or Lab session stays on its provider and
 * waits, because who is in the conversation is part of the work (Tejas, 2026-11-16: "if it's like a
 * regular coding section, obviously, can be moved. If it's like a discussion of [brainstorming]
 * section, I'm having ... It's not something you can automatically move"). Each part reads a fact
 * the owner already records; when none of them shows code work, the session stays, so an unknown
 * kind never moves.
 */
export type MoveKindRefusal='lab'|'conversation_project'|'chat'|'his_conversation'|'no_code_work';

export function automaticMoveRefusal(session:SessionRow):MoveKindRefusal|null {
  const meta=sessionMetadata(session);
  // The lab's committees, expertise and board discussions live in its own space.
  if(sessionSpace(session)==='lab')return 'lab';
  if(meta.purpose==='chat'||isWritingSession(session))return 'chat';
  // A brainstorm, writing or design project (project new --template) is a place for thinking.
  if(conversationProject(meta.project??meta.cwd))return 'conversation_project';
  const lineage=[session.id,...(handoffView(session.id)?.continues??[])
    .map(id=>Number(String(id).slice('concierge:'.length))).filter(Number.isSafeInteger)];
  const marks=lineage.map(()=>'?').join(',');
  // A session he writes in himself is his conversation, whatever its folder.
  if(db.query(`SELECT 1 FROM session_inputs WHERE session_id IN (${marks}) AND origin='human' AND kind IN ('input','create') LIMIT 1`)
    .get(...lineage))return 'his_conversation';
  // Coding is shown by the code edits the owner counts for each turn, here or in a session it
  // continues, or by having been started as an implementation worker.
  const coded=db.query(`SELECT 1 FROM session_owner_events event JOIN turns turn ON turn.id=event.turn_id
      WHERE event.kind='implementation_edit' AND turn.session_id IN (${marks}) LIMIT 1`).get(...lineage)
    ||db.query(`SELECT 1 FROM session_communication_requests WHERE target_session_id IN (${marks})
      AND json_extract(payload_json,'$.implementation')=1 LIMIT 1`).get(...lineage);
  return coded?null:'no_code_work';
}

const TEMPLATE_HEADING='## Project template:';
const seen=new Map<string,{mtimeMs:number;conversation:boolean}>();
/** A project made from a brainstorm, writing or design template says so in its AGENTS.md. */
function conversationProject(root:string|null|undefined):boolean {
  if(!root)return false;
  const path=join(root,'AGENTS.md');
  try{
    if(!existsSync(path))return false;
    const mtimeMs=statSync(path).mtimeMs,cached=seen.get(path);
    if(cached&&cached.mtimeMs===mtimeMs)return cached.conversation;
    const conversation=readFileSync(path,'utf8').includes(TEMPLATE_HEADING);
    seen.set(path,{mtimeMs,conversation});
    return conversation;
  }catch{return false;}
}
