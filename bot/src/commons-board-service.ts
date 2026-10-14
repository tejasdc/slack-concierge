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
import {supersededBy,supersededAddress,withdrawnSuccessor} from './session-handoff';
import {log} from './log';

export class BoardError extends Error {}
export type BoardVerb='read'|'thread'|'post'|'claim'|'reveal'|'close'|'product'|'cite'|'link'|'verdict'|'cards'|'status'|'sweep';
export type BoardInput={
  verb:BoardVerb; board?:string; thread?:string; reply_to?:string; action_id?:string; kind?:string; title?:string; text?:string;
  members?:string[]; decider?:string; mentions?:string[]; sealed?:boolean; end?:string; outcome?:string; all?:boolean;
  /** product: finding|decision|skill|design; from: "<address> :: <reason>" each; supersedes: "<address> :: <reason>". */
  product?:string; from?:string[]; supersedes?:string;
  /** post: the design section this speaks to (`lab:<design-handle>.<passage>`), what the post is (answer|ask|comment), and,
   *  when an agent places his words from an Inbox thread, speaker `tejas` with the Inbox input that holds them. */
  target?:string; intent?:string; speaker?:string; his_input?:string;
  /** The Inbox thread the work belongs to: on product design the record files one line about the publication there; on a
   *  speaker post a later answer is filed there too; on cards each card's line goes there. */
  inbox_session?:string; inbox_message?:string;
  /** verdict: his per-version verdict on a design, with its scope (free text, or none). cards: the author's section cards. */
  design?:string; verdict?:string; scope?:string;
  cards?:{section:string;claim:string;consequence:string;recommendation:string;alternative:string;question:string}[];
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
  // A refusal body can be absent or the JSON literal null; the refusal must still name the status and route.
  const answer=(await response.json().catch(()=>null))??{};
  if(!response.ok) {
    // A blocked verdict names the sections still in the way (LAB_VERDICT_BLOCKED: {sections:[{title,address,why}]}).
    const sections=Array.isArray(answer.sections)&&answer.sections.length
      ? ` Sections: ${answer.sections.map((section:{title?:string;address?:string;why?:string})=>`${section.title??section.address} (${section.address}): ${section.why}`).join('; ')}.`
      : '';
    throw new BoardError(`${answer.error??answer.code??response.status}: ${answer.reason??answer.message??`the lab record refused this (HTTP ${response.status} from ${method} /api/lab${path})`}${sections}`);
  }
  return answer;
}

/** A design section's address: the design's handle and the passage number of its `## ` heading. */
const DESIGN_PASSAGE=/^lab:[a-z0-9][a-z0-9-]*\.\d+$/;
const BARE_RECORD=/^lab:[a-z0-9][a-z0-9-]*$/;

/**
 * A design read as the review shows it (agent-ecology docs/plans/2026-10-13-codiak-participation-interfaces.md;
 * route: thinkering docs/plans/2026-10-13-living-design-review.md): the record answers with `review`, whose
 * `sections` carry each `## ` section's address, state (missing|open|asked|answered|accepted|contested), his
 * entries and the replies nested under them, so a session sees what it owes. Concierge adds only `owed`, the
 * addresses of sections still `asked`, and never computes a state of its own. Not a design: null.
 */
async function readDesign(address:string,actor:BoardActor) {
  const trimmed=address.trim();
  if(!BARE_RECORD.test(trimmed))return null;
  const record=await lab('GET',`/records/${encodeURIComponent(trimmed.slice(4))}`,actor);
  if(record.kind!=='product'||record.record?.product!=='design')return null;
  const review=record.review??null;
  const sections:{address:string;state:string}[]=review?.sections??[];
  return {kind:'design',record:record.record,supersededBy:record.supersededBy??null,links:record.links??null,review,
    owed:sections.filter(section=>section.state==='asked').map(section=>section.address),
    ...(review?{}:{note:'This thnkr.ing does not publish the section review yet; the design text and links are above.'})};
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
    if(input.address) {
      const design=await readDesign(input.address,actor);
      return design??lab('GET',`/resolve?address=${encodeURIComponent(input.address)}`,actor);
    }
    if(input.thread)return lab('GET',`/records/${encodeURIComponent(input.thread)}`,actor);
    return lab('GET','',actor);
  }
  const successor=supersededBy(actor.session);
  if(successor)throw new BoardError(`This session continues in ${successor}. Use ${supersededAddress(actor.session)} to write to the Lab.`);
  if(withdrawnSuccessor(actor.session))throw new BoardError('This proposed handoff was withdrawn; this successor cannot write to the Lab.');
  if(!input.action_id?.trim())throw new BoardError('Changing the board needs a stable --action-id.');
  if(input.reply_to&&input.verb!=='post')throw new BoardError('--reply-to is only for board post.');
  if(input.target&&input.verb!=='post')throw new BoardError('--target is only for board post.');
  if(input.target&&!DESIGN_PASSAGE.test(input.target.trim()))throw new BoardError('--target names a design section as lab:<design-handle>.<passage>.');
  if((input.intent||input.speaker||input.his_input)&&input.verb!=='post')throw new BoardError('--intent, --speaker and --his-input are only for board post.');
  if(input.speaker&&(input.speaker.trim()!=='tejas'||!input.his_input?.trim()||!input.target))throw new BoardError('Placing his words needs --speaker tejas, --his-input <the Inbox input that holds them> and --target <the section>; the agent stays the author of record.');
  const inboxAllowed=(input.verb==='product'&&input.product==='design')||(input.verb==='post'&&!!input.speaker)||input.verb==='cards';
  if((input.inbox_session||input.inbox_message)&&(!inboxAllowed||!input.inbox_session||!input.inbox_message))throw new BoardError('--inbox-session and --inbox-message go together, on board product --product design, board post --speaker tejas, or board cards.');
  const inbox=input.inbox_session?{inbox:{sessionId:identityOf(input.inbox_session),messageId:input.inbox_message!.trim()}}:{};
  const designHandle=input.design?.trim().replace(/^lab:/,'');
  const actionId=input.action_id.trim(),text=input.text??'';
  const mentions=input.mentions?.map(identityOf);
  let written:{id:string;address:string;duplicate:boolean;notify:Notice[]};
  if(input.verb==='thread') {
    if(!text.trim())throw new BoardError('Open a thread with its first words after --.');
    written=await lab('POST','/threads',actor,{actionId,kind:input.kind,title:input.title,text,...(input.board?{board:input.board}:{}),
      ...(input.members?.length?{members:input.members.map(identityOf)}:{}),...(input.decider?{decider:identityOf(input.decider)}:{}),...(mentions?.length?{mentions}:{})});
  } else if(input.verb==='product') {
    if(!input.from?.length)throw new BoardError('A finding, decision, skill or design names where it came from: --from "<lab address> :: <reason>" (a design links to the open Lab thread whose sessions answer him).');
    written=await lab('POST','/products',actor,{actionId,product:input.product,title:input.title,text,from:input.from.map(pair),
      ...(input.supersedes?{supersedes:pair(input.supersedes)}:{}),...(mentions?.length?{mentions}:{}),
      ...inbox});
  } else if(input.verb==='verdict') {
    if(!designHandle||!input.verdict)throw new BoardError('board verdict needs --design <design handle> and --verdict approve|revise|stop.');
    const scope=input.scope?.trim();
    written=await lab('POST',`/records/${encodeURIComponent(designHandle)}/verdict`,actor,{actionId,verdict:input.verdict.trim(),
      ...(scope&&scope!=='none'?{scope}:{}),...(text.trim()?{text}:{})});
  } else if(input.verb==='cards') {
    if(!designHandle||!input.cards?.length||!input.inbox_session)throw new BoardError('board cards needs --design, --inbox-session, --inbox-message and --json-file with at least one card.');
    const answer=await lab('POST',`/records/${encodeURIComponent(designHandle)}/cards`,actor,{actionId,...inbox,cards:input.cards});
    const cards:{id:string;address:string;duplicate:boolean;notify?:Notice[];inbox?:unknown}[]=answer.cards??[];
    const notified=[];
    for(const card of cards)notified.push(...await deliver(card.notify??[],actor,`concierge:${actor.session}`,`card at ${card.address}`,delivery));
    return {cards:cards.map(card=>({id:card.id,address:card.address,duplicate:card.duplicate,inbox:card.inbox??null})),notified};
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
      ...(replyToEntryId?{replyToEntryId}:{}),...(input.target?{targetAddress:input.target.trim()}:{}),...(input.intent?{intent:input.intent.trim()}:{}),
      ...(input.speaker?{speaker:'tejas',source:input.his_input!.trim(),...inbox}:{}),
      ...(mentions?.length?{mentions}:{}),...(input.sealed?{sealed:true}:{}),...(input.end?{end:input.end}:{}),...(input.outcome?{outcome:input.outcome}:{})});
  }
  const summary=(input.title??(input.verb==='verdict'?`verdict ${input.verdict} on lab:${designHandle}`:text)).trim().split('\n')[0]!.slice(0,200);
  const notified=await deliver(written.notify??[],actor,`concierge:${actor.session}`,summary,delivery);
  return {id:written.id,address:written.address,duplicate:written.duplicate,notified,...('inbox' in written?{inbox:(written as {inbox?:unknown}).inbox}:{})};
}
