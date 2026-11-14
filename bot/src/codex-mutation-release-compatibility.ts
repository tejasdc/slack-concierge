import {createHash} from 'node:crypto';
import {constants,closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,statSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join} from 'node:path';
import type {Database} from 'bun:sqlite';
import FORMAT from './codex-mutation-release-format.json';

export const CODEX_MUTATION_APPLICATION_CAPABILITY_PATH='control/codex-mutation-application-format.json';
export const CODEX_MUTATION_CONTROL_CAPABILITY_PATH='control/codex-mutation-control-format.json';
export const FIRST_PROTECTION_WRITER_EXCLUSION_UNPROVEN='FIRST_PROTECTION_WRITER_EXCLUSION_UNPROVEN';
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const bytes=JSON.stringify(FORMAT)+'\n';
export function codexMutationReleaseRequirement(stateDirectory:string){
  return join(stateDirectory,'codex-native-mutation','required-release-protocols','v1.json');
}
function regularFormat(path:string,expectedDigest?:string){
  const info=lstatSync(path);
  if(!info.isFile()||info.isSymbolicLink())throw new Error('CODEX_MUTATION_RELEASE_REQUIREMENT_INVALID');
  const contents=readFileSync(path);
  if(expectedDigest&&hash(contents)!==expectedDigest||JSON.stringify(JSON.parse(contents.toString('utf8')))!==JSON.stringify(FORMAT))
    throw new Error('CODEX_MUTATION_RELEASE_REQUIREMENT_INVALID');
}
/** File-only, monotonic compatibility state. No deletion or automatic clearing. */
export function publishCodexMutationReleaseRequirement(stateDirectory:string){
  if(!isAbsolute(stateDirectory))throw new Error('CODEX_MUTATION_RELEASE_STATE_DIRECTORY_UNPROVEN');
  const root=realpathSync(stateDirectory),first=join(root,'codex-native-mutation'),directory=join(first,'required-release-protocols');
  for(const path of [first,directory]){
    try{mkdirSync(path,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    const info=lstatSync(path);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('CODEX_MUTATION_RELEASE_REQUIREMENT_INVALID');
  }
  const path=codexMutationReleaseRequirement(root);
  let fd:number|undefined;
  try{fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o444);
    writeFileSync(fd,bytes);fsyncSync(fd);
  }catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;regularFormat(path);}
  finally{if(fd!==undefined)closeSync(fd);}
  for(const path of [directory,first,root]){const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
}
/** No current host authority establishes the first transition's old-writer cut.
 * This diagnostic deliberately has no caller-provided readiness flag. */
export function codexMutationFirstProtectionReadiness(){
  return {eligible:false as const,reason:FIRST_PROTECTION_WRITER_EXCLUSION_UNPROVEN};
}
/** Operational entry, before any protected fence/config authority is acquired.
 * A retained requirement is compatibility evidence, never writer-exclusion proof. */
export function requireCodexMutationReleaseProtection(db:Database,input:{stateDirectory?:string}={}){
  const readiness=codexMutationFirstProtectionReadiness();
  if(!readiness.eligible)throw new Error(readiness.reason);
  const main=(db.query('PRAGMA database_list').all() as {name:string;file:string}[]).find(row=>row.name==='main');
  const configured=input.stateDirectory??process.env.CONCIERGE_STATE_DIR;
  let stateDirectory=main?.file?dirname(main.file):null;
  if(configured){
    if(!isAbsolute(configured)||!main?.file)throw new Error('CODEX_MUTATION_RELEASE_STATE_DIRECTORY_UNPROVEN');
    const actual=statSync(main.file),expected=statSync(join(configured,'state.db'));
    if(actual.dev!==expected.dev||actual.ino!==expected.ino)throw new Error('CODEX_MUTATION_RELEASE_STATE_DIRECTORY_UNPROVEN');
    stateDirectory=configured;
  }
  if(!stateDirectory)throw new Error('CODEX_MUTATION_RELEASE_STATE_DIRECTORY_UNPROVEN');
  publishCodexMutationReleaseRequirement(stateDirectory);
  throw new Error(FIRST_PROTECTION_WRITER_EXCLUSION_UNPROVEN);
}
/** No SQLite opens: safe in release selection, stopped-owner rollback and startup. */
export function assertCodexMutationReleaseActivation(stateDirectory:string,artifact:string,files:Record<string,string>,control=false){
  const requirement=codexMutationReleaseRequirement(stateDirectory);
  try{lstatSync(requirement);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  regularFormat(requirement);
  const capability=control?CODEX_MUTATION_CONTROL_CAPABILITY_PATH:CODEX_MUTATION_APPLICATION_CAPABILITY_PATH;
  try{
    if(!files[capability])throw new Error('missing');
    regularFormat(join(artifact,capability),files[capability]);
  }catch{throw new Error(control?'CODEX_MUTATION_CONTROL_PROTOCOL_NOT_PROVEN':'CODEX_MUTATION_APPLICATION_PROTOCOL_NOT_PROVEN');}
}
