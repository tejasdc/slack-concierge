import assert from 'node:assert/strict';
import {mock} from 'bun:test';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';

if(process.platform!=='linux'){console.log(JSON.stringify({fixture:'ledger-lifetime-roles',status:'not-applicable',platform:process.platform}));process.exit(0);}
// Classify the real canonical spelling without opening it. Every filesystem and
// service observation below is replaced before the policy module is imported.
const authority=await import('../src/deployment-launch-authority');
let attested=false,stopped=false,queries=0;
mock.module('../src/deployment-launch-authority',()=>({...authority,
 attestedLegacyLaunch:()=>attested,preinstallLegacyLaunch:()=>false}));
mock.module('node:fs',()=>({...fs,existsSync:()=>true,realpathSync:(path:string)=>path}));
mock.module('node:child_process',()=>({...childProcess,spawnSync:()=>{
 queries++;return{status:0,stdout:`MainPID=${stopped?0:process.pid}\nControlPID=0\nActiveState=${stopped?'inactive':'active'}`};
}}));
const policy=await import('../src/ledger-access-policy'),{ledgerAccess}=policy;
const canonical=join(homedir(),'.local/state/concierge'),packageRoot=resolve(import.meta.dir,'..');
const originalArgv=process.argv,originalOffline=process.env.CONCIERGE_RELEASE_OFFLINE;
const entry=(name:string)=>join(packageRoot,name==='index'?'src':'scripts',name+'.ts');
try{
 for(const offline of [undefined,'1']){
  if(offline===undefined)delete process.env.CONCIERGE_RELEASE_OFFLINE;else process.env.CONCIERGE_RELEASE_OFFLINE=offline;
  for(const name of authority.RELEASE_LEDGER_HELPERS){
   process.argv=[process.execPath,entry(name),name==='release-manager'?'activate':'claim'];
   attested=false;assert.equal(ledgerAccess(canonical,entry(name),false).forbidControllerLedgerOpen,true,name+' refuses an unattested direct live opener');
   attested=true;assert.equal(ledgerAccess(canonical,entry(name),false).forbidControllerLedgerOpen,false,name+' retains attested legacy FULL compatibility');
  }
 }
 attested=false;
 for(const name of ['native-read-worker','provider-history-page-worker','provider-history-sync-worker']){
  const access=ledgerAccess(canonical,entry(name),false);assert.equal(access.readonly,true,name+' is physically readonly without inherited env');assert.equal(access.schema,false);
 }
 process.argv=[process.execPath,entry('index')];assert.equal(ledgerAccess(canonical,entry('index'),false).schema,true);
 stopped=true;assert.equal(ledgerAccess(canonical,entry('migrate-deployment-repair'),false).schema,true);
 stopped=false;assert.throws(()=>ledgerAccess(canonical,entry('migrate-deployment-repair'),false),/fully stopped/);
 const refusal=ledgerAccess(canonical,entry('recover-deployment'),false);
 mock.module('../src/ledger-access-policy',()=>({...policy,ledgerAccess:()=>refusal}));
 let constructors=0;
 mock.module('bun:sqlite',()=>({Database:class{constructor(){constructors++;throw Error('Unexpected SQLite constructor');}}}));
 process.env.CONCIERGE_TEST_MODE='1';process.env.CONCIERGE_TEST_AUTHORIZATION='responsive-system-b1eed622';
 assert.ok(process.env.CONCIERGE_PRIVATE_CODE_STATE,'Use the existing private-code entrance for the opener check.');
 await assert.rejects(import('../src/state-database'),/Serving release commands cannot open the live ledger/);
 assert.equal(constructors,0,'the actual opener refuses before constructing SQLite');
 console.log(JSON.stringify({fixture:'ledger-lifetime-roles',supportedHelpers:authority.RELEASE_LEDGER_HELPERS.length,offlineEnvironmentNeverGrantsWriter:true,attestedLegacyRetained:true,nativeRolesReadonlyWithoutEnv:true,supervisedStartupRetained:true,stoppedMigrationRetained:true,controlledServiceQueries:queries,canonicalFilesOpened:0,actualOpenerConstructors:constructors}));
}finally{process.argv=originalArgv;if(originalOffline===undefined)delete process.env.CONCIERGE_RELEASE_OFFLINE;else process.env.CONCIERGE_RELEASE_OFFLINE=originalOffline;}
