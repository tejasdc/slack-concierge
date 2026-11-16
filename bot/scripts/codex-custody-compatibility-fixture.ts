import assert from 'node:assert/strict';
import {copyFileSync,mkdtempSync,mkdirSync,rmSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Database} from 'bun:sqlite';
import {ledgerWriteResults} from '../src/ledger-write-results';
import {resolve} from 'node:path';
import {TrustedRootReleaseManager} from '../src/deployment-release';
import {assertCustodyReaderActivation,assertInstalledCustodyController,CUSTODY_APPLICATION_CAPABILITY_PATH,CUSTODY_CONTROL_CAPABILITY_PATH,requireCustodyReader} from '../src/codex-custody-compatibility';
import appFormat from '../src/codex-custody-format.json';
import controlFormat from '../src/codex-custody-control-format.json';

const state=mkdtempSync(join(tmpdir(),'codex-custody-compatibility-'));
const artifact=join(state,'artifact');mkdirSync(join(artifact,'control'),{recursive:true});
const sealedControl=join(state,'sealed-control');mkdirSync(sealedControl);copyFileSync(resolve(import.meta.dir,'../../scripts/ledger-read.py'),join(sealedControl,'ledger-read.py'));
copyFileSync(join(sealedControl,'ledger-read.py'),join(artifact,'control','ledger-read.py'));
const oldControl=join(state,'old-control');mkdirSync(oldControl);
const put=(path:string,value:unknown)=>writeFileSync(join(artifact,path),JSON.stringify(value));
const checksum=(path:string)=>createHash('sha256').update(JSON.stringify(path===CUSTODY_APPLICATION_CAPABILITY_PATH?appFormat:controlFormat)).digest('hex');
function installedController(name:string,capability:unknown|null){
  const root=join(state,name),releases=join(root,'releases');mkdirSync(releases,{recursive:true});
  const files:Record<string,string>={};if(capability!==null)files[CUSTODY_CONTROL_CAPABILITY_PATH]=createHash('sha256').update(JSON.stringify(capability)).digest('hex');
  const unsigned={format:2,files},artifactDigest=createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
  const artifact=join(releases,artifactDigest);mkdirSync(artifact,{recursive:true});
  if(capability!==null){mkdirSync(join(artifact,'control'),{recursive:true});writeFileSync(join(artifact,CUSTODY_CONTROL_CAPABILITY_PATH),JSON.stringify(capability));}
  writeFileSync(join(artifact,'manifest.json'),JSON.stringify({...unsigned,artifact_digest:artifactDigest}));
  symlinkSync(join('releases',artifactDigest),join(root,'control'));
  return root;
}
try{
  const selectedController=installedController('selected-controller',controlFormat);
  assert.equal(assertInstalledCustodyController(selectedController).includes('/releases/'),true,'the actual selected sealed controller advertises its exact custody capability');
  assert.throws(()=>assertInstalledCustodyController(installedController('old-controller',null)),/CODEX_CUSTODY_READER_NOT_PROVEN/,'an old controller without capability refuses runtime custody admission');
  assert.throws(()=>assertInstalledCustodyController(installedController('wrong-controller',{schema:1,successorCustody:0})),/CODEX_CUSTODY_READER_NOT_PROVEN/,'a wrong controller capability refuses runtime custody admission');
  const stateDir=join(state,'state');mkdirSync(stateDir);const database=ledgerWriteResults(new Database(join(stateDir,'state.db')));
  database.exec('CREATE TABLE codex_custody_successors(canonical_input_id TEXT PRIMARY KEY); INSERT INTO codex_custody_successors VALUES ("fixture")');database.close();
  const manager=new TrustedRootReleaseManager({repositoryRoot:resolve(import.meta.dir,'../..'),releaseRoot:join(state,'releases'),
    installRoot:join(state,'install'),bunExecutable:process.execPath,custodyStateDirectory:stateDir});
  (manager as any).controlArtifactPath=()=>oldControl;
  (manager as any).verify=()=>({files:{}});
  const candidateFiles={'control/ledger-read.py':createHash('sha256').update(await Bun.file(join(artifact,'control','ledger-read.py')).bytes()).digest('hex')};
  assert.equal((manager as any).custodyRowsExist(artifact,candidateFiles),true,'new candidate reader covers old selected controller during first activation');
  const empty=ledgerWriteResults(new Database(join(stateDir,'state.db')));empty.exec('DELETE FROM codex_custody_successors');empty.close();
  assert.equal((manager as any).custodyRowsExist(artifact,candidateFiles),false,'empty retained custody allows older artifacts');
  assert.throws(()=>(manager as any).custodyRowsExist(artifact,{}),/CODEX_CUSTODY_READ_ENTRANCE_UNAVAILABLE/,'no unsealed or missing reader fallback');
  const priorState=join(state,'prior-state');mkdirSync(priorState);
  const priorDb=ledgerWriteResults(new Database(join(priorState,'state.db')));priorDb.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY)');priorDb.close();
  const priorManager=new TrustedRootReleaseManager({repositoryRoot:resolve(import.meta.dir,'../..'),releaseRoot:join(state,'prior-releases'),
    installRoot:join(state,'prior-install'),bunExecutable:process.execPath,custodyStateDirectory:priorState});
  (priorManager as any).controlArtifactPath=()=>oldControl;(priorManager as any).verify=()=>({files:{}});
  assert.equal((priorManager as any).custodyRowsExist(artifact,candidateFiles),false,'candidate reader accepts an existing pre-feature ledger schema');
  const declaration=JSON.parse(await Bun.file(resolve(import.meta.dir,'../src/deployment-artifact-files.json')).text());
  assert.equal(declaration.controlFiles['control/ledger-read.py'],'scripts/ledger-read.py','the read-only entrance is sealed into controller artifacts');
  const freshState=join(state,'fresh-state');mkdirSync(freshState);
  const freshManager=new TrustedRootReleaseManager({repositoryRoot:resolve(import.meta.dir,'../..'),releaseRoot:join(state,'fresh-releases'),
    installRoot:join(state,'fresh-install'),bunExecutable:process.execPath,custodyStateDirectory:freshState});
  assert.equal((freshManager as any).custodyRowsExist(artifact,{}),false,'a fresh install with no database has no custody rows');
  assert.doesNotThrow(()=>assertCustodyReaderActivation(state,artifact,{}),'without successor state, older artifacts remain compatible');
  requireCustodyReader(state,selectedController);
  const marker=join(state,'codex-custody-successors','required-readers','successor-custody-v1.json');
  assert.doesNotThrow(()=>requireCustodyReader(state,selectedController),'the durable requirement is idempotent');
  assert.throws(()=>assertCustodyReaderActivation(state,artifact,{},false,true),/CODEX_CUSTODY_READER_NOT_PROVEN/,'database evidence catches a lost marker');
  assert.throws(()=>assertCustodyReaderActivation(state,artifact,{}),/CODEX_CUSTODY_READER_NOT_PROVEN/,'application rollback lacking reader is refused');
  const appFiles={[CUSTODY_APPLICATION_CAPABILITY_PATH]:checksum(CUSTODY_APPLICATION_CAPABILITY_PATH)};
  put(CUSTODY_APPLICATION_CAPABILITY_PATH,appFormat);
  assert.doesNotThrow(()=>assertCustodyReaderActivation(state,artifact,appFiles),'supported application reader passes');
  assert.throws(()=>assertCustodyReaderActivation(state,artifact,appFiles,true),/CODEX_CUSTODY_READER_NOT_PROVEN/,'full rollback also requires supported controller');
  const controlFiles={[CUSTODY_CONTROL_CAPABILITY_PATH]:checksum(CUSTODY_CONTROL_CAPABILITY_PATH)};
  put(CUSTODY_CONTROL_CAPABILITY_PATH,controlFormat);
  assert.doesNotThrow(()=>assertCustodyReaderActivation(state,artifact,controlFiles,true),'supported controller passes independently');
  writeFileSync(join(artifact,CUSTODY_APPLICATION_CAPABILITY_PATH),'{}');
  assert.throws(()=>assertCustodyReaderActivation(state,artifact,appFiles),/CODEX_CUSTODY_READER_NOT_PROVEN/,'capability bytes must match sealed manifest');
  rmSync(join(state,'codex-custody-successors'),{recursive:true,force:true});
  assert.throws(()=>assertCustodyReaderActivation(state,artifact,{},false,true),/CODEX_CUSTODY_READER_NOT_PROVEN/,'whole-directory restore loss is caught by retained database rows');
  assert.equal(marker.endsWith('successor-custody-v1.json'),true);
  console.log('codex custody compatibility fixture passed: persistent requirement; app, controller and rollback reader refusal');
}finally{rmSync(state,{recursive:true,force:true});}
