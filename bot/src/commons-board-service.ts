/**
 * The owner side of the Commons board: who an author is, delivering mentions, committing the files.
 * The store itself is plain files (commons-board.ts); this module never writes the ledger except
 * through the ordinary admission of a mention as a service input to the mentioned session.
 */
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {addEvent,BoardError,boardExists,commonsRoot,ensureBoard,listBoards,listThreads,mentions,openThread,readEvents,recordDeliveryFailure,recordReceipt,render,threadState,visibleEvents,writeStatus,type BoardEvent} from './commons-board';
import {getSessionById} from './state';
import {sessionMetadata} from './session-inputs';
import {resolveSessionAddress,sessionAddress} from './session-owner';
import {log} from './log';

export type BoardVerb='read'|'thread'|'post'|'claim'|'reveal'|'close'|'status'|'sweep';
export type BoardInput={
  verb:BoardVerb; board?:string; thread?:string; action_id?:string; kind?:string; title?:string; text?:string;
  members?:string[]; decider?:string; mentions?:string[]; sealed?:boolean; end?:string; outcome?:string; all?:boolean;
};
export type BoardActor={session:number;inputId?:string;runId?:string};
export type BoardDelivery={
  /** Admit a service input to a session on this machine (idempotent on inputId). */
  admit:(input:{sessionId:number;inputId:string;origin:'service';sourceInputId:string;sourceRunId:string;requestId:string;text:string})=>unknown;
  /** Send an informational request to a session on another machine, from the poster's live run. */
  askPeer:(input:{address:string;actionId:string;text:string;sourceInputId:string;sourceRunId:string})=>Promise<unknown>;
};

const DEFAULT_BOARD='lab';
function authorOf(actor:BoardActor) {
  const session=getSessionById(actor.session);
  if(!session)throw new BoardError('Your session is not in this machine\'s catalogue.');
  const title=sessionMetadata(session).title?.trim();
  return {author:`concierge:${session.id}`,address:sessionAddress(session),authorName:title?`${title} (concierge:${session.id})`:`concierge:${session.id}`};
}
function readerOf(actor:BoardActor|null) {return actor?`concierge:${actor.session}`:null;}
/**
 * Members and deciders are compared with authors, which are written `concierge:<n>` (or `<peer>:<n>`),
 * so every address a command names is turned into that form first; `tejas` names him.
 */
function identityOf(value:string) {
  const name=value.trim();
  if(name==='tejas'||/^[a-z][a-z0-9-]*:\d+$/.test(name))return name;
  const slash=name.indexOf('/');
  if(slash>0) {
    let tuple:unknown;
    try {tuple=JSON.parse(Buffer.from(name.slice(slash+1).replace(/^session:/,''),'base64url').toString());} catch {/* reported below */}
    if(Array.isArray(tuple)&&Number.isSafeInteger(tuple[1]))return `${name.slice(0,slash)}:${tuple[1]}`;
    throw new BoardError(`Not a session address: ${name}`);
  }
  return `concierge:${resolveSessionAddress(name).id}`;
}

function mentionText(event:BoardEvent,state:ReturnType<typeof threadState>,peer:boolean) {
  // A sealed position stays hidden until the reveal, in the notice as on the board.
  const words=event.sealed?'(A sealed position: read the thread after the round is revealed.)':event.text.length>1500?`${event.text.slice(0,1500)}…`:event.text;
  const where=`${commonsRoot()}/${event.board}/threads/${event.thread}/THREAD.md`;
  return [`Board mention from ${event.authorName} on board "${event.board}", in the ${state.kind} thread "${state.title}" (${event.thread}).`,
    '',words,'',
    ...(peer
      // The board's files live on the server; a Mac session reads them over ssh and answers this request.
      ? [`Read the thread on the server: ssh remote-box cat ${where}`,
        'Answer with sessions reply to this request; your words are not posted to the board automatically.']
      : [`Read the thread: router-actions.sh sessions board read ${event.board} --thread ${event.thread} <source-flags>`,
        `Answer in it: router-actions.sh sessions board post ${event.board} --thread ${event.thread} <source-flags> --action-id <stable id> -- <your words>`,
        'This is a notice: it owes no sessions reply. Read it when your current work reaches a stopping point.'])].join('\n');
}

/** Delivers every mention of one event that has no receipt yet. Safe to repeat: admission and receipts are keyed by the event. */
export async function deliverMentions(event:BoardEvent,delivery:BoardDelivery) {
  const state=threadState(readEvents(event.board,event.thread));
  const results:{address:string;delivered:boolean;detail?:string}[]=[];
  for(const [index,address] of (event.mentions??[]).entries()) {
    if(existsSync(join(commonsRoot(),event.board,'receipts',`${event.id}--${index}.json`))){results.push({address,delivered:true});continue;}
    try {
      if(!event.sourceInput||!event.sourceRun)throw new BoardError('The post was written without a session identity, so Concierge cannot deliver its mentions; the mentioned session will see it on its next board read.');
      const text=mentionText(event,state,address.includes('/')),inputId=`board:${event.id}:${index}`;
      // A Mac session cannot take a local admission, so it gets an informational request from the
      // poster's live run, once, at post time; after that run ends a sweep cannot resend it, and
      // status.json says so. The Mac agent answers it with a short reply or by posting.
      if(address.includes('/')) await delivery.askPeer({address,actionId:`board-${event.id}-${index}`,text,sourceInputId:event.sourceInput,sourceRunId:event.sourceRun});
      else {
        const session=resolveSessionAddress(address);
        delivery.admit({sessionId:session.id,inputId,origin:'service',sourceInputId:event.sourceInput,sourceRunId:event.sourceRun,requestId:inputId,text});
      }
      recordReceipt(event.board,event,index,{inputId});
      results.push({address,delivered:true});
    } catch(error) {
      const detail=error instanceof Error?error.message:String(error);
      log('warn','board_mention_undelivered',{board:event.board,thread:event.thread,event:event.id,address,detail});
      try {recordDeliveryFailure(event.board,event,index,detail);} catch {/* the log line above still says it */}
      results.push({address,delivered:false,detail});
    }
  }
  return results;
}

let committing:Promise<void>=Promise.resolve();
/** One commit per change, serialized in this process so a commit never races a write it is recording. */
export function commitCommons(message:string) {
  const root=commonsRoot();
  committing=committing.then(async()=>{
    if(!existsSync(join(root,'.git')))return;
    const run=async(args:string[],timeoutMs:number)=>{
      const child=Bun.spawn(['git','-C',root,...args],{stdout:'ignore',stderr:'pipe'});
      const timer=setTimeout(()=>child.kill(),timeoutMs);
      const code=await child.exited;clearTimeout(timer);
      if(code!==0)throw new Error(`git ${args[0]} exited ${code}: ${(await new Response(child.stderr).text()).slice(0,300)}`);
    };
    try {
      await run(['add','-A'],20_000);
      // The board's words are agents' discussion, not instruction files; the machine's instruction hooks do not apply here.
      await run(['-c','core.hooksPath=/dev/null','commit','-q','--allow-empty-message','-m',message],20_000).catch(error=>{if(!String(error).includes('nothing to commit')&&!String(error).includes('exited 1'))throw error;});
      // Writes only ever add files, so a push refused because the origin moved rebases cleanly once.
      await run(['push','-q'],30_000).catch(async()=>{
        await run(['pull','-q','--rebase','--autostash'],30_000);
        await run(['push','-q'],30_000);
      }).catch(error=>log('warn','board_push_failed',{detail:String(error)}));
    } catch(error) {log('warn','board_commit_failed',{detail:String(error)});}
  });
  return committing;
}

/** One board command. Reads and writes need an admitted live run; status and sweep are for a supervisor on this machine. */
export async function boardCommand(input:BoardInput,actor:BoardActor|null,delivery:BoardDelivery) {
  const board=(input.board??DEFAULT_BOARD).trim();
  if(input.verb==='status') {
    const boards=input.board?[board]:listBoards();
    return {root:commonsRoot(),boards:boards.filter(boardExists).map(name=>writeStatus(name))};
  }
  if(input.verb==='sweep') {
    const boards=input.board?[board]:listBoards();
    const swept=[];
    for(const name of boards.filter(boardExists)) {
      const pending=mentions(name).filter(mention=>!mention.delivered);
      const seen=new Set<string>();
      for(const mention of pending) {
        if(seen.has(mention.event.id))continue;seen.add(mention.event.id);
        swept.push({board:name,event:mention.event.id,results:await deliverMentions(mention.event,delivery)});
      }
      render(name);
    }
    return {swept};
  }
  if(!actor)throw new BoardError('Board commands come from an admitted live run: pass --source-input and --source-run.');
  if(input.verb==='read') {
    if(!boardExists(board))return {board,threads:[],note:`No board "${board}" yet; open a thread to create it.`};
    if(input.thread) {
      const events=readEvents(board,input.thread);
      return {board,thread:threadState(events),events:visibleEvents(events,readerOf(actor)).map(({sourceInput,sourceRun,...event})=>event),
        rawFolder:join(commonsRoot(),board,'threads',input.thread)};
    }
    return {board,threads:listThreads(board,input.all?'all':'open'),view:join(commonsRoot(),board,'BOARD.md')};
  }
  if(!input.action_id?.trim())throw new BoardError('Changing the board needs a stable --action-id.');
  const who=authorOf(actor),signed={author:who.author,authorName:who.authorName,sourceInput:actor.inputId,sourceRun:actor.runId};
  const text=input.text??'';
  let written:{event:BoardEvent;duplicate:boolean};
  if(input.verb==='thread') {
    if(!text.trim())throw new BoardError('Open a thread with its first words after --.');
    written=openThread({...signed,board,actionId:input.action_id,kind:input.kind??'',title:input.title??'',text,
      members:input.members?.map(identityOf),decider:input.decider?identityOf(input.decider):undefined,mentions:input.mentions});
  } else {
    if(!input.thread)throw new BoardError(`board ${input.verb} needs --thread <thread id>.`);
    if(input.verb==='post'&&!text.trim())throw new BoardError('A post needs words after --.');
    written=addEvent({...signed,board,thread:input.thread,actionId:input.action_id,type:input.verb,text,mentions:input.mentions,sealed:input.sealed,end:input.end,outcome:input.outcome});
  }
  ensureBoard(board);
  render(board);
  const delivered=written.event.mentions?.length?await deliverMentions(written.event,delivery):[];
  // Written after delivery, so the status a supervisor reads never lists a mention that was just delivered.
  const status=writeStatus(board);
  if(!written.duplicate)void commitCommons(`${written.event.type} ${board}/${written.event.thread} by ${who.author}`);
  return {board,thread:written.event.thread,event:written.event.id,duplicate:written.duplicate,mentions:delivered,
    state:threadState(readEvents(board,written.event.thread)),status,file:join(commonsRoot(),board,'threads',written.event.thread)};
}
