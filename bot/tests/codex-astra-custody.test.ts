import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('direct Astra starts cannot turn a claimed human choice into an exemption', async () => {
  const state = mkdtempSync(join(tmpdir(), 'astra-custody-'));
  try {
    const run = async (script: string, reason: string, args: string[] = [], input = '') => {
      const child = Bun.spawn(['bun', `scripts/${script}`, ...args], {
        cwd: import.meta.dir + '/..', stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, CONCIERGE_STATE_DIR: state, CONCIERGE_CODEX_EXECUTABLE: '/bin/true',
          CODEX_ESCALATION_REASON: reason, CODEX_ESCALATION_ATTEMPT_ID: '' },
      });
      child.stdin.end(input);
      return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
    };
    const claim = 'Tejas explicitly chose Astra';
    const hookInput = JSON.stringify({ model: 'gpt-6-astra' });
    expect(JSON.parse((await run('codex-model-start-hook.ts', claim, [], hookInput)).stdout).decision).toBe('block');
    expect((await run('agent-codex-launch.ts', claim, ['-m', 'gpt-6-astra'])).code).toBe(64);

    const reason = 'Three failed fixes of the same issue; ChatGPT Pro unavailable';
    expect((await run('codex-model-start-hook.ts', reason, [], hookInput)).stdout).toBe('');
    expect((await run('agent-codex-launch.ts', reason, ['-m', 'gpt-6-astra'])).code).toBe(0);
    const records = readFileSync(join(state, 'model-escalations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records.map(record => record.source)).toEqual(['codex-native-session-start', 'codex-command-line']);
    expect(records.every(record => record.reason === reason)).toBe(true);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
