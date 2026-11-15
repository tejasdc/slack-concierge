/** Durable application/controller reader requirement for retained Codex custody successors. */
import {createHash} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,mkdirSync,openSync,readFileSync,writeFileSync,lstatSync,readdirSync,renameSync,unlinkSync,readlinkSync,realpathSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import APPLICATION from './codex-custody-format.json';
import CONTROLLER from './codex-custody-control-format.json';

export const CUSTODY_APPLICATION_CAPABILITY_PATH='control/codex-custody-format.json';
export const CUSTODY_CONTROL_CAPABILITY_PATH='control/codex-custody-control-format.json';
export interface CustodyApplicationProvenance {
  format:1;
  applicationSourceTreeDigest:string;
  applicationCapabilityDigest:string;
}
export interface CustodyReaderActivationProvenance {
  applicationCommit:string;
  controlCommit:string;
  applicationSourceTreeDigest:string;
  custodyApplicationProvenance?:unknown;
}
const requirementRoot=(state:string)=>join(state,'codex-custody-successors','required-readers');

/** Call before passive successor staging. Once published, never clear automatically: retained
 * successors and future turns still depend on this owner interpretation. */
export function requireCustodyReader(state:string,releaseRoot:string) {
  // This synchronous check and the durable marker write run in the serving owner's event loop.
  // Release pointer publication is routed through that same loop, with no await between its
  // compatibility check and rename. Whichever operation enters first therefore determines the
  // only safe outcome: an old controller publishes first and this call refuses, or this marker
  // publishes first and old-controller activation refuses.
  assertInstalledCustodyController(releaseRoot);
  const directory=requirementRoot(state);
  mkdirSync(directory,{recursive:true,mode:0o700});
  const stateFd=openSync(state,'r');try{fsyncSync(stateFd);}finally{closeSync(stateFd);}
  const custodyRoot=openSync(join(state,'codex-custody-successors'),'r');try{fsyncSync(custodyRoot);}finally{closeSync(custodyRoot);}
  const requirementFd=openSync(directory,'r');try{fsyncSync(requirementFd);}finally{closeSync(requirementFd);}
  const marker=join(directory,'successor-custody-v1.json');
  if(!existsSync(marker)){
    const temporary=`${marker}.${process.pid}.${Date.now()}.tmp`;
    const fd=openSync(temporary,'wx',0o600);
    try{writeFileSync(fd,JSON.stringify({format:1,application:APPLICATION,controller:CONTROLLER})+'\n');fsyncSync(fd);}finally{closeSync(fd);}
    try{renameSync(temporary,marker);}catch(error){unlinkSync(temporary);if(!existsSync(marker))throw error;}
    const dir=openSync(directory,'r');try{fsyncSync(dir);}finally{closeSync(dir);}
  }
  const markerInfo=lstatSync(marker);
  if(!markerInfo.isFile()||markerInfo.isSymbolicLink())throw new Error('CODEX_CUSTODY_REQUIREMENT_INVALID');
  const actual=JSON.parse(readFileSync(marker,'utf8'));
  if(!isDeepStrictEqual(actual,{format:1,application:APPLICATION,controller:CONTROLLER}))
    throw new Error('CODEX_CUSTODY_REQUIREMENT_INVALID');
}

function assertCapability(artifact:string,files:Record<string,string>,control:boolean) {
  const path=control?CUSTODY_CONTROL_CAPABILITY_PATH:CUSTODY_APPLICATION_CAPABILITY_PATH;
  const expected=control?CONTROLLER:APPLICATION,absolute=join(artifact,path);
  if(!files[path]||!existsSync(absolute))throw new Error('CODEX_CUSTODY_READER_NOT_PROVEN');
  const stat=lstatSync(absolute);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('CODEX_CUSTODY_READER_NOT_PROVEN');
  const bytes=readFileSync(absolute);
  if(createHash('sha256').update(bytes).digest('hex')!==files[path]
    ||!isDeepStrictEqual(JSON.parse(bytes.toString('utf8')),expected))throw new Error('CODEX_CUSTODY_READER_NOT_PROVEN');
}

/** Runtime admission must use the independently selected, service-owned controller. The app
 * pointer can be newer while an old controller is still selected, so app metadata is not proof. */
export function assertInstalledCustodyController(releaseRoot:string):string {
  const root=realpathSync(releaseRoot),pointer=join(root,'control');
  const pointerInfo=lstatSync(pointer);
  if(!pointerInfo.isSymbolicLink())throw new Error('CODEX_CUSTODY_CONTROLLER_NOT_SELECTED');
  const selected=realpathSync(resolve(root,readlinkSync(pointer)));
  const releases=join(root,'releases');
  if(!selected.startsWith(`${releases}${sep}`))throw new Error('CODEX_CUSTODY_CONTROLLER_OUTSIDE_RELEASES');
  const manifest=JSON.parse(readFileSync(join(selected,'manifest.json'),'utf8')) as {artifact_digest?:unknown;files?:Record<string,string>;format?:unknown};
  if(manifest.format!==2||typeof manifest.artifact_digest!=='string'||!manifest.files
    ||selected!==join(releases,manifest.artifact_digest))throw new Error('CODEX_CUSTODY_CONTROLLER_MANIFEST_INVALID');
  const {artifact_digest:_artifactDigest,...unsigned}=manifest;
  if(createHash('sha256').update(JSON.stringify(unsigned)).digest('hex')!==manifest.artifact_digest)
    throw new Error('CODEX_CUSTODY_CONTROLLER_MANIFEST_INVALID');
  assertCapability(selected,manifest.files,true);
  return selected;
}

export function assertCustodyReaderActivation(state:string,artifact:string,files:Record<string,string>,control=false,persistedSuccessors=false,
  provenance?:CustodyReaderActivationProvenance) {
  const assertApplicationProvenance=()=>{
    if(!provenance||provenance.applicationCommit===provenance.controlCommit)return;
    const record=provenance.custodyApplicationProvenance as Partial<CustodyApplicationProvenance>|undefined;
    if(!files[CUSTODY_APPLICATION_CAPABILITY_PATH]||record?.format!==1
      ||record.applicationSourceTreeDigest!==provenance.applicationSourceTreeDigest
      ||record.applicationCapabilityDigest!==files[CUSTODY_APPLICATION_CAPABILITY_PATH])
      throw new Error('CODEX_CUSTODY_APPLICATION_PROVENANCE_NOT_PROVEN');
  };
  // Even before any successor is staged, a hybrid release cannot advertise application
  // custody support based on bytes supplied by its independently selected controller.
  if(files[CUSTODY_APPLICATION_CAPABILITY_PATH]&&provenance&&provenance.applicationCommit!==provenance.controlCommit){
    assertCapability(artifact,files,false);
    assertApplicationProvenance();
  }
  const root=requirementRoot(state);let info;
  try{info=lstatSync(root);}catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT'){
      if(persistedSuccessors){assertCapability(artifact,files,control);if(!control)assertApplicationProvenance();}
      return;
    }
    throw error;
  }
  if(!info.isDirectory()||info.isSymbolicLink())throw new Error('CODEX_CUSTODY_REQUIREMENT_INVALID');
  if(readdirSync(root).length||persistedSuccessors){
    assertCapability(artifact,files,control);
    if(!control)assertApplicationProvenance();
  }
}
