#!/usr/bin/env python3
"""Disposable filesystem/Git acceptance. Never reads the real Mac or Concierge ledger."""
import gzip
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import shutil
import tempfile
import time
import unittest
import sys
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('maintenance', Path(__file__).with_name('mac-disk-maintenance.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Maintenance(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='concierge-mac-disk-fixture-')
        self.root = Path(self.temp.name).resolve()
        self.now = time.time()

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return m.run(['git', '-C', self.root, *args]).decode().strip()

    def worktree(self):
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'fixture@example.test')
        (self.root / 'source.txt').write_text('finished work')
        (self.root / '.gitignore').write_text('node_modules/\n.env\ntmp/\n')
        self.git('add', '.')
        self.git('commit', '-m', 'fixture')
        self.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
        wt = self.root / '.wt' / ('finished-' + self.root.name)
        self.git('worktree', 'add', '-b', 'finished', str(wt))
        return wt

    def test_rotation_preserves_inode_and_full_legacy_with_bounded_generations(self):
        log = self.root / 'concierge.err'
        log.write_bytes(b'old-freeze-evidence\n' * 100)
        fd = os.open(log, os.O_WRONLY | os.O_APPEND)
        inode = log.stat().st_ino
        try:
            with patch.object(m, 'LOG_BYTES', 64):
                self.assertTrue(m.rotate(log))
                evidence = gzip.open(log.with_name('concierge.err.0.gz'), 'rb').read()
                self.assertEqual(evidence, b'old-freeze-evidence\n' * 100)
                for i in range(6):
                    os.write(fd, str(i).encode() * 100)
                    self.assertTrue(m.rotate(log))
                os.write(fd, b'still-live\n')
            self.assertEqual(log.stat().st_ino, inode)
            self.assertEqual(log.read_bytes(), b'still-live\n')
            self.assertEqual(len(list(self.root.glob('*.gz'))), 4)
            self.assertEqual(gzip.open(log.with_name('concierge.err.0.gz'), 'rb').read(), evidence)
        finally:
            os.close(fd)

    def test_rotation_refuses_links_and_failed_archive_leaves_original(self):
        log = self.root / 'concierge.log'
        log.write_bytes(b'x' * 100)
        with patch.object(m, 'LOG_BYTES', 64), patch.object(m.gzip.GzipFile, 'write', side_effect=OSError('full')):
            with self.assertRaises(OSError):
                m.rotate(log)
        self.assertEqual(log.read_bytes(), b'x' * 100)
        link = self.root / 'speech.log'
        link.symlink_to(log)
        with self.assertRaises(RuntimeError):
            m.rotate(link)

    def test_only_old_owned_empty_identity_staging(self):
        names = ['antigravity-identity.ABC123', 'antigravity-identity.ABC124',
                 'antigravity-identity.json', 'antigravity-identity.ABC125']
        for name in names:
            path = self.root / name
            path.write_text('')
            path.chmod(0o600)
        (self.root / names[1]).write_text('retained content')
        (self.root / names[3]).chmod(0o644)
        self.assertEqual(m.clean_identity(self.root, self.now + 90000), 1)
        self.assertFalse((self.root / names[0]).exists())
        self.assertTrue(all((self.root / name).exists() for name in names[1:]))

    def test_vanished_identity_and_sweep_error_do_not_block_pressure_receipt(self):
        path = self.root / 'antigravity-identity.ABC123'
        path.write_text('')
        path.chmod(0o600)
        lstat = Path.lstat
        def vanished(candidate, *args, **kwargs):
            if candidate == path:
                raise FileNotFoundError('producer already removed it')
            return lstat(candidate, *args, **kwargs)
        with patch.object(Path, 'lstat', vanished):
            self.assertEqual(m.clean_identity(self.root, self.now + 90000), 0)
        arguments = ['maintenance', '--state', str(self.root), '--workspace', str(self.root), '--repo', str(self.root)]
        with patch.object(sys, 'argv', arguments), patch.object(m, 'LOG_NAMES', ()), \
                patch.object(m, 'clean_identity', side_effect=PermissionError('sweep refused')), \
                patch.object(m, 'retire_worktrees', return_value={'retired': []}), \
                patch.object(m, 'low_space', return_value={'low': False}) as pressure:
            m.main()
        pressure.assert_called_once()
        receipt = json.loads((self.root / 'mac-disk-maintenance.json').read_text())
        self.assertIn('identity: sweep refused', receipt['errors'])

    def test_rotation_never_overwrites_a_producer_append_after_truncate(self):
        log = self.root / 'concierge.log'
        log.write_bytes(b'x' * 100)
        fd = os.open(log, os.O_WRONLY | os.O_APPEND)
        truncate = os.ftruncate
        def truncate_then_producer(target, size):
            truncate(target, size)
            os.write(fd, b'new live line\n')
        try:
            with patch.object(m, 'LOG_BYTES', 64), patch.object(m.os, 'ftruncate', side_effect=truncate_then_producer):
                m.rotate(log)
            self.assertEqual(log.read_bytes(), b'new live line\n')
        finally:
            os.close(fd)

    def test_compression_time_appends_are_readable_in_concatenated_gzip(self):
        log = self.root / 'concierge.log'
        log.write_bytes(b'original\n' * 100)
        fd = os.open(log, os.O_WRONLY | os.O_APPEND)
        write = gzip.GzipFile.write
        appended = False
        def write_and_append(zipped, data):
            nonlocal appended
            result = write(zipped, data)
            if not appended:
                os.write(fd, b'during compression\n')
                appended = True
            return result
        try:
            with patch.object(m, 'LOG_BYTES', 64), patch.object(m.gzip.GzipFile, 'write', write_and_append):
                m.rotate(log)
            with gzip.open(log.with_name('concierge.log.0.gz'), 'rb') as archived:
                self.assertEqual(archived.read(), b'original\n' * 100 + b'during compression\n')
        finally:
            os.close(fd)

    def test_worktree_proof_rejects_dirty_unique_busy_recent_and_private_ignored(self):
        wt = self.worktree()
        future = self.now + 9 * 86400
        self.assertTrue(m.eligible(wt, future, []))
        self.assertFalse(m.eligible(wt, future, [str(wt / 'sub')]))
        self.assertFalse(m.eligible(wt, self.now, []))
        (wt / '.env').write_text('private')
        self.assertFalse(m.eligible(wt, future, []))
        (wt / '.env').unlink()
        (wt / 'node_modules').mkdir()
        (wt / 'node_modules/package').write_text('rebuildable')
        self.assertTrue(m.eligible(wt, future, []))
        (wt / 'source.txt').write_text('unfinished')
        self.assertFalse(m.eligible(wt, future, []))
        m.run(['git', '-C', wt, 'add', 'source.txt'])
        m.run(['git', '-C', wt, 'commit', '-m', 'unique'])
        with self.assertRaises(subprocess.CalledProcessError):
            m.eligible(wt, future, [])

    def test_trashed_worktree_registration_can_be_removed_without_deleting_branch(self):
        wt = self.worktree()
        trash = Path.home() / '.Trash' / wt.name if sys.platform == 'darwin' else self.root / 'owned-fixture-trash'
        self.assertFalse(trash.exists(), 'fixture must never overwrite existing Trash')
        try:
            if sys.platform == 'darwin':
                m.run(['/usr/bin/trash', '--stopOnError', wt])
            else:
                wt.rename(trash)
            self.git('worktree', 'remove', '--force', str(wt))
            self.assertEqual((trash / 'source.txt').read_text(), 'finished work')
            self.assertTrue(self.git('rev-parse', 'refs/heads/finished'))
            self.assertNotIn(str(wt), self.git('worktree', 'list', '--porcelain'))
        finally:
            if sys.platform == 'darwin' and trash.exists():
                shutil.rmtree(trash)  # Only this assertion-owned disposable fixture.

    def test_pending_session_folders_and_unknown_location(self):
        with sqlite3.connect(self.root / 'state.db') as db:
            db.execute('CREATE TABLE turns(status TEXT,session_id INTEGER)')
            db.execute('CREATE TABLE sessions(id INTEGER,slack_channel_id TEXT,native_metadata_json TEXT)')
            db.execute('CREATE TABLE channels(slack_channel_id TEXT,code_path TEXT)')
            db.execute("INSERT INTO sessions VALUES (1,'native',?)", (json.dumps({'cwd': str(self.root / 'busy')}),))
            db.execute("INSERT INTO turns VALUES ('done',1)")
        self.assertEqual(m.pending_cwds(self.root), [])
        with sqlite3.connect(self.root / 'state.db') as db:
            db.execute("INSERT INTO turns VALUES ('running',1)")
        self.assertEqual(m.pending_cwds(self.root), [str(self.root / 'busy')])
        with sqlite3.connect(self.root / 'state.db') as db:
            db.execute("UPDATE turns SET status='parked' WHERE status='running'")
            db.execute('UPDATE sessions SET native_metadata_json=?', (json.dumps({'cwd':str(self.root / 'busy'),
                'additionalDirs':[str(self.root / 'extra')]}),))
        self.assertEqual(m.pending_cwds(self.root), [str(self.root / 'busy'), str(self.root / 'extra')])
        with sqlite3.connect(self.root / 'state.db') as db:
            db.execute("UPDATE sessions SET native_metadata_json='{}'")
        with self.assertRaises(RuntimeError):
            m.pending_cwds(self.root)

    def test_notice_retry_keeps_episode_and_recovery_hysteresis(self):
        sent = []
        def send(episode, free, recovered):
            sent.append('mac-disk-low:' + str(episode))
        with patch.object(m, 'send_pressure', side_effect=OSError('unknown send')):
            with self.assertRaises(OSError):
                m.low_space(self.root, 19 * m.GIB)
        with patch.object(m, 'send_pressure', side_effect=send):
            m.low_space(self.root, 19 * m.GIB)
            m.low_space(self.root, 21 * m.GIB)
            m.low_space(self.root, 19 * m.GIB)
            m.low_space(self.root, 26 * m.GIB)
            m.low_space(self.root, 19 * m.GIB)
        self.assertEqual(sent, ['mac-disk-low:1', 'mac-disk-low:2'])

    def test_pending_notice_retries_after_band_and_recovery(self):
        calls = []
        def send(episode, free, recovered):
            calls.append((episode, free // m.GIB, recovered))
            if len(calls) < 3:
                raise OSError('unaccepted')
        with patch.object(m, 'send_pressure', side_effect=send):
            for free in (19, 21):
                with self.assertRaises(OSError):
                    m.low_space(self.root, free * m.GIB)
            m.low_space(self.root, 26 * m.GIB)
        self.assertEqual(calls, [(1, 19, False), (1, 21, False), (1, 26, True)])
        self.assertEqual(json.loads((self.root / 'mac-disk-pressure.json').read_text())['pending'], [])

    def test_failed_rotation_keeps_all_history_and_interruption_does_not_age_again(self):
        log = self.root / 'concierge.log'
        log.write_bytes(b'current' * 100)
        archives = {}
        for generation in range(4):
            path = log.with_name(log.name + '.' + str(generation) + '.gz')
            with gzip.open(path, 'wb') as output:
                output.write(str(generation).encode())
            archives[path] = path.read_bytes()
        with patch.object(m, 'LOG_BYTES', 64):
            for _ in range(2):
                with patch.object(m.gzip.GzipFile, 'write', side_effect=OSError('full')):
                    with self.assertRaises(OSError):
                        m.rotate(log)
                self.assertEqual({p: p.read_bytes() for p in archives}, archives)
            with patch.object(m.os, 'ftruncate', side_effect=OSError('interrupted')):
                with self.assertRaises(OSError):
                    m.rotate(log)
            after = {p: p.read_bytes() for p in self.root.glob('*.gz')}
            with self.assertRaisesRegex(RuntimeError, 'held'):
                m.rotate(log)
            self.assertEqual({p: p.read_bytes() for p in self.root.glob('*.gz')}, after)

    def test_worktree_refuses_gitlinks_submodule_admin_and_alias_ancestors(self):
        wt = self.worktree()
        future = self.now + 9 * 86400
        alias = self.root / 'alias'
        alias.symlink_to(self.root / '.wt', target_is_directory=True)
        self.assertFalse(m.eligible(alias / wt.name, future, []))
        admin = Path(m.run(['git', '-C', wt, 'rev-parse', '--absolute-git-dir']).decode().strip())
        (admin / 'modules').mkdir()
        self.assertFalse(m.eligible(wt, future, []))
        (admin / 'modules').rmdir()
        head = self.git('rev-parse', 'HEAD')
        m.run(['git', '-C', wt, 'update-index', '--add', '--cacheinfo', '160000,' + head + ',nested'])
        m.run(['git', '-C', wt, 'commit', '-m', 'submodule fixture'])
        m.run(['git', '-C', wt, 'update-ref', 'refs/remotes/origin/main', 'HEAD'])
        self.assertFalse(m.eligible(wt, future, []))

    def test_retirement_deadline_keeps_partial_receipts_and_never_repeats_unknown_effect(self):
        for mode in ('predicate', 'trash'):
            with self.subTest(mode=mode):
                workspace = self.root / mode / 'workspace'
                state = self.root / mode / 'state'
                state.mkdir(parents=True)
                repo = workspace / 'project'
                first, second = repo / '.wt/a', repo / '.wt/b'
                first.mkdir(parents=True)
                second.mkdir()
                trash = state / 'owned-fixture-trash'
                trash.mkdir()
                calls = []
                def probe(path, *args):
                    if path == second and mode == 'predicate':
                        raise TimeoutError('budget exhausted in read')
                    return True
                def command(args, **kwargs):
                    args = [str(value) for value in args]
                    calls.append(args)
                    if args[0] == 'fixture-bun':
                        return b'{"token":"fixture-owned-gate"}' if 'claim' in args else b'{}'
                    if args[0] == '/usr/bin/trash':
                        path = Path(args[-1])
                        path.rename(trash / path.name)
                        if path == second:
                            raise subprocess.TimeoutExpired(args, 30)
                        return b''
                    if '--git-common-dir' in args:
                        return str(repo / '.git').encode()
                    if args[-1] == 'HEAD':
                        return b'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
                    return b''
                with patch.object(m, 'run', side_effect=command), patch.object(m, 'eligible', side_effect=probe), \
                        patch.object(m, 'pending_cwds', return_value=[]), patch.object(m, 'cwd_paths', return_value=['/']):
                    result = m.retire_worktrees(workspace, state, repo, 'fixture-bun', time.time())
                    self.assertEqual([row['path'] for row in result['retired']], [str(first)])
                    self.assertTrue(result['retired'][0]['registration_removed'])
                    self.assertTrue(result['gate_released'])
                    self.assertEqual(result['held'], 'thirty-second upkeep budget')
                    if mode == 'trash':
                        uncertain = result['retirement_unconfirmed'][0]
                        self.assertEqual((uncertain['path'], uncertain['head'], uncertain['step']),
                            (str(second), 'a' * 40, 'trash'))
                        m.write_state(state / 'mac-disk-maintenance.json', result)
                        before = len([call for call in calls if call[0] == '/usr/bin/trash'])
                        retry = m.retire_worktrees(workspace, state, repo, 'fixture-bun', time.time())
                        self.assertEqual(retry['retirement_unconfirmed'], [uncertain])
                        self.assertEqual(len([call for call in calls if call[0] == '/usr/bin/trash']), before)
                    else:
                        self.assertEqual(result['retirement_unconfirmed'], [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
