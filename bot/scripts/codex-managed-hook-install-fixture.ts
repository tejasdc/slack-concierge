import assert from 'node:assert/strict';
import {Database} from 'bun:sqlite';
import {mkdtempSync,mkdirSync,existsSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {CODEX_MANAGED_HOOK_CONFIG_TEST_AUTHORIZATION} from '../src/test-authorizations';
import {initializeCodexMutationFenceSchema,acquireCodexThreadMutationFence} from '../src/codex-mutation-fence';
import {codexMutationReleaseRequirement} from '../src/codex-mutation-release-compatibility';

const scratch=mkdtempSync(join(tmpdir(),'codex-managed-hook-install-'));
const project=join(scratch,'project'),fixtureBot=join(project,'bot'),fakeScripts=join(project,'scripts');
const wrapper=resolve(import.meta.dir,'../../scripts/install-codex-stop-hook.sh');
const sourceBot=resolve(import.meta.dir,'..');
const body=join(fakeScripts,'install-codex-stop-hook-body.sh');
mkdirSync(fakeScripts,{recursive:true});symlinkSync(sourceBot,fixtureBot,'dir');
writeFileSync(body,'#!/bin/bash\nprintf "fixture-child-stdout\\n"\nprintf "fixture-child-stderr\\n" >&2\nif [ -n "${FIXTURE_CHILD_MARKER:-}" ]; then printf ran > "$FIXTURE_CHILD_MARKER"; fi\nexit "${FIXTURE_CHILD_EXIT:-0}"\n',{mode:0o755});

async function launch(name:string,exitCode:string,marker?:string){
  const state=join(scratch,name);mkdirSync(state,{recursive:true});
  const env={...process.env,CONCIERGE_STATE_DIR:state,CONCIERGE_TEST_MODE:'1',
    CONCIERGE_TEST_AUTHORIZATION:CODEX_MANAGED_HOOK_CONFIG_TEST_AUTHORIZATION,
    CONCIERGE_OWNER_SOCKET:join(scratch,'owner-unavailable.sock'),FIXTURE_CHILD_EXIT:exitCode,
    ...(marker?{FIXTURE_CHILD_MARKER:marker}:{})};
  const child=Bun.spawn(['/bin/bash',wrapper,'--bun',process.execPath,'--bot',fixtureBot,'--state',state],
    {cwd:project,env,stdout:'pipe',stderr:'pipe'});
  const [stdout,stderr,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  const databaseExists=existsSync(join(state,'state.db'));
  let rows:any[]=[];
  if(databaseExists){const db=new Database(join(state,'state.db'),{readonly:true});
    rows=db.query("SELECT intent_id,state,response_kind FROM codex_mutation_intents WHERE method='managed/codex-hook-config-install'").all() as any[];db.close();}
  return {status,stdout,stderr,rows,databaseExists,requirementExists:existsSync(codexMutationReleaseRequirement(state))};
}

try{
  const marker=join(scratch,'child-ran');
  const success=await launch('success','0',marker);
  assert.equal(success.status,75,success.stderr);assert.match(success.stderr,/FIRST_PROTECTION_WRITER_EXCLUSION_UNPROVEN/);
  assert.equal(success.stdout,'');assert.equal(existsSync(marker),false);
  assert.equal(success.databaseExists,false);assert.equal(success.requirementExists,false);assert.deepEqual(success.rows,[]);

  const failureMarker=join(scratch,'failed-child-ran');
  const failed=await launch('failed','7',failureMarker);
  assert.equal(failed.status,75);assert.match(failed.stderr,/FIRST_PROTECTION_WRITER_EXCLUSION_UNPROVEN/);
  assert.equal(failed.stdout,'');assert.equal(existsSync(failureMarker),false);
  assert.equal(failed.databaseExists,false);assert.equal(failed.requirementExists,false);assert.deepEqual(failed.rows,[]);

  const heldState=join(scratch,'held');mkdirSync(heldState);
  const heldDb=new Database(join(heldState,'state.db'));initializeCodexMutationFenceSchema(heldDb);
  assert.equal(acquireCodexThreadMutationFence(heldDb,{acceptedInputId:'held-input',runId:'held-run',dispatchAttempt:1,
    fenceId:'held-fence',threadId:'held-thread',nowMs:1}).acquired,true);heldDb.close();
  const heldMarker=join(scratch,'held-child-ran');
  const held=await launch('held','0',heldMarker);
  assert.equal(held.status,75);assert.match(held.stderr,/FIRST_PROTECTION_WRITER_EXCLUSION_UNPROVEN/);assert.equal(held.rows.length,0);
  assert.equal(held.requirementExists,false);
  assert.equal(await Bun.file(heldMarker).exists(),false,
    'unproven first protection refuses before SQLite/installer body, including with an already retained pure-domain fence');
  console.log('codex-managed-hook-install-fixture: PASS (actual wrapper read-only first-protection refusal, no new DB, requirement or child authority; pure ledger mechanics tested separately)');
}finally{rmSync(scratch,{recursive:true,force:true});}
