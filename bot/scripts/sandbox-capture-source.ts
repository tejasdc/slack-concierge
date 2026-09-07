import toml from "@iarna/toml";
import { readFileSync } from "node:fs";

export function singleClickJournalSink(path: string): string {
  const config = toml.parse(readFileSync(path, "utf8"));
  const routes = Array.isArray(config.routes) ? config.routes : [];
  const route = routes.find((value) => typeof value === "object" && value !== null
    && !Array.isArray(value) && value.id === "pebble-index");
  const triggers = route && typeof route === "object" && "trigger_destinations" in route
    && Array.isArray(route.trigger_destinations) ? route.trigger_destinations : [];
  const selected = triggers.filter((value) => typeof value === "object" && value !== null
    && !Array.isArray(value) && value.trigger === "single-click-hold");
  const entry = selected.length === 1 ? selected[0] : null;
  const destination = entry && typeof entry === "object" && "destination" in entry ? entry.destination : null;
  if (!destination || typeof destination !== "object" || Array.isArray(destination)
    || !("type" in destination) || destination.type !== "journal"
    || !("sink" in destination) || typeof destination.sink !== "string"
    || !/^[a-z0-9][a-z0-9-]*$/.test(destination.sink)) {
    throw new Error("Configured single-click capture must identify one journal sink.");
  }
  return destination.sink;
}

if (import.meta.main) process.stdout.write(singleClickJournalSink(process.argv[2] || "") + "\n");
