import {resolve} from 'node:path';

// Source-only acceptance. Each child owns disposable state and never selects a
// real native socket/provider. Keep this gate bounded to the custody boundaries.
const fixtures=['codex-mutation-fence-fixture.ts','codex-recovery-dispatch-authorization-fixture.ts',
  'codex-accepted-binding-recovery-fixture.ts','codex-managed-launch-fixture.ts',
  'codex-mutation-owner-policy-fixture.ts','codex-daemon-lifecycle-fixture.ts',
  'codex-managed-native-terminal-fixture.ts','provider-activation-lifecycle-fixture.ts','codex-runner-relay-lifecycle-fixture.ts',
  'codex-session-control-fence-fixture.ts'];
for(const fixture of fixtures){
  const child=Bun.spawn([process.execPath,resolve(import.meta.dir,fixture)],{
    cwd:resolve(import.meta.dir,'..'),env:process.env,stdout:'pipe',stderr:'pipe'});
  const [stdout,stderr,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  if(status!==0){process.stderr.write(`${fixture}: exit ${status}\n${stdout}${stderr}`);process.exit(status||1);}
}
console.log(`codex-continuation-contract-check: PASS (${fixtures.length} isolated custody fixtures; no live activation)`);
