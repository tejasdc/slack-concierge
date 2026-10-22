/**
 * The producers that may hand a capture to the native Inbox, as one closed list. Validation,
 * capture state and both attribution readers derive from it, so a new door (Alexa, 2026-10-18)
 * is added here once rather than in five places that can disagree. Dependency-free on purpose:
 * the capture ingress executable and the read workers import it without the ledger.
 */
export const INBOX_PRODUCER_KINDS=['pebble','thinkering','monologue','alexa','outside-agent'] as const;
export type InboxProducerKind=typeof INBOX_PRODUCER_KINDS[number];

export const isInboxProducerKind=(kind:unknown):kind is InboxProducerKind=>
  typeof kind==='string'&&(INBOX_PRODUCER_KINDS as readonly string[]).includes(kind);

/** Doors whose name is fixed by the producer alone; retained retired captures keep their old door. */
export const FIXED_PRODUCER_DOORS:Readonly<Record<string,string>>={
  monologue:'Monologue',
  alexa:'Alexa',
  'home-assistant':'Home Assistant',
};
