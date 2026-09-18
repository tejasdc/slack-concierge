/**
 * How a session identity crosses between Concierge instances.
 *
 * Invariant: every instance names its own sessions `concierge:<n>` and another instance's
 * sessions `<peer>:<n>`. A local identity leaving this instance is presented as
 * `<self>:<n>`; an identity arriving that names this instance becomes `concierge:<n>`
 * again. Thinkering's federation applies the same rule between each owner and the app.
 * Without it, a cloud `concierge:3172` read on the Mac named the Mac's own session 3172,
 * and the originating human request lost its identity at the first hop.
 *
 * Read-time normalization also repairs rows retained before senders presented their
 * identities: a bare `concierge:<n>` received from a peer can only mean the sender's.
 */
const LOCAL=/^concierge:([1-9][0-9]*)$/;

export function selfPeerName():string|null {
  return process.env.CONCIERGE_PEER_NAME?.trim()||null;
}

/** Sender side: a local session identity, named by this instance for the receiver. */
export function presentSessionForPeer(id:string,self:string):string {
  const local=LOCAL.exec(id);
  return local?`${self}:${local[1]}`:id;
}

/** Receiver side: an identity from `sender`, rewritten so this instance reads it correctly. */
export function receiveSessionFromPeer(id:string,sender:string,self:string|null=selfPeerName()):string {
  const bare=LOCAL.exec(id);
  if(bare)return `${sender}:${bare[1]}`;
  if(self&&id.startsWith(`${self}:`)&&/^[1-9][0-9]*$/.test(id.slice(self.length+1)))return `concierge:${id.slice(self.length+1)}`;
  return id;
}

/** The local session number an identity names, or null when it names another instance. */
export function localSessionNumber(id:string,self:string|null=selfPeerName()):number|null {
  const local=LOCAL.exec(id);
  if(local)return Number(local[1]);
  if(self&&id.startsWith(`${self}:`)&&/^[1-9][0-9]*$/.test(id.slice(self.length+1)))return Number(id.slice(self.length+1));
  return null;
}

/**
 * The text a peer request's sender wrote, without the delivery preamble the recipient's
 * provider reads. Senders now retain it separately; for requests delivered before that,
 * the preamble is exactly the first paragraph the sender generated for this request ID.
 */
export function peerRequestMessage(text:string,requestId:string):string {
  const prefix=`Session request ${requestId} from `;
  if(!text.startsWith(prefix))return text;
  const split=text.indexOf('\n\n');
  return split<0?text:text.slice(split+2);
}
