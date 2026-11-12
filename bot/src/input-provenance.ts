import type {Database} from 'bun:sqlite';
import {receiveSessionFromPeer} from './peer-identity';
import {topModel} from './model-escalation';

/**
 * The one walk from an accepted input to the human behind it. The owner's full record and the
 * presentation worker's receipt list both call it with their own database handle. On 2026-11-10
 * the receipt list still ran an older hand copy without the routed-message and forwarded-reply
 * steps, so a request delegated from his ring capture listed no human while its record named
 * the capture, and thnkr.ing's send check refused his explicit send.
 * Resolves retained delegation links only, never actor or provenance claims inside message text.
 */
export type ProvenanceInput={id:string;session_id:number;kind:string;origin:string;
  source_input_id:string|null;source_run_id:string|null;request_id:string|null;turn_id:number|null;payload_json:string};
export type HumanIdentity={inputId:string;runId:string;sessionId:string;captureId?:string};
export type InputProvenance={source:{inputId:string;runId:string;sessionId:string;peer?:string};requestId:string|null;
  effectScope:'informational'|'work'|null;originatingHuman:HumanIdentity|null;peer?:string;humanModelChoices?:string[]};
/** The owner names a turn's run on first use; a read-only projection only reads it. */
export type RunIdForTurn=(turnId:number)=>string;

const parse=(value:string|null|undefined):any=>value?JSON.parse(value):{};

export function inputProvenance(database:Database,input:ProvenanceInput,runIdForTurn:RunIdForTurn):InputProvenance|null {
  const accepted=(id:string)=>database.query('SELECT * FROM session_inputs WHERE id=?').get(id) as ProvenanceInput|null;
  const humanAuthored=(candidate:Pick<ProvenanceInput,'id'|'origin'>)=>candidate.origin==='human'
    &&!database.query('SELECT 1 FROM session_input_author_corrections WHERE input_id=?').get(candidate.id);
  /** A request a peer instance delivered here: its source lives in the peer's ledger, retained on the delivery row. */
  const peerDelivered=(candidate:ProvenanceInput)=>{
    const delivery=database.query('SELECT peer,origin_session_id,origin_input_id,origin_run_id,requested_effect,origin_provenance_json FROM session_peer_deliveries WHERE target_input_id=?').get(candidate.id) as
      {peer:string;origin_session_id:string;origin_input_id:string;origin_run_id:string;requested_effect:string;origin_provenance_json:string|null}|null;
    if(!delivery)return null;
    const retained=parse(delivery.origin_provenance_json);
    const effectScope:'informational'|'work'=retained.effectScope==='informational'||delivery.requested_effect!=='work'?'informational':'work';
    // Identities arrive named by the sender; see peer-identity.ts for the rule.
    const human=retained.originatingHuman&&typeof retained.originatingHuman.sessionId==='string'
      ?{...retained.originatingHuman,sessionId:receiveSessionFromPeer(retained.originatingHuman.sessionId,delivery.peer)}:null;
    const humanModelChoices:string[]=human&&Array.isArray(retained.humanModelChoices)
      ?retained.humanModelChoices.filter((model:unknown):model is string=>typeof model==='string'&&!!topModel(model)):[];
    return {source:{inputId:delivery.origin_input_id,runId:delivery.origin_run_id,sessionId:receiveSessionFromPeer(delivery.origin_session_id,delivery.peer),peer:delivery.peer},
      requestId:candidate.request_id,effectScope,originatingHuman:human as HumanIdentity|null,peer:delivery.peer,humanModelChoices};
  };
  const routedHuman=(candidate:ProvenanceInput):HumanIdentity|null=>{
    const routedFrom=parse(candidate.payload_json)?.routedFrom;
    if(routedFrom?.authorKind!=='human'||typeof routedFrom.messageId!=='string')return null;
    const original=accepted(routedFrom.messageId);
    if(!original||!humanAuthored(original))return null;
    const originalPayload=parse(original.payload_json);
    // A forwarded human reply can be accepted without ever owning a provider turn.
    return {inputId:original.id,runId:original.turn_id?runIdForTurn(original.turn_id):'',
      sessionId:`concierge:${original.session_id}`,...(originalPayload.capture?.id?{captureId:originalPayload.capture.id}:{})};
  };
  const forwardedHuman=(candidate:ProvenanceInput):HumanIdentity|null=>{
    // A human Inbox reply can be forwarded before it owns a provider turn. The owner-retained
    // forward request, not a missing source run or the agent-facing message, proves that edge.
    if(!candidate.source_input_id||candidate.source_run_id)return null;
    const forwarded=database.query(`SELECT request.source_input_id,request.source_session_id,request.payload_json FROM session_communication_requests request
      JOIN turns source_turn ON source_turn.id=request.source_turn_id AND source_turn.session_id=request.source_session_id
      WHERE request.target_input_id=? AND request.target_session_id=? AND request.source_input_id=?`)
      .get(candidate.id,candidate.session_id,candidate.source_input_id) as {source_input_id:string;source_session_id:number;payload_json:string}|null;
    const details=forwarded?parse(forwarded.payload_json):null;
    const source=forwarded?accepted(forwarded.source_input_id):null;
    if(!source||!humanAuthored(source)||source.session_id!==forwarded?.source_session_id
      ||details?.forwardedReply?.inboxInputId!==source.id||details?.requestedEffect!=='work')return null;
    return {inputId:source.id,runId:'',sessionId:`concierge:${source.session_id}`};
  };
  if(!input.source_input_id||!input.source_run_id){
    const delivered=peerDelivered(input);
    const original=routedHuman(input);
    if(delivered)return original?{...delivered,originatingHuman:original}:delivered;
    const identity=forwardedHuman(input);
    if(identity)return {source:identity,requestId:input.request_id,effectScope:'work',originatingHuman:identity,peer:undefined};
    return null;
  }
  const seen=new Set<string>();
  let current:ProvenanceInput|null=input;
  let source:{inputId:string;runId:string;sessionId:string}|null=null;
  let human:HumanIdentity|null=routedHuman(input);
  let effectScope:'informational'|'work'|null=null;
  while(current?.source_input_id&&current.source_run_id&&!seen.has(current.id)) {
    seen.add(current.id);
    const parent=accepted(current.source_input_id);
    const turn=parent?.turn_id?database.query('SELECT native_run_id FROM turns WHERE id=? AND session_id=?').get(parent.turn_id,parent.session_id) as {native_run_id:string|null}|null:null;
    if(!parent||turn?.native_run_id!==current.source_run_id)break;
    const identity={inputId:parent.id,runId:current.source_run_id,sessionId:`concierge:${parent.session_id}`};
    source??=identity;
    if(current.origin==='agent'&&['input','create','consultation','request'].includes(current.kind)) {
      const request=database.query(`SELECT payload_json FROM session_communication_requests WHERE request_id=?
        AND ((target_input_id=? AND target_session_id=?) OR (?='request' AND source_session_id=?))
        AND source_input_id=? AND source_turn_id=?`).get(current.request_id,current.id,current.session_id,current.kind,current.session_id,parent.id,parent.turn_id) as {payload_json:string}|null;
      const peer=request?null:current.kind==='request'?database.query('SELECT payload_json FROM session_peer_requests WHERE request_id=? AND source_session_id=? AND source_input_id=? AND source_turn_id=?')
        .get(current.request_id,current.session_id,parent.id,parent.turn_id) as {payload_json:string}|null:null;
      if(!request&&!peer)break;
      const details=parse((request??peer)!.payload_json);
      const effect=details.requestedEffect??'informational';
      effectScope=effectScope==='informational'||effect!=='work'?'informational':'work';
      // The owner may retain an earlier, still-open work input as the authority for an ask
      // made from a later informational wake. Preserve the ask's actual source identity, but
      // derive its delegated scope and human lineage from that exact work input. An
      // informational hop nearer the receiver stays informational; only an all-work chain follows a grant.
      if(effectScope==='work'&&typeof details.authorityInputId==='string'){
        const grant=accepted(details.authorityInputId);
        if(grant?.session_id===parent.session_id&&grant.id!==parent.id){
          const granted=inputProvenance(database,grant,runIdForTurn);
          if(granted?.effectScope!=='informational'){
            effectScope='work';human=granted?.originatingHuman??(humanAuthored(grant)
              ?{inputId:grant.id,runId:grant.turn_id?runIdForTurn(grant.turn_id):'',sessionId:`concierge:${grant.session_id}`}:null);
            break;
          }
        }
      }
    }
    const routedParent=routedHuman(parent);
    if(routedParent){human=routedParent;break;}
    if(humanAuthored(parent)) {
      const payload=parse(parent.payload_json);
      human??={...identity,...(payload.capture?.id?{captureId:payload.capture.id}:{})};
      break;
    }
    current=parent;
  }
  // A chain that ends at a peer-delivered input continues in the peer's ledger; its retained provenance supplies the human.
  if(!human&&current)human=forwardedHuman(current);
  const delivered=!human&&current?peerDelivered(current):null;
  if(delivered){human=delivered.originatingHuman;effectScope=effectScope==='informational'||delivered.effectScope!=='work'?'informational':'work';}
  return source?{source,requestId:input.request_id,effectScope,originatingHuman:human,...(delivered?{peer:delivered.peer,humanModelChoices:delivered.humanModelChoices}:{})}:null;
}

/** The list reads the run a turn already has; it never names one. */
export const existingRunIdFor=(database:Database):RunIdForTurn=>turnId=>
  (database.query('SELECT native_run_id FROM turns WHERE id=?').get(turnId) as {native_run_id:string|null}|null)?.native_run_id??'';
