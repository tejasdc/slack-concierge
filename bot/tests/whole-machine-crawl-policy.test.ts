import { describe, expect, test } from 'bun:test';
import { wholeMachineCrawlRefusal } from '../src/whole-machine-crawl-policy';

const refused = [
  "rg -n 'journal-save-crash-proof|journal-probe' /proc/[0-9]*/cwd /proc/[0-9]*/cmdline",
  'rg foo /',
  'rg -l foo /proc/*/root',
  'grep -rn foo /proc/1234/cwd',
  'grep -R foo /proc',
  'sudo nice -n 10 rg -e foo /',
  "bash -lc 'cd /tmp && rg foo /proc/[0-9]*/cwd'",
  'find / -name state.db',
  'find -L /proc/*/cwd -name x',
  'fd state.db /',
  'ls -R /',
  'timeout 60 rg foo //',
  'x=$(rg -l foo /proc/*/cwd)',
  'rg foo /.',
  'cd / && rg foo .',
  'cd /tmp && cd .. && find . -name x',
  'rg -d 2 -d 100 foo /',
];
const allowed = [
  "rg -n 'journal-probe' /proc/[0-9]*/cmdline",
  'rg foo /root/workspace/slack-concierge',
  'rg foo',
  'grep foo /proc/1234/cmdline',
  'grep -n foo /etc/hosts',
  'pgrep -af journal-probe',
  'ps -eo pid,args',
  'readlink /proc/1234/cwd',
  'ls -la /proc/1234/cwd',
  'find / -maxdepth 2 -name "*.db"',
  'find . -name x',
  'rg --max-depth 2 foo /',
  'rg -e / src',
  'cat /proc/loadavg',
  'rg foo /proc/self/cwd/src',
  'rg foo /proc/123/cwd/file.log',
  'cd /root/workspace && rg foo .',
];

describe('whole-machine crawl refusal', () => {
  for (const command of refused) test(`refuses ${command}`, () => expect(wholeMachineCrawlRefusal(command, '', {}, '/tmp')).toContain('Refused'));
  for (const command of allowed) test(`allows ${command}`, () => expect(wholeMachineCrawlRefusal(command, '', {}, '/tmp')).toBeNull());
  test("refuses Claude's Grep and Glob over the whole machine", () => {
    expect(wholeMachineCrawlRefusal(null, 'Grep', { pattern: 'x', path: '/' })).toContain('Refused');
    expect(wholeMachineCrawlRefusal(null, 'Glob', { pattern: '/proc/*/cwd/**/*.ts' })).toContain('Refused');
    expect(wholeMachineCrawlRefusal(null, 'Grep', { pattern: 'x', path: '/root/workspace' })).toBeNull();
    expect(wholeMachineCrawlRefusal(null, 'Glob', { pattern: '**/*.ts', path: '/root/workspace/thinkering' })).toBeNull();
  });
});

describe('whole-journal scan refusal', () => {
  test('refuses unscoped long journal reads, allows scoped or short ones', () => {
    for (const command of ['journalctl --since 2026-11-05 -o cat', 'journalctl -o cat --since "7 days ago" --grep x', 'journalctl', 'journalctl --since -3days', 'timeout 60 journalctl --since yesterday | grep x'])
      expect(wholeMachineCrawlRefusal(command, 'Bash', {}, '/root')).toContain('whole system journal');
    for (const command of ['journalctl -u thinkering* --since "7 days ago" --grep x', 'journalctl --since -2h -o cat', 'journalctl -n 200', 'journalctl -t work-flow-supervisor.sh --since 03:30', 'journalctl _SYSTEMD_UNIT=x.service', 'journalctl -xeu foo.service', 'journalctl -f', 'journalctl --disk-usage'])
      expect(wholeMachineCrawlRefusal(command, 'Bash', {}, '/root')).toBeNull();
  });
});
