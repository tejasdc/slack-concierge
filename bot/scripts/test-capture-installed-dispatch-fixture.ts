import assert from 'node:assert/strict';
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'test-capture-installed-dispatch-'));
try {
  const currentBot = join(root, 'current/control/bot');
  const pinnedBot = join(root, 'pinned-old/bot');
  mkdirSync(join(currentBot, 'scripts'), {recursive:true});
  mkdirSync(join(pinnedBot, 'scripts'), {recursive:true});
  writeFileSync(join(currentBot, 'scripts/agent-test-capture.js'), 'current release');
  writeFileSync(join(currentBot, 'scripts/router-todo.js'), 'current todo');
  writeFileSync(join(pinnedBot, 'scripts/router-sessions.js'), 'old pin determines suffix');
  writeFileSync(join(pinnedBot, 'scripts/agent-test-capture.js'), 'old pinned client');
  writeFileSync(join(pinnedBot, 'scripts/router-todo.js'), 'pinned todo');

  const wrapperSource = readFileSync(join(import.meta.dir, '../../systemd/router-actions.sh'), 'utf8');
  const pinnedCurrentPath = '/var/lib/slack-concierge-deployment/current/control/bot';
  assert.ok(wrapperSource.includes(pinnedCurrentPath), 'fixture replaces only the fixed current-release path');
  assert.match(wrapperSource, /if \[ "\$\(uname -s\)" != Darwin \]/, 'the current release selection remains server-only');
  const installed = join(root, 'router-actions.sh');
  writeFileSync(installed, wrapperSource.replaceAll(pinnedCurrentPath, currentBot)
    .replaceAll('exec bun run', 'exec "$FIXTURE_BUN" run'));

  const fakeBun = join(root, 'capture-arguments.js');
  writeFileSync(fakeBun, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)))\n`);
  chmodSync(fakeBun, 0o755);
  const run = (verb:string,args:string[],pin:string)=>Bun.spawnSync({cmd:['bash',installed,verb,...args],stdout:'pipe',stderr:'pipe',env:{
    ...process.env,CONCIERGE_ROUTER_BOT_DIR:pin,FIXTURE_BUN:fakeBun,
  }});
  const args = ['--path', 'monologue', '--source-input', 'input-1', '--source-run', 'run-1', '--', 'dispatch fixture with spaces'];
  const child = run('test-capture',args,pinnedBot);
  assert.equal(child.exitCode, 0, child.stderr.toString());
  assert.deepEqual(JSON.parse(child.stdout.toString()), ['run',join(currentBot, 'scripts/agent-test-capture.js'), ...args]);

  const fallbackCurrent = join(root, 'missing-current/control/bot');
  const fallbackWrapper = join(root, 'router-actions-fallback.sh');
  writeFileSync(fallbackWrapper, wrapperSource.replaceAll(pinnedCurrentPath, fallbackCurrent)
    .replaceAll('exec bun run', 'exec "$FIXTURE_BUN" run'));
  const runFallback = (verb:string,argv:string[],pin:string)=>Bun.spawnSync({cmd:['bash',fallbackWrapper,verb,...argv],stdout:'pipe',stderr:'pipe',env:{
    ...process.env,CONCIERGE_ROUTER_BOT_DIR:pin,FIXTURE_BUN:fakeBun,
  }});
  const fallback = runFallback('test-capture',args,pinnedBot);
  assert.equal(fallback.exitCode, 0, fallback.stderr.toString());
  assert.deepEqual(JSON.parse(fallback.stdout.toString()), ['run',join(pinnedBot, 'scripts/agent-test-capture.js'), ...args],
    'existing fallback remains when no current client artifact is available');

  const pinnedTs = join(root,'pinned-typescript/bot');
  mkdirSync(join(pinnedTs,'scripts'),{recursive:true});
  writeFileSync(join(pinnedTs,'scripts/agent-test-capture.ts'),'pinned TypeScript fallback');
  const typescriptFallback = runFallback('test-capture',args,pinnedTs);
  assert.equal(typescriptFallback.exitCode,0,typescriptFallback.stderr.toString());
  assert.deepEqual(JSON.parse(typescriptFallback.stdout.toString()),['run',join(pinnedTs,'scripts/agent-test-capture.ts'),...args],
    'fallback suffix follows the pinned bot when its JS marker is absent');

  const fakeHome=join(root,'darwin-home');
  mkdirSync(join(fakeHome,'.local/bin'),{recursive:true});
  const fakeUname=join(fakeHome,'.local/bin/uname');
  writeFileSync(fakeUname,'#!/bin/sh\nprintf \'Darwin\\n\'\n');chmodSync(fakeUname,0o755);
  const darwin=Bun.spawnSync({cmd:['bash',installed,'test-capture',...args],stdout:'pipe',stderr:'pipe',env:{
    ...process.env,HOME:fakeHome,CONCIERGE_ROUTER_BOT_DIR:pinnedBot,FIXTURE_BUN:fakeBun,
  }});
  assert.equal(darwin.exitCode,0,darwin.stderr.toString());
  assert.deepEqual(JSON.parse(darwin.stdout.toString()),['run',join(pinnedBot,'scripts/agent-test-capture.js'),...args],
    'the executable Darwin branch keeps using its local pinned client');

  const otherArgs=['--','keep this unrelated verb pinned'];
  const other = run('todo-add',otherArgs,pinnedBot);
  assert.equal(other.exitCode,0,other.stderr.toString());
  assert.deepEqual(JSON.parse(other.stdout.toString()),['run',join(pinnedBot,'scripts/router-todo.js'),...otherArgs],
    'unrelated verbs stay on the pinned bot');
  console.log(JSON.stringify({fixture:'test-capture-installed-dispatch',linuxCurrentWinsStalePin:true,
    missingCurrentFallback:true,pinnedTypeScriptFallback:true,darwinPinnedClient:true,
    argumentsWithSpacesPreserved:true,unrelatedVerbRemainsPinned:true}));
} finally {
  rmSync(root, {recursive:true,force:true});
}
