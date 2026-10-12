import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {db,getSessionById} from './state';
import type {SessionOwner} from './session-owner';
import type {PeerClient} from './session-peers';
import {PeerError} from './session-peers';
import {log,errorFields} from './log';

/**
 * Opening a link in his browser on another machine is one small order between Concierges, not an
 * agent session. On 2026-10-11 a server agent started two Mac sessions only to run `open` on a
 * credential form, and each showed up in his session list. The order is kept in the sender's
 * ledger until the peer answers, so a sleeping Mac gets it when it wakes; the receiver keeps one
 * receipt per order, so a retry after a lost answer never opens a second tab.
 *
 * Opening goes through LaunchServices (`/usr/bin/open`), which needs no Accessibility or
 * app-control permission; nothing here clicks, types or reads the page.
 */
// A link asked for now and still undelivered a day later is stale: a day covers a laptop closed
// overnight, and anything older would appear on his screen out of context.
const EXPIRES_AFTER_MS=24*60*60_000;
// The peer answers within seconds when awake; longer means it is asleep, and the order waits.
const ATTEMPT_MS=15_000;
const TERMINAL=new Set(['opened','failed','expired']);
// Chrome is where he is signed in to thnkr.ing and his accounts, and where the Accounts sign-in
// already runs, so a form or sign-in link works there; `default` follows his macOS choice.
const BROWSERS={chrome:'Google Chrome',safari:'Safari',default:null} as const;
type Browser=keyof typeof BROWSERS;
type Outcome={state:'opened'|'failed';reason?:string};
type Row={open_id:string;peer:string;url:string;browser:string;state:string;result_json:string|null;created_at_ms:number;expires_at_ms:number;
  last_attempt_at_ms:number|null;source_session_id:number;source_input_id:string;source_run_id:string;answered_at_ms:number|null;return_input_id:string|null};
type Source={session:number;input:string;run:string};

const machineName=(peer:string)=>peer==='mac'?'his Mac':peer==='cloud'?'the server':peer;
/** Logs name the site only: a link can carry a one-time credential token. */
const site=(url:string)=>{try{return new URL(url).host;}catch{return null;}};
function validUrl(value:unknown):string {
  if(typeof value!=='string'||value.length>4096||/\s/.test(value))throw new Error('Give one http or https link without spaces.');
  let parsed:URL;try{parsed=new URL(value);}catch{throw new Error('Give one http or https link.');}
  if(parsed.protocol!=='https:'&&parsed.protocol!=='http:')throw new Error('Only http and https links can be opened.');
  return value;
}
function validBrowser(value:unknown):Browser {
  if(value===undefined)return 'chrome';
  if(typeof value!=='string'||!(value in BROWSERS))throw new Error('The browser is chrome, safari or default.');
  return value as Browser;
}

export class PeerLinks {
  private running=false;
  private again=false;
  constructor(private readonly self:string,private readonly clients:Map<string,PeerClient>,private readonly owner:()=>SessionOwner,private readonly platform=process.platform){}
  hasPending(){return !!db.query("SELECT 1 FROM peer_link_opens WHERE state='queued' OR (answered_at_ms IS NOT NULL AND return_input_id IS NULL) LIMIT 1").get();}

  /** Called from the communication coordinator with an already verified live source. */
  async open(input:{source:Source;actionId:string;peer?:unknown;url:unknown;browser?:unknown}) {
    const url=validUrl(input.url),browser=validBrowser(input.browser);
    const peer=input.peer===undefined?'mac':input.peer;
    if(typeof peer!=='string'||(peer!==this.self&&!this.clients.has(peer)))throw new Error(`Unknown machine ${String(peer)}; see sessions peers.`);
    const id=createHash('sha256').update(`link-open:${input.source.input}:${input.actionId}`).digest('hex').slice(0,32);
    const now=Date.now();
    db.query(`INSERT OR IGNORE INTO peer_link_opens(open_id,peer,url,browser,state,created_at_ms,expires_at_ms,source_session_id,source_input_id,source_run_id)
      VALUES(?,?,?,?,'queued',?,?,?,?,?)`).run(id,peer,url,browser,now,now+EXPIRES_AFTER_MS,input.source.session,input.source.input,input.source.run);
    const recorded=this.row(id)!;
    if(recorded.url!==url||recorded.peer!==peer||recorded.browser!==browser)throw new Error('This --action-id already opened a different link; use a new one.');
    log('info','peer_link_open_recorded',{open_id:id,peer,site:site(url),browser});
    if(recorded.state==='queued')await this.attempt(recorded);
    const current=this.row(id)!;
    // The command itself is the answer for anything settled now; only a later settlement returns.
    if(current.state!=='queued'&&current.answered_at_ms===null)db.query('UPDATE peer_link_opens SET answered_at_ms=?,return_input_id=? WHERE open_id=? AND return_input_id IS NULL').run(Date.now(),'answered-by-command',id);
    return this.view(current);
  }

  private row(id:string){return db.query('SELECT * FROM peer_link_opens WHERE open_id=?').get(id) as Row|null;}
  private view(row:Row) {
    const result=row.result_json?JSON.parse(row.result_json) as Outcome:null;
    const where=machineName(row.peer);
    const message=row.state==='opened'?`Opened in ${row.browser==='default'?'the default browser':BROWSERS[row.browser as Browser]} on ${where}. The page itself was not inspected.`
      :row.state==='queued'?`${where[0]!.toUpperCase()}${where.slice(1)} is not answering (asleep or offline), so the link is queued. It opens when ${where} is back, until ${new Date(row.expires_at_ms).toISOString()}; this session is told once it opens or expires. No session was started.`
      :row.state==='expired'?`${where} did not come back within a day, so the link was not opened.`
      :`It could not be opened on ${where}: ${result?.reason??'unknown reason'}.`;
    return {openId:row.open_id,machine:row.peer,state:row.state,message,...(result?{result}:{})};
  }
  private settle(row:Row,state:'opened'|'failed'|'expired',outcome?:Outcome) {
    const changed=db.query("UPDATE peer_link_opens SET state=?,result_json=? WHERE open_id=? AND state='queued'").run(state,outcome?JSON.stringify(outcome):null,row.open_id).changes;
    if(!changed)return;
    log(state==='opened'?'info':'warn','peer_link_open_settled',{open_id:row.open_id,peer:row.peer,state,reason:outcome?.reason??null});
  }
  private async attempt(row:Row) {
    if(row.peer===this.self){this.settle(row,...this.settled(await this.openHere({openId:row.open_id,url:row.url,browser:row.browser})));return;}
    const client=this.clients.get(row.peer);if(!client)return;
    db.query('UPDATE peer_link_opens SET last_attempt_at_ms=? WHERE open_id=?').run(Date.now(),row.open_id);
    try {
      const answer=await client.request<{outcome:Outcome}>('POST','/sessions/v1/peers/links',{openId:row.open_id,url:row.url,browser:row.browser},ATTEMPT_MS);
      this.settle(row,...this.settled(answer.outcome));
    } catch(error) {
      // A peer without this route needs its update; the order waits for it like for a sleeping peer.
      const reason=error instanceof PeerError&&error.status===404?'needs_update':error instanceof PeerError&&error.kind==='unreachable'?'asleep':'refused';
      if(reason==='refused')this.settle(row,'failed',{state:'failed',reason:error instanceof Error?error.message.slice(0,300):String(error)});
      else log('info','peer_link_open_waiting',{open_id:row.open_id,peer:row.peer,reason,...errorFields(error)});
    }
  }
  private settled(outcome:Outcome|undefined):['opened'|'failed',Outcome] {
    if(outcome?.state==='opened')return ['opened',{state:'opened'}];
    return ['failed',{state:'failed',reason:typeof outcome?.reason==='string'?outcome.reason.slice(0,300):'the machine gave no answer'}];
  }
  /** The asking session hears once about a link that settled after its command returned. */
  private returnResult(row:Row) {
    const source=getSessionById(row.source_session_id);if(!source)return;
    const inputId=`return:link-open:${row.open_id}`;
    try {
      this.owner().admit({sessionId:source.id,inputId,origin:'service',sourceInputId:row.source_input_id,sourceRunId:row.source_run_id,requestId:row.open_id,
        text:`The link you queued for ${machineName(row.peer)} (${site(row.url)}) ${this.view(row).message} This is a result, not a new request.`});
      db.query('UPDATE peer_link_opens SET answered_at_ms=?,return_input_id=? WHERE open_id=?').run(Date.now(),inputId,row.open_id);
    } catch(error){log('warn','peer_link_open_return_waiting',{open_id:row.open_id,...errorFields(error)});}
  }
  wake() {
    if(this.running){this.again=true;return;}
    this.running=true;
    queueMicrotask(async()=>{
      try {
        do {
          this.again=false;
          for(const row of db.query("SELECT * FROM peer_link_opens WHERE state='queued' ORDER BY created_at_ms").all() as Row[]){
            if(Date.now()>=row.expires_at_ms)this.settle(row,'expired');
            else await this.attempt(row);
          }
          for(const row of db.query("SELECT * FROM peer_link_opens WHERE state IN ('opened','failed','expired') AND return_input_id IS NULL").all() as Row[])this.returnResult(row);
        } while(this.again);
      } catch(error){log('error','peer_link_open_wake_failed',errorFields(error));}
      finally{this.running=false;}
    });
  }

  /** Receiver: the peer's order, opened at most once per order identity. */
  async receive(value:unknown):Promise<{outcome:Outcome}> {
    const data=value as Record<string,unknown>;
    if(!data||typeof data!=='object'||Object.keys(data).some(key=>!['openId','url','browser'].includes(key))||typeof data.openId!=='string'||!/^[a-f0-9]{32}$/.test(data.openId))
      throw new Error('Invalid link order.');
    const receipt=db.query('SELECT result_json FROM peer_link_receipts WHERE open_id=?').get(data.openId) as {result_json:string}|null;
    if(receipt)return {outcome:JSON.parse(receipt.result_json) as Outcome};
    let outcome:Outcome;
    try {outcome=await this.openHere({openId:data.openId,url:validUrl(data.url),browser:validBrowser(data.browser)});}
    catch(error){outcome={state:'failed',reason:error instanceof Error?error.message:String(error)};}
    db.query('INSERT OR IGNORE INTO peer_link_receipts(open_id,result_json,created_at_ms) VALUES(?,?,?)').run(data.openId,JSON.stringify(outcome),Date.now());
    return {outcome:JSON.parse((db.query('SELECT result_json FROM peer_link_receipts WHERE open_id=?').get(data.openId) as {result_json:string}).result_json) as Outcome};
  }
  private inFlight=new Map<string,Promise<Outcome>>();
  private openHere(order:{openId:string;url:string;browser:string}):Promise<Outcome> {
    const running=this.inFlight.get(order.openId);if(running)return running;
    const work=(async():Promise<Outcome>=>{
      if(this.platform!=='darwin')return {state:'failed',reason:`${this.self} has no desktop browser to open links in`};
      const app=BROWSERS[order.browser as Browser];
      try {
        await promisify(execFile)('/usr/bin/open',app?['-a',app,order.url]:[order.url],{timeout:10_000});
        log('info','peer_link_opened',{open_id:order.openId,site:site(order.url),browser:order.browser});
        return {state:'opened'};
      } catch(error) {
        const reason=String((error as {stderr?:unknown})?.stderr??'').trim().split('\n')[0]?.slice(0,300)||(error instanceof Error?error.message.slice(0,300):'open failed');
        return {state:'failed',reason};
      }
    })();
    this.inFlight.set(order.openId,work);
    void work.finally(()=>this.inFlight.delete(order.openId));
    return work;
  }
}

