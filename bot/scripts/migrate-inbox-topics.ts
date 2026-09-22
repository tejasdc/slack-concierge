#!/usr/bin/env bun
/**
 * Files every existing Inbox thread into a topic, once.
 *
 *   bun run bot/scripts/migrate-inbox-topics.ts            # migrate (no-op once done)
 *   bun run bot/scripts/migrate-inbox-topics.ts --rebuild  # replay topic events into the tables
 *   bun run bot/scripts/migrate-inbox-topics.ts --retitle  # give recovered, never-renamed topics the current migration title
 *
 * The owner runs the migration itself at startup; this entry point exists for repair. It opens
 * the state directory through the same guarded module as every other bot script, so it can
 * never fall back to a default database path.
 */
import {migrateInboxTopics,rebuildTopicProjections,retitleRecoveredTopics} from '../src/session-topics';

if(process.argv.includes('--rebuild')) {
  const rebuilt=rebuildTopicProjections();
  console.log(JSON.stringify({rebuilt},null,2));
} else if(process.argv.includes('--retitle')) {
  console.log(JSON.stringify(retitleRecoveredTopics(),null,2));
} else {
  const result=migrateInboxTopics();
  console.log(JSON.stringify(result,null,2));
}
