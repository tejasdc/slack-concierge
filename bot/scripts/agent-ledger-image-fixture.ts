import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentLedgerImageCommand } from '../src/agent-ledger-image-boundary';

if (process.platform !== 'linux') throw new Error('This acceptance requires the Linux mount boundary.');
const root = mkdtempSync(join(tmpdir(), 'concierge-agent-image-'));
try {
  const image = join(root, 'ledger.img');
  writeFileSync(image, 'owned fixture; never production bytes');
  // The control opens successfully and closes without reading a byte.
  closeSync(openSync(image, 'r'));
  const probe = `import os,sys,socket,subprocess
result=subprocess.run(["umount",sys.argv[1]],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
if result.returncode == 0: raise RuntimeError("image mount could be removed")
try:
 fd=os.open(sys.argv[1],os.O_RDONLY); os.close(fd)
except OSError as error:
 if error.errno not in (1,6,13): raise
else: raise RuntimeError("masked image still opens")
s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[2]); s.send(b"api"); s.close()
print("denied-open; api-reached")`;
  const socket = join(root, 'api.sock');
  let reached = false;
  const server = Bun.listen({ unix: socket, socket: { data(_socket, data) { reached = data.toString() === 'api'; } } });
  try {
    // Retained mount/DAC capabilities are intentional: private code checks need them.
    const command = agentLedgerImageCommand(['python3', '-c', probe, image, socket], [image]);
    const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(code, 0, stderr); assert.match(stdout, /denied-open; api-reached/); assert(reached);
    // A nested mount-capable private check still inherits an unopenable image.
    const nested = agentLedgerImageCommand(['/usr/bin/bwrap', '--die-with-parent', '--bind', '/', '/', '--dev', '/dev',
      '--unshare-user', '--uid', '0', '--gid', '0', '--cap-drop', 'ALL', '--cap-add', 'CAP_SYS_ADMIN',
      '--cap-add', 'CAP_DAC_OVERRIDE', '--', 'python3', '-c', probe, image, socket], [image]);
    const nestedChild = Bun.spawn(nested, { stdout: 'pipe', stderr: 'pipe' });
    const nestedError = await new Response(nestedChild.stderr).text();
    assert.equal(await nestedChild.exited, 0, nestedError);
  } finally { server.stop(true); }
  // A daemon starter exits after detaching its child. The child must still answer once
  // both bubblewrap starter processes have exited; no production daemon is involved.
  const daemonSocket = join(root, 'detached.sock');
  const detached = `import socket,sys
s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen(1)
c,_=s.accept(); c.send(b"alive"); c.close(); s.close()`;
  const starter = `import subprocess,sys,os,time
p=subprocess.Popen(["python3","-c",sys.argv[1],sys.argv[2]],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
for _ in range(500):
 if os.path.exists(sys.argv[2]): break
 time.sleep(.01)
else: p.kill(); raise RuntimeError("detached child did not start")
print(p.pid)`;
  const starterChild = Bun.spawn(agentLedgerImageCommand(['python3', '-c', starter, detached, daemonSocket], [image]),
    { stdout: 'pipe', stderr: 'pipe' });
  const [pidText, starterError, starterCode] = await Promise.all([new Response(starterChild.stdout).text(), new Response(starterChild.stderr).text(), starterChild.exited]);
  assert.equal(starterCode, 0, starterError);
  const detachedPid = Number(pidText.trim()); assert(detachedPid > 0);
  try {
    const answer = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Detached child did not answer after its starter exited')), 3000);
      Bun.connect({ unix: daemonSocket, socket: {
        data(socket, bytes) { clearTimeout(timer); resolve(bytes.toString()); socket.end(); },
        error(_socket, error) { clearTimeout(timer); reject(error); },
      } }).catch(error => { clearTimeout(timer); reject(error); });
    });
    assert.equal(answer, 'alive');
  } finally { try { process.kill(detachedPid, 'SIGTERM'); } catch {} }
  // The caller (owner/backup analogue) remains in its original namespace.
  closeSync(openSync(image, 'r'));
  const source = (name: string) => readFileSync(join(import.meta.dir, '../src', name), 'utf8');
  assert(source('execution-host-client.ts').includes('...agentLedgerImageCommand([runtime, "run", hostScript, directory])'));
  assert.equal(source('codex-daemon-file-limit.ts').split('...agentLedgerImageCommand([MANAGED_CODEX, "app-server", "daemon", "start"])').length - 1, 2);
  for (const file of ['provider-activation.ts', 'runner-provider-accounts.ts']) assert(source(file).includes('codexDaemonImageCommand(command, args)'), file);
  assert(source('deployment-repair-agent.ts').includes('agentLedgerImageCommand(trustedCodexExecCommand(executable, args))'));
  console.log('PASS: open/unmount denied, API reachable, nested private mounts preserved, detached daemon survives starter exit, caller unchanged, launch coverage present');
} finally { rmSync(root, { recursive: true, force: true }); }
