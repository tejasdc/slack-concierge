#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { parseRouterSearchArgs, RouterSearchError, routerSearchStats, searchRouterThreads } from "../src/router-search";

export function runRouterThreads(argv: string[]) {
  const [verb, ...args] = argv;
  const request = verb === "search" ? parseRouterSearchArgs(args) : null;
  if (!request && (verb !== "stats" || args.length)) {
    throw new RouterSearchError("invalid_search", "usage: router-actions.sh threads <search <channel> --before-ts <message-ts> [--exclude-root-ts <root>] [--limit <1..10>] -- <concept...>|stats>", 2);
  }
  const database = new Database(process.env.CONCIERGE_STATE_DB || "/root/.local/state/concierge/state.db", { readonly: true, create: false });
  try {
    database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
    return request ? searchRouterThreads(database, request) : routerSearchStats(database);
  } finally { database.close(); }
}

if (import.meta.main) {
  try { console.log(JSON.stringify(runRouterThreads(process.argv.slice(2)))); }
  catch (error) {
    const known = error instanceof RouterSearchError;
    console.error(JSON.stringify({ ok: false, complete: false,
      code: known ? error.code : "search_unavailable",
      error: known ? error.message : "Search database/index unavailable; clarify the resume target" }));
    process.exit(known ? error.exitCode : 1);
  }
}
