/**
 * The lab's board, as a client of its record in thnkr.ing (docs/plans/2026-10-08-lab-space.md; the route
 * contract is thinkering docs/plans/2026-10-08-lab-record.md#the-route-contract). Threads, entries,
 * findings, decisions, skills, citations and typed links live in Thinkering's object store, in a lab
 * journal that never reaches his everyday views [decision: lab-knowledge-lives-in-the-thinkering-object-store].
 * Concierge keeps two jobs: it proves who is writing (the route asks this owner which session holds the
 * run named in X-Concierge-Agent-Source) and it delivers the `notify` list each write returns, so a
 * mentioned session is woken once with a notice that owes no reply.
 */
import {readFileSync} from 'node:fs';
import {resolveSessionAddress} from './session-owner';
import {peerSessionView} from './session-topics';
import {log} from './log';

export class BoardError extends Error {}
export type BoardVerb='read'|'thread'|'post'|'claim'|'reveal'|'close'|'product'|'cite'|'link'|'status'|'sweep';
export type BoardInput={
  verb:BoardVerb; board?:string; thread?:string; reply_to?:string; action_id?:string; kind?:string; title?:string; text?:string;
  members?:string[]; decider?:string; mentions?:string[]; sealed?:boolean; end?:string; outcome?:string; all?:boolean;
  /** product: finding|decision|skill; from: "<address> :: <reason>" each; supersedes: "<address> :: <reason>". */
  product?:string; from?:string[]; supersedes?:string;
  /** cite: medium git|document|paper|reader|web and the address it names. */
  medium?:string; address?:string;
  /** link: a typed relation from one lab address to another, with its reason. */
  to?:string; relation?:string; reason?:string;
};
export type BoardActor={session:number;inputId?:string;runId?:string};
export type BoardDelivery={
  /** Admit a service input to a session on this machine (idempotent on inputId). */
  admit:(input:{sessionId:number;inputId:string;origin:'service';sourceInputId:string;sourceRunId:string;requestId:string;text:string})=>unknown;
  /** Send an informational request to a session on another machine, from the writer's live run. */
  askPeer:(input:{address:string;actionId:string;text:string;sourceInputId:string;sourceRunId:string})=>Promise<unknown>;
};
type Notice={to:string;address:string;why:'mention'|'superseded'};

const ORIGIN=()=>process.env.THINKERING_ORIGIN_URL ?? 'https://thnkr.ing';
const KEY_FILE=()=>process.env.THINKERING_AGENT_TEST_KEY_FILE ?? '/root/.local/state/thinkering/agent-test-device.key';

/** Members, deciders and mentions are written as authors are, `concierge:<n>` or `<peer>:<n>`; `tejas` names him. */
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
const pair=(value:string)=>{const at=value.indexOf('::');if(at<0)throw new BoardError(`Write "<address> :: <reason>": ${value}`);return {address:value.slice(0,at).trim(),reason:value.slice(at+2).trim()};};

async function lab(method:'GET'|'POST',path:string,actor:BoardActor,body?:unknown):Promise<any> {
  let key:string;
  try {key=readFileSync(KEY_FILE(),'utf8').trim();}
  catch {throw new BoardError('The lab record lives in thnkr.ing on the server, and this machine has no key for it. Run the board command from a session on the server.');}
  const response=await fetch(`${ORIGIN()}/api/lab${path}`,{method,signal:AbortSignal.timeout(20_000),
    headers:{authorization:`Bearer ${key}`,'x-concierge-agent-source':`${actor.inputId} ${actor.runId}`,...(body?{'content-type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{})});
  const answer=await response.json().catch(()=>({}));
  if(!response.ok)throw new BoardError(`${answer.code??response.status}: ${answer.reason??answer.error??answer.message??'the lab record refused this'}`);
  return answer;
}

function noticeText(notice:Notice,writer:string,summary:string) {
  const open=`${ORIGIN()}/lab`;
  return [`Lab ${notice.why==='mention'?'mention':'record replaced'} from ${writer}: ${summary}`,'',
    `Read it: router-actions.sh sessions board read --address ${notice.address} <source-flags> (or ${open}).`,
    notice.why==='mention'&&notice.address.includes('/')
      ? `Answer in it: router-actions.sh sessions board post --thread ${notice.address.split('/')[0].replace(/^lab:/,'')} --reply-to ${notice.address} <source-flags> --action-id <stable id> -- <your words>`
      : notice.why==='mention' ? 'Read this record and continue its linked discussion if you have something to add.' : 'A record you wrote has been replaced by this one; read the reason there.',
    'This is a notice: it owes no sessions reply. Read it when your current work reaches a stopping point.'].join('\n');
}

/** Wakes each session the write names, once: a local session by admission under the notice's own id, a Mac session by an informational request. */
async function deliver(notify:Notice[],actor:BoardActor,writer:string,summary:string,delivery:BoardDelivery) {
  const results:{to:string;delivered:boolean;detail?:string}[]=[];
  for(const [index,notice] of notify.entries()) {
    if(notice.to==='tejas'||notice.to===`concierge:${actor.session}`)continue;
    const inputId=`lab:${notice.address}:${notice.why}:${notice.to}`;
    try {
      if(!actor.inputId||!actor.runId)throw new BoardError('The write has no live run to deliver from.');
      const local=/^concierge:(\d+)$/.exec(notice.to);
      if(local)delivery.admit({sessionId:Number(local[1]),inputId,origin:'service',sourceInputId:actor.inputId,sourceRunId:actor.runId,requestId:inputId,text:noticeText(notice,writer,summary)});
      else {
        const address=peerSessionView(notice.to)?.address;
        if(!address)throw new BoardError(`No session ${notice.to} in the peer catalogue.`);
        await delivery.askPeer({address,actionId:`lab-${index}-${notice.address.replace(/[^A-Za-z0-9_-]/g,'-')}`.slice(0,120),text:noticeText(notice,writer,summary),sourceInputId:actor.inputId,sourceRunId:actor.runId});
      }
      results.push({to:notice.to,delivered:true});
    } catch(error) {
      const detail=error instanceof Error?error.message:String(error);
      log('warn','lab_notice_undelivered',{to:notice.to,address:notice.address,detail});
      results.push({to:notice.to,delivered:false,detail});
    }
  }
  return results;
}

/** One board command from an admitted live run. */
export async function boardCommand(input:BoardInput,actor:BoardActor|null,delivery:BoardDelivery) {
  if(input.verb==='status'||input.verb==='sweep')
    return {moved:'The board is the lab record in thnkr.ing now; every mention is delivered when it is written, so there is nothing to sweep. Read it at /lab.'};
  if(!actor?.inputId||!actor.runId)throw new BoardError('Board commands come from an admitted live run: pass --source-input and --source-run.');
  if(input.verb==='read') {
    if(input.address)return lab('GET',`/resolve?address=${encodeURIComponent(input.address)}`,actor);
    if(input.thread)return lab('GET',`/records/${encodeURIComponent(input.thread)}`,actor);
    return lab('GET','',actor);
  }
  if(!input.action_id?.trim())throw new BoardError('Changing the board needs a stable --action-id.');
  if(input.reply_to&&input.verb!=='post')throw new BoardError('--reply-to is only for board post.');
  const actionId=input.action_id.trim(),text=input.text??'';
  const mentions=input.mentions?.map(identityOf);
  let written:{id:string;address:string;duplicate:boolean;notify:Notice[]};
  if(input.verb==='thread') {
    if(!text.trim())throw new BoardError('Open a thread with its first words after --.');
    written=await lab('POST','/threads',actor,{actionId,kind:input.kind,title:input.title,text,...(input.board?{board:input.board}:{}),
      ...(input.members?.length?{members:input.members.map(identityOf)}:{}),...(input.decider?{decider:identityOf(input.decider)}:{}),...(mentions?.length?{mentions}:{})});
  } else if(input.verb==='product') {
    if(!input.from?.length)throw new BoardError('A finding, decision or skill names where it came from: --from "<lab address> :: <reason>".');
    written=await lab('POST','/products',actor,{actionId,product:input.product,title:input.title,text,from:input.from.map(pair),
      ...(input.supersedes?{supersedes:pair(input.supersedes)}:{}),...(mentions?.length?{mentions}:{})});
  } else if(input.verb==='cite') {
    written=await lab('POST','/citations',actor,{actionId,medium:input.medium,address:input.address,title:input.title,text});
  } else if(input.verb==='link') {
    written=await lab('POST','/links',actor,{actionId,from:input.address,to:input.to,relation:input.relation,reason:input.reason});
  } else {
    if(!input.thread)throw new BoardError(`board ${input.verb} needs --thread <thread handle>.`);
    if(input.verb==='post'&&!text.trim())throw new BoardError('A post needs words after --.');
    let replyToEntryId:string|undefined;
    if(input.reply_to) {
      const target=await lab('GET',`/resolve?address=${encodeURIComponent(input.reply_to)}`,actor);
      if(target.handle!==input.thread.replace(/^lab:/,'')||!target.entryId)throw new BoardError('--reply-to must name an entry in this thread.');
      replyToEntryId=target.entryId;
    }
    written=await lab('POST',`/records/${encodeURIComponent(input.thread.replace(/^lab:/,''))}/entries`,actor,{actionId,act:input.verb,text,
      ...(replyToEntryId?{replyToEntryId}:{}),
      ...(mentions?.length?{mentions}:{}),...(input.sealed?{sealed:true}:{}),...(input.end?{end:input.end}:{}),...(input.outcome?{outcome:input.outcome}:{})});
  }
  const summary=(input.title??text).trim().split('\n')[0]!.slice(0,200);
  const notified=await deliver(written.notify??[],actor,`concierge:${actor.session}`,summary,delivery);
  return {id:written.id,address:written.address,duplicate:written.duplicate,notified};
}
