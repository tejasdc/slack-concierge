import { strict as assert } from 'node:assert';
import { Database } from 'bun:sqlite';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ledgerWriteResults } from '../src/ledger-write-results';
import { isVerifiedBackup, publishSqliteBackup, pruneVerifiedBackups } from '../src/verified-sqlite-backup';
import { liveStoreCopyRefusal } from '../src/live-store-copy-policy';
import { privateDatabaseCommand } from '../src/private-database-command';

const root = mkdtempSync(join(tmpdir(), 'concierge-schema-plan-'));
try {
  const source = join(root, 'source.db');
  const db = ledgerWriteResults(new Database(source));
  db.exec('CREATE TABLE facts(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO facts VALUES(1,\'retained\')');
  db.close();
  const path = (n: number) => join(root, `state.pre-deployment-repair.${n}.db`);
  publishSqliteBackup(source, path(1));
  assert(isVerifiedBackup(path(1)));
  // An incomplete newest-looking filename cannot evict a verified copy.
  writeFileSync(path(99), 'incomplete');
  assert.equal(pruneVerifiedBackups(root, 1), 0);
  assert(existsSync(path(1)) && existsSync(path(99)));
  publishSqliteBackup(source, path(2));
  assert.equal(pruneVerifiedBackups(root, 1), 1);
  assert(!existsSync(path(1)) && isVerifiedBackup(path(2)));
  const bytes = readFileSync(path(2));
  assert.throws(() => publishSqliteBackup(source, path(2)), /replace/);
  assert.deepEqual(readFileSync(path(2)), bytes);
  const broken = ledgerWriteResults(new Database(source));
  broken.exec('CREATE TABLE parents(id INTEGER PRIMARY KEY); CREATE TABLE children(id INTEGER REFERENCES parents(id)); INSERT INTO children VALUES(123)');
  broken.close();
  assert.throws(() => publishSqliteBackup(source, path(3)), /foreign_key_check/);
  assert(!existsSync(path(3)) && !existsSync(`${path(3)}.verified.json`));
  assert(!readdirSync(root).some(name => name.endsWith('.publishing')));

  assert(liveStoreCopyRefusal('sqlite3 /root/.local/state/concierge/state.db ".backup /tmp/copy.db"'));
  assert(liveStoreCopyRefusal('python3 scripts/diagnostic-sqlite-snapshot.py /a /b; cp /root/.local/state/concierge/state.db /tmp/raw.db'));
  const script = join(root, 'raw.py');
  writeFileSync(script, 'import sqlite3\nsrc=sqlite3.connect("/root/.local/state/concierge/state.db")\nsrc.backup(dst)\n');
  assert(liveStoreCopyRefusal(`python3 ${script}`));
  assert.equal(liveStoreCopyRefusal(`sed -n '1,95p' ${script}`), null);
  assert.equal(liveStoreCopyRefusal('python3 /root/workspace/slack-concierge/scripts/diagnostic-sqlite-snapshot.py /root/.local/state/concierge/state.db /tmp/new.db'), null);
  assert.equal(liveStoreCopyRefusal('sqlite3 -readonly /root/.local/state/concierge/state.db "select 1"'), null);

  // Real command import with another connection holding the writer. Before this fix, lkg
  // reran schema UPDATEs and exhausted busy_timeout despite being a read-only operation.
  const env = { ...process.env, CONCIERGE_STATE_DIR: root };
  const init = Bun.spawnSync([process.execPath, join(import.meta.dir, 'migrate-deployment-repair.ts'), '--empty-schema'], { env, stdout:'pipe', stderr:'pipe', timeout:20_000 });
  assert.equal(init.exitCode, 0, init.stderr.toString());
  const owner = ledgerWriteResults(new Database(join(root, 'state.db')));
  owner.exec('BEGIN IMMEDIATE');
  try {
    const read = Bun.spawnSync([process.execPath, join(import.meta.dir, 'release-manager.ts'), 'lkg'], { env, stdout:'pipe', stderr:'pipe', timeout:3_000 });
    assert.equal(read.exitCode, 1, read.stderr.toString());
    assert.equal(JSON.parse(read.stdout.toString()).status, 'missing');
    assert(!read.stderr.toString().includes('locked'));
    let canMountCanonical = true;
    try { accessSync(join(homedir(),'.local/state/concierge'),constants.R_OK | constants.X_OK); }
    catch { canMountCanonical = false; }
    if (process.platform === 'linux' && existsSync('/usr/bin/bwrap') && canMountCanonical) {
      // Keep the configured path outside home so the test-mode guard stays enforced.
      // The private canonical mount has the same database inode as root, so ledgerAccess
      // still exercises live-entrypoint policy without exposing the real live directory.
      const control = join(root, 'slack-concierge-deployment/releases', 'a'.repeat(40), 'control');
      mkdirSync(control, { recursive: true });
      const build = await Bun.build({entrypoints:[join(import.meta.dir,'release-manager.ts')],target:'bun',outdir:control});
      assert(build.success, build.logs.map(String).join('\n'));
      const compiled = Bun.spawnSync(['/usr/bin/bwrap','--die-with-parent','--bind','/','/','--dev','/dev',
        '--bind',root,join(homedir(),'.local/state/concierge'),'--unshare-user','--uid','0','--gid','0','--cap-drop','ALL',
        '--',process.execPath,join(control,'release-manager.js'),'lkg'],
        {env,stdout:'pipe',stderr:'pipe',timeout:3_000});
      assert.equal(compiled.exitCode,1,compiled.stderr.toString());
      assert(compiled.stdout.length,compiled.stderr.toString());
      assert.equal(JSON.parse(compiled.stdout.toString()).status,'missing');
      // A writing helper also has to open an existing database without CREATE. An unknown
      // command opens the connection but makes no mutation while our writer is held.
      const writing = Bun.spawnSync(['/usr/bin/bwrap','--die-with-parent','--bind','/','/','--dev','/dev',
        '--bind',root,join(homedir(),'.local/state/concierge'),'--unshare-user','--uid','0','--gid','0','--cap-drop','ALL',
        '--',process.execPath,join(control,'release-manager.js'),'fixture-unknown-command'],
        {env,stdout:'pipe',stderr:'pipe',timeout:3_000});
      assert.equal(writing.exitCode,1,writing.stderr.toString());
      assert.match(JSON.parse(writing.stdout.toString()).error,/usage: release-manager/);
      // The repair supervisor is another legitimate writer, but must never initialize schema.
      // Exercise just its entrypoint policy, without starting a repair agent.
      const repair = join(control,'deployment-repair.js');
      writeFileSync(repair,`import {ledgerAccess} from ${JSON.stringify(join(import.meta.dir,'../src/ledger-access-policy.ts'))}; console.log(JSON.stringify(ledgerAccess(process.env.CONCIERGE_STATE_DIR,import.meta.path,false)));`);
      const repairPolicy=Bun.spawnSync(['/usr/bin/bwrap','--die-with-parent','--bind','/','/','--dev','/dev',
        '--bind',root,join(homedir(),'.local/state/concierge'),'--unshare-user','--uid','0','--gid','0','--cap-drop','ALL',
        '--',process.execPath,repair],{env,stdout:'pipe',stderr:'pipe',timeout:3_000});
      assert.equal(repairPolicy.exitCode,0,repairPolicy.stderr.toString());
      assert.deepEqual(JSON.parse(repairPolicy.stdout.toString()),{live:true,schema:false,readonly:false});
    }
  } finally { owner.exec('ROLLBACK'); owner.close(); }
  if (process.platform === 'linux') {
    const command = privateDatabaseCommand(['/usr/bin/python3', '-c', 'import os; p=os.path.expanduser("~/.local/state/concierge/state.db");\ntry: open(p,"rb")\nexcept PermissionError: print("refused")\nelse: raise SystemExit("live file was accessible")']);
    if (existsSync(join(homedir(),'.local/state/concierge'))) {
      const isolated = Bun.spawnSync(command, { stdout:'pipe', stderr:'pipe', timeout:5_000 });
      assert.equal(isolated.exitCode, 0, isolated.stderr.toString());
      assert.equal(isolated.stdout.toString().trim(), 'refused');
    }
  }
  console.log(JSON.stringify({check:'database-safety',status:'passed',atomicPublication:true,verifiedRetention:true,readHelperUnderWriter:true,rawScriptRefusal:true}));
} finally { rmSync(root, { recursive: true, force: true }); }
