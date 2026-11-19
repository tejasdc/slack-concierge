import {db,getSessionById} from './state';
import {sessionMetadata} from './session-inputs';
import {sessionAddress} from './session-address';
import {thinkeringRequest} from './thinkering-capability-target';
import {awaitingOutside} from './storage-observation';
import {readTodos} from './question-todos';
import {log} from './log';
import {createHash} from 'node:crypto';

/**
 * Work an agent finds on its own waits for his accept or decline unless the agent is certain it is
 * his [decision: agent-found-work-waits-for-his-accept]. On 2026-11-19 the email reader reported
 * Apple mail about IdeaFlow's apps; the report became Inbox work, thread upkeep re-sent it when it
 * stalled, and the server signed in to App Store Connect (Apple sign-in alerts on his Watch) for
 * apps that are no longer his. Tejas: "do not create fucking work without, if you don't have 100%
 * confidence ... Add it to my like a to-do list ... so I can ... accept or decline".
 *
 * An uncertain report therefore never enters the Inbox: no capture, thread, request or router turn
 * exists, so nothing can dispatch it and thread upkeep has nothing to remind about. It is kept here
 * and offered as a candidate in his thnkr.ing To-dos (the list and daily review he already uses),
 * where Accept or Dismiss is his decision. The owner reads those to-dos on its reading cadence,
 * as it already does for questions that name a to-do: his Accept admits the retained report to the
 * Inbox exactly as a certain report would have been; his Dismiss closes it and tells the reporting
 * agent, so its own rules learn what not to propose ("learn enough to ... decide a big space on my
 * fucking responses"). The pending cap keeps one agent from flooding him ("do not ... create like
 * 500 fucking tasks for me to review").
 */
export const PENDING_PROPOSALS_PER_AGENT=3;
const MIN_CERTAIN_WHY=12;

export type ProposalRow={capture_id:string;reporter_key:string;reporter_session:string|null;title:string;capture_json:string;digest:string;
  state:'proposed'|'accepted'|'declined'|'handled'|'duplicate';todo_id:string|null;todo_error:string|null;created_at_ms:number;decided_at_ms:number|null;
  admitted_input_id:string|null;todo_closed_at_ms:number|null};

export class ProposalError extends Error {constructor(message:string,readonly status:number,readonly code:string){super(message);}}

/** Why a report is certainly his work, or null when it must wait for his accept. */
export function certainReason(metadata:Record<string,unknown>|undefined,ownerMade=false):string|null {
  // Owner-made reports (his own journal lines, a journal processing failure) and the grouped
  // leftover-process audit (its key is admitted only with its exact title) are about his own
  // system or his own words, never found work. Only in-process owner calls can claim ownerMade.
  if(ownerMade||metadata?.issueKey)return 'owner-made report';
  if(typeof metadata?.certain==='string'&&metadata.certain.trim().length>=MIN_CERTAIN_WHY)return metadata.certain.trim();
  return null;
}
export function validCertain(value:unknown):string|undefined {
  if(value===undefined)return undefined;
  if(typeof value!=='string'||value.trim().length<MIN_CERTAIN_WHY||value.length>500)
    throw new ProposalError(`--certain needs the reason this is certainly his work (${MIN_CERTAIN_WHY}-500 characters).`,400,'CERTAIN_REASON_INVALID');
  return value.trim();
}

/** The agent whose proposals are counted together: its standing role survives a provider handoff. */
export function reporterIdentity(agentSource:Record<string,unknown>|undefined,localSessionId:number|null):{key:string;session:string|null;label:string} {
  if(localSessionId!==null){
    const session=getSessionById(localSessionId);
    const metadata=session?sessionMetadata(session):null;
    const role=typeof metadata?.standingRole==='string'&&metadata.standingRole?metadata.standingRole:null;
    return {key:role?`role:${role}`:`concierge:${localSessionId}`,session:session?sessionAddress(session):null,label:metadata?.title??role??`concierge:${localSessionId}`};
  }
  const peer=String(agentSource?.peer??'peer'),id=String(agentSource?.sessionId??'?');
  return {key:`${peer}:${id}`,session:null,label:`${peer} session ${id}`};
}

export const proposalRow=(captureId:string)=>db.query('SELECT * FROM agent_proposals WHERE capture_id=?').get(captureId) as ProposalRow|null;
const decidedLately=(key:string,limit=5)=>db.query(`SELECT title,state,decided_at_ms FROM agent_proposals
  WHERE reporter_key=? AND state IN ('declined','accepted','handled') ORDER BY decided_at_ms DESC LIMIT ?`).all(key,limit) as {title:string;state:string;decided_at_ms:number}[];

/** Keep one proposal; a retry with the same bytes returns it, other bytes under the same action are refused. */
export function recordProposal(input:{captureId:string;capture:unknown;digest:string;reporter:{key:string;session:string|null};title:string}):ProposalRow {
  return db.transaction(()=>{
    const prior=proposalRow(input.captureId);
    if(prior){
      if(prior.digest!==input.digest)throw new ProposalError('Idempotency conflict: this report action already has different words.',409,'PROPOSAL_CONFLICT');
      return prior;
    }
    const waiting=db.query(`SELECT title FROM agent_proposals WHERE reporter_key=? AND state='proposed' ORDER BY created_at_ms`).all(input.reporter.key) as {title:string}[];
    if(waiting.length>=PENDING_PROPOSALS_PER_AGENT)
      throw new ProposalError(`He has not decided your ${waiting.length} earlier proposals yet (${waiting.map(row=>`"${row.title}"`).join(', ')}). Do not add more until he does: he asked not to be flooded with maybes. Keep this observation in your own notes, or report it with --certain "<why it is certainly his>" if you are sure.`,409,'PROPOSALS_WAITING');
    db.query(`INSERT INTO agent_proposals(capture_id,reporter_key,reporter_session,title,capture_json,digest,state,created_at_ms)
      VALUES(?,?,?,?,?,?,'proposed',?)`).run(input.captureId,input.reporter.key,input.reporter.session,input.title,JSON.stringify(input.capture),input.digest,Date.now());
    return proposalRow(input.captureId)!;
  }).immediate();
}

export function proposalReceipt(row:ProposalRow) {
  return {proposal:{id:row.capture_id,state:row.state,todoId:row.todo_id,
    meaning:row.state==='proposed'
      ?'Not certain, so this is a proposal, not work: it waits in his thnkr.ing To-dos for Accept or Dismiss. Nothing is dispatched and no thread is opened unless he accepts. Do not chase it. If it is in fact certainly his (a fault in his own systems such as Concierge or thnkr.ing, his own words, or his standing instruction), report it again with a new --action-id and --certain "<why>".'
      :row.state==='accepted'?'He accepted this proposal; it entered the Inbox as an agent report.'
      :row.state==='declined'?'He dismissed this proposal; no work was sent. Do not propose this kind of work again.'
      :row.state==='duplicate'?'It repeats a to-do he already has or already decided, so it was not offered again; his earlier decision stands.'
      :'He marked it done himself; no work was sent.',
    decidedBefore:decidedLately(row.reporter_key).map(item=>({title:item.title,decision:item.state}))}};
}

/** One capability call, with the reporting agent's verified pair as the actor. */
function capability(method:'GET'|'POST',path:string,body:unknown,agent:{inputId:string;runId:string},why:string):Promise<{status:number;body:any}> {
  return awaitingOutside(()=>new Promise((resolve,reject)=>{
    const payload=Buffer.from(JSON.stringify(body));
    const request=thinkeringRequest(path,{method,timeout:10_000,headers:{'x-concierge-agent-source':`${agent.inputId} ${agent.runId}`,
      'x-agent-why':encodeURIComponent(why),'content-type':'application/json','content-length':String(payload.length)}},response=>{
      const chunks:Buffer[]=[];
      response.on('data',chunk=>chunks.push(Buffer.from(chunk as Uint8Array)));
      response.once('error',reject);
      response.once('end',()=>{const text=Buffer.concat(chunks).toString('utf8');let parsed:any={};try{parsed=text?JSON.parse(text):{};}catch{parsed={raw:text.slice(0,200)};}resolve({status:response.statusCode??0,body:parsed});});
    });
    request.once('timeout',()=>request.destroy(new Error('timeout')));
    request.once('error',reject);
    request.end(payload);
  }));
}

const reportOf=(row:ProposalRow)=>JSON.parse(row.capture_json) as {source:{title:string;recordedAt:string;metadata:{agentSource:{inputId:string;runId:string}}};text:string};

/** thnkr.ing's fixed candidate id for a source (todo-candidate.ts), so a retry finds its own to-do. */
export const proposalTodoId=(captureId:string)=>`candidate-${createHash('sha256').update(`concierge-proposal\0${captureId}\0proposal`).digest('hex').slice(0,48)}`;

/** Offer each undecided proposal that has no to-do yet as a candidate in his To-dos. */
export async function offerProposals():Promise<number> {
  const rows=db.query(`SELECT * FROM agent_proposals WHERE state='proposed' AND todo_id IS NULL ORDER BY created_at_ms LIMIT 20`).all() as ProposalRow[];
  let offered=0;
  for(const row of rows){
    const report=reportOf(row),agent=report.source.metadata.agentSource;
    const at=new Date(row.created_at_ms).toISOString(),revisit=new Date(row.created_at_ms+7*86_400_000).toISOString();
    const label=`Agent proposal · ${row.reporter_key.replace(/^role:/,'')}`.slice(0,120);
    try{
      const answer=await capability('POST','/todos',{text:Array.from(row.title).slice(0,200).join(''),candidate:true,obligationId:'proposal',
        showFrom:at,dueAt:revisit,dueKind:'planning',
        source:{type:'concierge-proposal',id:row.capture_id,label,ref:row.reporter_session??'',quote:Array.from(report.text).slice(0,1000).join(''),at}},
        agent,'An agent found this work on its own and is not certain it is his; Accept sends it to the Inbox, Dismiss drops it.');
      let todoId=typeof answer.body?.task?.id==='string'?answer.body.task.id:null;
      if(answer.status>=300||!todoId){
        // A lost answer leaves the candidate made under its fixed id; a retry is then refused as a
        // duplicate of itself. Adopt it. A duplicate of a different to-do repeats something he
        // already has or decided, so it is not offered again.
        const expected=proposalTodoId(row.capture_id);
        const existing=(await readTodos()).find(todo=>todo.id===expected);
        if(existing)todoId=expected;
        else if(answer.body?.error==='TODO_CANDIDATE_DUPLICATE'){
          db.query(`UPDATE agent_proposals SET state='duplicate',decided_at_ms=?,todo_error='TODO_CANDIDATE_DUPLICATE' WHERE capture_id=? AND state='proposed'`).run(Date.now(),row.capture_id);
          log('info','agent_proposal_duplicate',{proposal:row.capture_id,reporter:row.reporter_key});
          continue;
        }
      }
      if(!todoId){
        db.query('UPDATE agent_proposals SET todo_error=? WHERE capture_id=?').run(`HTTP ${answer.status}: ${JSON.stringify(answer.body).slice(0,200)}`,row.capture_id);
        log('warn','agent_proposal_offer_refused',{proposal:row.capture_id,status:answer.status,body:JSON.stringify(answer.body).slice(0,200)});
        continue;
      }
      db.query('UPDATE agent_proposals SET todo_id=?,todo_error=NULL WHERE capture_id=? AND todo_id IS NULL').run(todoId,row.capture_id);
      offered++;
    }catch(error){
      db.query('UPDATE agent_proposals SET todo_error=? WHERE capture_id=?').run(error instanceof Error?error.message.slice(0,200):'failed',row.capture_id);
      log('warn','agent_proposal_offer_failed',{proposal:row.capture_id,reason:error instanceof Error?error.message.slice(0,80):'failed'});
    }
  }
  return offered;
}

type Admit=(input:{sessionId:number;inputId:string;origin:'service';sourceInputId:string;sourceRunId:string;requestId:string;text:string;threadReplyNotRequired:true})=>unknown;

/**
 * Carry his decisions from To-dos: Accept (open) admits the retained report to the Inbox, Dismiss
 * (dropped) declines it, and Done means he handled it himself. Runs on the owner's reading cadence
 * and only reads his to-dos while a proposal is undecided or an accepted one still shows open.
 */
export async function settleProposals(acceptReport:(captureJson:string)=>{inputId:string|null},admit?:Admit):Promise<number> {
  try{await offerProposals();}catch(error){log('warn','agent_proposal_offer_pass_failed',{reason:error instanceof Error?error.message.slice(0,80):'failed'});}
  const open=db.query(`SELECT * FROM agent_proposals WHERE todo_id IS NOT NULL AND (state='proposed' OR (state='accepted' AND todo_closed_at_ms IS NULL))
    ORDER BY created_at_ms LIMIT 200`).all() as ProposalRow[];
  if(!open.length)return 0;
  let todos:Map<string,{status:string;updatedAt:string|null}>;
  try{todos=new Map((await readTodos()).map(todo=>[todo.id,{status:todo.status,updatedAt:todo.updatedAt??null}]));}
  catch(error){log('warn','agent_proposal_todos_unavailable',{proposals:open.length,reason:error instanceof Error?error.message.slice(0,80):'failed'});return 0;}
  let settled=0;
  for(const row of open){
    const todo=todos.get(row.todo_id!);
    if(!todo)continue;
    try{
      if(row.state==='accepted'){
        // Accepted but not yet admitted (admission failed or the owner stopped in between): admit
        // again; admission is idempotent by capture, so a completed one returns the same input.
        if(!row.admitted_input_id){
          const admitted=acceptReport(row.capture_json);
          db.query('UPDATE agent_proposals SET admitted_input_id=? WHERE capture_id=?').run(admitted.inputId,row.capture_id);
          if(!admitted.inputId)continue;
        }
        if(todo.status==='open'&&todo.updatedAt)await closeAcceptedTodo(row,todo.updatedAt);
        else db.query('UPDATE agent_proposals SET todo_closed_at_ms=? WHERE capture_id=?').run(Date.now(),row.capture_id);
        continue;
      }
      if(todo.status==='candidate')continue;
      const state=todo.status==='open'?'accepted':todo.status==='done'?'handled':'declined';
      const changed=db.query(`UPDATE agent_proposals SET state=?,decided_at_ms=? WHERE capture_id=? AND state='proposed'`).run(state,Date.now(),row.capture_id).changes;
      if(!changed)continue;
      settled++;
      log('info','agent_proposal_decided',{proposal:row.capture_id,reporter:row.reporter_key,decision:state});
      if(state==='accepted'){
        const admitted=acceptReport(row.capture_json);
        db.query('UPDATE agent_proposals SET admitted_input_id=? WHERE capture_id=?').run(admitted.inputId,row.capture_id);
        if(admitted.inputId&&todo.updatedAt)await closeAcceptedTodo(row,todo.updatedAt);
      }
      else tellReporter(row,state,admit);
    }catch(error){log('error','agent_proposal_settle_failed',{proposal:row.capture_id,message:error instanceof Error?error.message:String(error)});}
  }
  return settled;
}

/** An accepted proposal is agent work now: it leaves his list as done, saying where it went. */
async function closeAcceptedTodo(row:ProposalRow,updatedAt:string) {
  const report=reportOf(row);
  const answer=await capability('POST','/todos/decision',{action:'complete',id:row.todo_id,expectedUpdatedAt:updatedAt,
    source:{kind:'agent',type:'concierge-proposal',id:row.capture_id,agent:'concierge',label:'Sent to the Inbox',ref:row.reporter_session??'/inbox',
      quote:'He accepted this proposal; it was sent to the Inbox as agent work and is tracked there.',at:new Date().toISOString()}},
    report.source.metadata.agentSource,'He accepted the proposal; the work now runs in the Inbox, so it leaves his list.');
  if(answer.status<300||answer.status===409)db.query('UPDATE agent_proposals SET todo_closed_at_ms=? WHERE capture_id=?').run(Date.now(),row.capture_id);
  else log('warn','agent_proposal_todo_close_refused',{proposal:row.capture_id,status:answer.status});
}

function tellReporter(row:ProposalRow,state:'declined'|'handled',admit?:Admit) {
  // A Mac reporter is not reachable from here by number; its decision still shows in report proposals.
  const local=/^concierge:(\d+)$/.exec(row.reporter_key)?.[1];
  const sessionId=local?Number(local):row.reporter_key.startsWith('role:')?roleSession(row.reporter_key.slice(5)):null;
  if(!admit||!sessionId)return;
  const id=`proposal-decision:${row.capture_id}`;
  if(db.query('SELECT 1 FROM session_inputs WHERE id=?').get(id))return;
  admit({sessionId,inputId:id,origin:'service',sourceInputId:id,sourceRunId:id,requestId:id,threadReplyNotRequired:true,
    text:state==='declined'
      ?`Tejas dismissed your proposal "${row.title}" in his To-dos. No work was sent. Learn from it: change your own rules or notes so you do not propose this kind of work again, and only propose when there is real doubt [decision: agent-found-work-waits-for-his-accept]. You do not need to reply to this.`
      :`Tejas marked your proposal "${row.title}" done himself. No work was sent. You do not need to reply to this.`});
}

function roleSession(role:string):number|null {
  const row=db.query(`SELECT id FROM sessions WHERE json_extract(native_metadata_json,'$.standingRole')=? ORDER BY id DESC LIMIT 1`).get(role) as {id:number}|null;
  return row?.id??null;
}

/** How often agents propose, how he answers, and how many reports claimed certainty, per agent. */
export function proposalStats(days:number) {
  const since=Date.now()-days*86_400_000;
  const byAgent=db.query(`SELECT reporter_key AS agent,count(*) AS proposed,
      sum(state='accepted') AS accepted,sum(state='declined') AS declined,sum(state='handled') AS handled,sum(state='duplicate') AS duplicate,sum(state='proposed') AS waiting
    FROM agent_proposals WHERE created_at_ms>=? GROUP BY reporter_key ORDER BY proposed DESC`).all(since);
  const certain=db.query(`SELECT count(*) AS count FROM session_inputs WHERE scope='capture:agent-report'
      AND json_extract(payload_json,'$.capture.source.metadata.certain') IS NOT NULL AND created_at>=datetime(?/1000,'unixepoch')`).get(since) as {count:number};
  const recent=db.query(`SELECT capture_id AS id,reporter_key AS agent,title,state,todo_id AS todoId,todo_error AS todoError,
      created_at_ms AS createdAtMs,decided_at_ms AS decidedAtMs FROM agent_proposals WHERE created_at_ms>=? ORDER BY created_at_ms DESC LIMIT 50`).all(since);
  return {days,byAgent,certainReports:certain.count,recent};
}
