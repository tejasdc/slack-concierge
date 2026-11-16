import assert from 'node:assert/strict';
import {mock} from 'bun:test';
import {mkdtempSync,mkdirSync,symlinkSync,linkSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {Database} from 'bun:sqlite';
import {join} from 'node:path';
import {sameLedgerFile} from '../src/ledger-access-policy';
import {sessionProjects} from '../src/session-projects';
const root=mkdtempSync('/tmp/concierge-registry-access-');
try{
 const reference=join(root,'reference.identity'),symbolic=join(root,'symbolic.identity'),hard=join(root,'hard.identity');
 writeFileSync(reference,'Synthetic file identity; this is not a database.');symlinkSync(reference,symbolic);linkSync(reference,hard);
 assert.equal(sameLedgerFile(reference,symbolic),true);assert.equal(sameLedgerFile(reference,hard),true);
 const other=join(root,'other.identity');writeFileSync(other,'Different file.');assert.equal(sameLedgerFile(reference,other),false);
 let live=true;
 mock.module('../src/ledger-access-policy',()=>({isLiveLedgerPath:()=>live}));
 const {registerAdoptedProject,replaceManagedProjectMapping}=await import('../src/project-registry');
 const input={stateDbPath:join(root,'unopened.sqlite'),projectName:'existing-project',vaultPath:'/synthetic/vault',codePath:'/synthetic/project',group:null,name:'existing-project'};
 assert.throws(()=>registerAdoptedProject(input),/Direct registry writes/);
 assert.throws(()=>replaceManagedProjectMapping({stateDbPath:reference,channelId:'historical',expected:{} as any,replacement:{} as any}),/Direct registry writes/);
 assert.equal(existsSync(input.stateDbPath),false,'live classification refuses before native database creation');
 live=false;registerAdoptedProject(input);const offline=new Database(input.stateDbPath,{readonly:true});assert.equal((offline.query('SELECT count(*) n FROM channels').get() as any).n,1);offline.close();
 const workspace=join(root,'workspace'),project=join(workspace,'existing-project');mkdirSync(join(project,'.git'),{recursive:true});writeFileSync(join(project,'AGENTS.md'),'Disposable project instructions.');
 assert.deepEqual(sessionProjects(workspace),[{name:'existing-project',cwd:project}]);
 console.log(JSON.stringify({fixture:'registry-live-access',pass:true,checks:['shared same-file predicate recognizes symbolic and hardlink aliases','different file remains distinct','live classifier refuses before native database creation','offline registry write preserved on real SQLite','existing project discoverable without channel registry'],limits:'Identity uses explicit synthetic non-database reference files; production canonical classifier is source-integrated, not probed. Only registry classification is controlled; offline SQLite is real.'}));
}finally{rmSync(root,{recursive:true,force:true});}
