import type {MessageAuthor} from './provider-history';
/** Versioned service command. The caller names a source; only its owner may prove it. */
export type InboxPublication={version:1;source:{input_id:string;run_id:string};action_id:string;
  sourceOwner:string;destinationOwner:string;targetSessionId:string;thread:string;text:string};
export type PublicationProof={version:1;source:InboxPublication['source'];sourceOwner:string;session:NonNullable<MessageAuthor['session']>};
export function inboxPublication(value:unknown):InboxPublication {
  const body=value as InboxPublication;
  if(!body||typeof body!=='object'||Array.isArray(body)
    ||Object.keys(body).some(key=>!['version','source','action_id','sourceOwner','destinationOwner','targetSessionId','thread','text'].includes(key))
    ||body.version!==1||!body.source||typeof body.source!=='object'||Array.isArray(body.source)
    ||Object.keys(body.source).some(key=>!['input_id','run_id'].includes(key))
    ||![body.source.input_id,body.source.run_id,body.thread,body.text].every(word=>typeof word==='string'&&!!word.trim())
    ||typeof body.action_id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(body.action_id)
    ||![body.sourceOwner,body.destinationOwner].every(owner=>typeof owner==='string'&&/^[a-z][a-z0-9-]*$/.test(owner))
    ||typeof body.targetSessionId!=='string'||!/^concierge:[1-9][0-9]*$/.test(body.targetSessionId))
    throw new Error('An exact versioned Inbox publication is required.');
  return {version:1,source:{input_id:body.source.input_id,run_id:body.source.run_id},action_id:body.action_id,
    sourceOwner:body.sourceOwner,destinationOwner:body.destinationOwner,targetSessionId:body.targetSessionId,thread:body.thread,text:body.text};
}

/** Shared by ordinary posts and service publications: promises require assigned work. */
export const postPromisesAnswer=(text:string)=>/\b(?:i(?:'|’)ll|we(?:'|’)ll|will\b(?!\s+(?:not|never)\b)|going to)\b[^.!?\n]{0,100}\b(?:answer|reply|respond)\b|\banswers? here\b|\bwill be answered\b/i.test(text);
