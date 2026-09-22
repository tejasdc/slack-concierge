#!/usr/bin/env bun
/**
 * Times the Inbox topic reads against the state directory, so a slow Threads list is
 * measured rather than argued about.
 *
 *   CONCIERGE_STATE_DIR=/root/.local/state/concierge bun run bot/scripts/topics-read-timing.ts
 *
 * Read-only: it builds the same in-process indexes the owner builds and runs the same
 * projections. It opens the state directory through the guarded module like every bot script.
 */
import {crossTopicQuestions,listTopics} from '../src/session-topics';

const timed=<T,>(label:string,run:()=>T)=>{const started=performance.now();const value=run();console.log(JSON.stringify({read:label,ms:Math.round(performance.now()-started)}));return value;};
const first=timed('topics list open (cold indexes)',()=>listTopics({state:'open',limit:50}));
timed('topics list open (warm)',()=>listTopics({state:'open',limit:50}));
timed('topics list all',()=>listTopics({state:'all',limit:50}));
timed('topics list background',()=>listTopics({state:'background',limit:50}));
timed('questions open',()=>crossTopicQuestions('open'));
console.log(JSON.stringify({topics:first.topics.length,nextCursor:first.nextCursor,sorting:first.sorting.count}));
