/**
 * The producers that may hand a capture to the native Inbox, as one closed list. Validation,
 * capture state and both attribution readers derive from it, so a new door (Alexa, 2026-10-18)
 * is added here once rather than in five places that can disagree. Dependency-free on purpose:
 * the capture ingress executable and the read workers import it without the ledger.
 */
export const INBOX_PRODUCER_KINDS=['pebble','thinkering','monologue','alexa','outside-agent','reader'] as const;
export type InboxProducerKind=typeof INBOX_PRODUCER_KINDS[number];

export const isInboxProducerKind=(kind:unknown):kind is InboxProducerKind=>
  typeof kind==='string'&&(INBOX_PRODUCER_KINDS as readonly string[]).includes(kind);

/** Doors whose name is fixed by the producer alone; retained retired captures keep their old door. */
export const FIXED_PRODUCER_DOORS:Readonly<Record<string,string>>={
  monologue:'Monologue',
  alexa:'Alexa',
  'home-assistant':'Home Assistant',
};

/**
 * Reader hands the Inbox any save its sorting agent decides is a capture rather than an article,
 * with the door the save came through as `readerOrigin`. The author follows the door: his own doors
 * (the Reader app, the Chrome extension, a share, a file he uploaded) are his, exactly as thnkr.ing
 * vouches for his iPhone share, which keeps the `thinkering` kind; an agent's save is the agent whose
 * verified run saved it, or an unnamed agent for saves kept before Reader retained the run; Readwise,
 * a watched playlist and a feed are the service, named by their source. Every Reader capture still
 * reaches the Inbox router to be filed (2026-11-02: before this every Reader handoff was recorded as
 * Tejas, so Thinkering refused all but his shares).
 */
const READER_ORIGINS={
  app:{author:'human',label:'Reader app'},
  extension:{author:'human',label:'Chrome extension'},
  share:{author:'human',label:'share'},
  file:{author:'human',label:'file upload'},
  agent:{author:'agent',label:'agent save'},
  'youtube-playlist':{author:'service',label:'YouTube playlist'},
  playlist:{author:'service',label:'playlist'},
  readwise:{author:'service',label:'Readwise'},
  feed:{author:'service',label:'feed'},
} as const satisfies Record<string,{author:'human'|'agent'|'service';label:string}>;
export type ReaderCaptureOrigin=keyof typeof READER_ORIGINS;
export const READER_CAPTURE_ORIGINS=Object.keys(READER_ORIGINS) as ReaderCaptureOrigin[];
export const READER_METADATA_KEYS=['readerOrigin','sourceLabel','link','note','readerIntake','agentSource'] as const;
/** Who a Reader capture from this door is recorded as. */
export const readerCaptureAuthor=(origin:ReaderCaptureOrigin)=>READER_ORIGINS[origin].author;

/** Why a `reader` capture's metadata is refused, or null when it is the exact contract. */
export function readerCaptureRefusal(metadata:Record<string,unknown>|undefined):string|null {
  if(!metadata)return 'A Reader capture needs its metadata.';
  const extra=Object.keys(metadata).filter(key=>!(READER_METADATA_KEYS as readonly string[]).includes(key));
  if(extra.length)return `A Reader capture does not take ${extra.join(', ')}.`;
  const origin=metadata.readerOrigin;
  if(!(READER_CAPTURE_ORIGINS as readonly unknown[]).includes(origin))return `A Reader capture names its origin: ${READER_CAPTURE_ORIGINS.join(', ')}.`;
  if(metadata.sourceLabel!==undefined&&(typeof metadata.sourceLabel!=='string'||!metadata.sourceLabel.trim()||metadata.sourceLabel.length>120))
    return 'A Reader source label is 1 to 120 characters.';
  if(typeof metadata.link!=='string'||metadata.link.length>4096||!/^https?:\/\//i.test(metadata.link)||!URL.canParse(metadata.link))
    return 'A Reader capture carries its http(s) link.';
  if(metadata.note!==undefined&&metadata.note!==null&&(typeof metadata.note!=='string'||metadata.note.length>8000))return 'A Reader note is text up to 8000 characters.';
  if(metadata.readerIntake!==undefined&&(typeof metadata.readerIntake!=='string'||!metadata.readerIntake||metadata.readerIntake.length>200))
    return 'A Reader intake ID is text up to 200 characters.';
  if(origin!=='agent'&&metadata.agentSource!==undefined)return 'Only an agent\'s Reader save may name an agent run.';
  return null;
}

/** What his Inbox shows beside a Reader capture: "Reader · Readwise", "Reader · Chrome extension". */
export function readerCaptureVia(source:{kind?:unknown;metadata?:Record<string,unknown>}|null|undefined):string|null {
  if(source?.kind!=='reader')return null;
  const origin=source.metadata?.readerOrigin as ReaderCaptureOrigin;
  const label=typeof source.metadata?.sourceLabel==='string'&&source.metadata.sourceLabel.trim()
    ?source.metadata.sourceLabel.trim():READER_ORIGINS[origin]?.label??'Reader';
  // Older agent saves were kept before Reader retained the saving run: still an agent's, named as such.
  const runUnknown=origin==='agent'&&source.metadata?.agentSource===undefined;
  return `Reader · ${label}${runUnknown?' (run not recorded)':''}`;
}

/**
 * Whose accepted Inbox captures enter the router like his own: his, an outside agent's, and a
 * Reader handoff from an agent or a service. The queue, Move next, joining a running turn and
 * restart recovery all ask this one question.
 */
export function capturesEnterRouter(origin:string,kind:unknown):boolean {
  return origin==='human'||origin==='agent'&&(kind==='outside-agent'||kind==='reader')||origin==='service'&&kind==='reader';
}
/** The same rule as SQL over `session_inputs` aliased `input`. */
export const CAPTURES_ENTER_ROUTER_SQL=`(input.origin='human'
  OR (input.origin='agent' AND json_extract(input.payload_json,'$.capture.source.kind') IN ('outside-agent','reader'))
  OR (input.origin='service' AND json_extract(input.payload_json,'$.capture.source.kind')='reader'))`;
