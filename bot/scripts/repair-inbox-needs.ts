#!/usr/bin/env bun
/**
 * One-time repair (2026-09-21) of the Inbox's open questions filed under a returned answer
 * instead of the thread that answer belongs to. Re-keys each open need to its thread root
 * with inboxThreadRoot, then drops a need when, after it was asked, Tejas replied in that
 * thread or a later turn declared an outcome for that thread. Keeps the latest open need
 * per thread, as a declaration does. dismissedGeneration is never touched.
 *
 *   bun bot/scripts/repair-inbox-needs.ts          # dry run: prints what would change
 *   bun bot/scripts/repair-inbox-needs.ts --apply  # applies it
 */
import {manualLedgerCommand} from "../src/deployment-repair-client";
const {before,next,dropped,apply}=await manualLedgerCommand({operation:"repair-inbox-needs",apply:process.argv.includes("--apply")});
for(const entry of dropped)console.log(`DROP gen ${entry.need.generation} [${entry.root}] ${entry.why}: ${entry.need.question.slice(0,90)}`);
for(const need of next)console.log(`KEEP gen ${need.generation} [${need.inputId}]: ${need.question.slice(0,90)}`);
console.log(`${before} open before, ${next.length} after, ${dropped.length} dropped${apply?"":" (dry run)"}`);
