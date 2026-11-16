/** File-only fence: release activation never scans live SQLite caches. */
import {createHash} from "node:crypto";
import {existsSync,lstatSync,readFileSync,readdirSync} from "node:fs";
import {join} from "node:path";
import {isDeepStrictEqual} from "node:util";
import FORMAT from "./provider-history-cache-format.json";

export const HISTORY_CACHE_READER_FORMAT = FORMAT;
export const HISTORY_CACHE_CAPABILITY_PATH = "control/history-cache-format.json";
export const HISTORY_CACHE_CONTROL_CAPABILITY_PATH = "control/history-cache-control-format.json";
export function historyCacheRequirements(state: string) {
  return join(state,"history-cache-maintenance","required-readers");
}
export function assertHistoryCacheReader(artifact: string, files: Record<string,string>,control=false) {
  const capability=control?HISTORY_CACHE_CONTROL_CAPABILITY_PATH:HISTORY_CACHE_CAPABILITY_PATH;
  const path=join(artifact,capability);
  if(!files[capability] || !existsSync(path))throw new Error("HISTORY_CACHE_READER_NOT_PROVEN");
  const info=lstatSync(path);
  if(!info.isFile() || info.isSymbolicLink())throw new Error("HISTORY_CACHE_READER_NOT_PROVEN");
  const bytes=readFileSync(path);
  if(createHash("sha256").update(bytes).digest("hex")!==files[capability]
    || !isDeepStrictEqual(JSON.parse(bytes.toString("utf8")),FORMAT))throw new Error("HISTORY_CACHE_READER_NOT_PROVEN");
}
export function assertHistoryCacheActivation(state: string, artifact: string, files: Record<string,string>,control=false) {
  const requirements=historyCacheRequirements(state);
  let info;
  try {info=lstatSync(requirements);} catch(error) {
    if((error as NodeJS.ErrnoException).code==="ENOENT")return;
    throw error;
  }
  if(!info.isDirectory() || info.isSymbolicLink())throw new Error("HISTORY_CACHE_REQUIREMENT_INVALID");
  if(readdirSync(requirements).length)assertHistoryCacheReader(artifact,files,control);
}
