import {resolve} from 'node:path';

// Source-only acceptance. Each child owns disposable state and never selects a
// real native socket/provider. Keep this gate bounded to the custody boundaries.
const fixtures=['codex-gateway-mutation-transport-fixture.ts','codex-mutation-fence-fixture.ts','codex-recovery-dispatch-authorization-fixture.ts',
  'codex-accepted-binding-recovery-fixture.ts','codex-managed-launch-fixture.ts',
  'codex-mutation-owner-policy-fixture.ts','codex-daemon-lifecycle-fixture.ts',
  'codex-managed-native-terminal-fixture.ts','provider-activation-lifecycle-fixture.ts','codex-runner-relay-lifecycle-fixture.ts',
  'codex-managed-hook-config-fixture.ts','codex-managed-hook-install-fixture.ts',
  'codex-cold-construction-fixture.ts','codex-recovery-cold-dispatch-fixture.ts',
  'codex-mutation-release-compatibility-fixture.ts',
  'codex-session-control-fence-fixture.ts','codex-original-history-coverage-fixture.ts',
  'codex-original-history-worker-fixture.ts'];
const started=performance.now();
let activeFixture='starting',activeChild:ReturnType<typeof Bun.spawn>|null=null;
// The requested release-check budget is two minutes, including a stuck child or inherited pipe.
const deadline=setTimeout(()=>{
  process.stderr.write(`codex-continuation-contract-check: budget exceeded in ${activeFixture}\n`);
  activeChild?.kill('SIGKILL');process.exit(1);
},120_000);
for(const fixture of fixtures){
  activeFixture=fixture;
  console.log(`codex-continuation-contract-check: running ${fixture}`);
  const child=Bun.spawn([process.execPath,resolve(import.meta.dir,fixture)],{
    cwd:resolve(import.meta.dir,'..'),env:process.env,stdout:'pipe',stderr:'pipe'});
  activeChild=child;
  const [stdout,stderr,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  if(status!==0){process.stderr.write(`${fixture}: exit ${status}\n${stdout}${stderr}`);process.exit(status||1);}
}
clearTimeout(deadline);
console.log(`codex-continuation-contract-check: PASS (${fixtures.length} isolated custody fixtures; ${Math.round(performance.now()-started)}ms; no live activation)`);
