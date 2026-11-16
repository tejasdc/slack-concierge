#!/usr/bin/env python3
"""Mac-local housekeeping, called by the existing updater, never a second scheduler."""
import argparse
import fcntl
import gzip
import json
import os
import plistlib
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import time
import urllib.request
import uuid

MIB = 1024 ** 2
GIB = 1024 ** 3
LOG_BYTES = 32 * MIB
LOG_NAMES = ('concierge.log', 'concierge.err', 'speech.log', 'speech.err', 'update.log',
             'playwright-mcp.log', 'playwright-mcp.err')
LOW_BYTES = 20 * GIB
RECOVER_BYTES = 25 * GIB
IDLE_SECONDS = 7 * 86400
REBUILDABLE = {'node_modules', 'dist', 'build', '.next', '.turbo', '.svelte-kit', '.vite',
               '.cache', 'coverage', '__pycache__', '.build', 'target', '.pytest_cache',
               '.mypy_cache', '.ruff_cache'}
retirement_deadline = None


def command_timeout():
    if retirement_deadline is None:
        return 60
    remaining = retirement_deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError('thirty-second retirement admission budget exhausted')
    return min(60, remaining)


def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, capture_output=True,
                          timeout=command_timeout(), **kwargs).stdout


def owned_regular(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
        raise RuntimeError('refusing non-owned, linked or nonregular file: ' + str(path))
    return info


def rotate(path):
    """Keep launchd's inode. Preserve the entire first oversized generation as evidence."""
    marker = path.with_name(path.name + '.rotation.json')
    staging = path.with_name(path.name + '.rotation.tmp')
    if marker.exists():
        pending = json.loads(marker.read_text())
        published = path.with_name(pending['archive'])
        if published.exists():
            raise RuntimeError('log rotation held after interrupted publication: ' + str(path))
        # No published effect: discard only our incomplete staging and retry from the source.
        if staging.exists():
            owned_regular(staging)
            staging.unlink()
        marker.unlink()
    if not path.exists():
        return False
    info = owned_regular(path)
    if info.st_size <= LOG_BYTES:
        return False
    legacy = path.with_name(path.name + '.0.gz')
    first = not legacy.exists()
    archive = legacy if first else path.with_name(path.name + '.' + str(time.time_ns()) + '.gz')
    write_state(marker, {'archive': archive.name, 'inode': info.st_ino, 'source_bytes': info.st_size})
    # A prior interrupted pass is never interpreted as a complete archive.
    fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
    try:
        if os.fstat(fd).st_ino != info.st_ino:
            raise RuntimeError('log identity changed')
        # The snapshot size is fixed: an active producer cannot make compression run forever.
        staging_fd = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(os.dup(fd), 'rb') as source, os.fdopen(staging_fd, 'wb') as output:
            os.chmod(staging, 0o600)
            with gzip.GzipFile(fileobj=output, mode='wb') as zipped:
                remaining = info.st_size if first else min(info.st_size, LOG_BYTES)
                source.seek(info.st_size - remaining)
                while remaining:
                    block = source.read(min(MIB, remaining))
                    if not block:
                        raise RuntimeError('log shrank during rotation')
                    zipped.write(block)
                    remaining -= len(block)
            output.flush()
            os.fsync(output.fileno())
        # Retain bytes appended during compression as a second gzip member, never rewrite the
        # live file: rewriting after truncate could overwrite a new producer's append.
        # A producer faster than this bound refuses rotation instead of discarding the gap.
        end = os.fstat(fd).st_size
        if end < info.st_size or end - info.st_size > LOG_BYTES:
            raise RuntimeError('log changed too quickly; refusing truncation')
        appended = os.pread(fd, end - info.st_size, info.st_size)
        if appended:
            with open(staging, 'ab') as output:
                with gzip.GzipFile(fileobj=output, mode='wb') as zipped:
                    zipped.write(appended)
                output.flush()
                os.fsync(output.fileno())
        os.replace(staging, archive)
        os.ftruncate(fd, 0)
        os.fsync(fd)
        marker.unlink()
        # Immutable generations cannot shift or expire on a failed compression attempt.
        generations = [p for p in path.parent.glob(path.name + '.*.gz')
                       if re.fullmatch(re.escape(path.name) + r'\.[1-9][0-9]*\.gz', p.name)]
        generations.sort(key=lambda p: int(p.name[len(path.name) + 1:-3]), reverse=True)
        for expired in generations[3:]:
            owned_regular(expired)
            expired.unlink()
        return True
    finally:
        os.close(fd)
        if staging.exists():
            staging.unlink()
        if marker.exists() and not archive.exists():
            marker.unlink()


def clean_identity(state, now):
    removed = 0
    for path in state.glob('antigravity-identity.*'):
        if not re.fullmatch(r'antigravity-identity\.[A-Za-z0-9]{6}', path.name):
            continue
        try:
            info = path.lstat()
            if (stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
                    and info.st_size == 0 and stat.S_IMODE(info.st_mode) == 0o600
                    and now - max(info.st_mtime, info.st_ctime) > 86400):
                path.unlink()
                removed += 1
        except FileNotFoundError:
            continue
    return removed


def rebuildable(name):
    parts = Path(name).parts
    return (any(p in REBUILDABLE for p in parts) or '.artifacts/build/' in name
            or parts[-1] in ('.worktree-env', 'tsconfig.tsbuildinfo') or name.endswith('.pyc'))


def pending_cwds(state):
    # Unknown session location refuses the pass rather than granting removal authority.
    with sqlite3.connect((state / 'state.db').as_uri() + '?mode=ro', uri=True, timeout=2) as db:
        rows = db.execute("""SELECT s.native_metadata_json,c.code_path FROM turns t
            JOIN sessions s ON s.id=t.session_id
            LEFT JOIN channels c ON c.slack_channel_id=s.slack_channel_id
            WHERE t.status NOT IN ('done','error','cancelled')""").fetchall()
        paths = []
        for metadata, fallback in rows:
            meta = json.loads(metadata or '{}')
            cwd = meta.get('cwd') or fallback
            if not isinstance(cwd, str) or not cwd.startswith('/'):
                raise RuntimeError('pending session has no proven working folder')
            paths.append(str(Path(cwd).resolve()))
            for extra in meta.get('additionalDirs', []):
                if not isinstance(extra, str) or not extra.startswith('/'):
                    raise RuntimeError('pending session has an unknown additional folder')
                paths.append(str(Path(extra).resolve()))
        return paths


def cwd_paths():
    result = subprocess.run(['/usr/sbin/lsof', '-a', '-d', 'cwd', '-Fn'], capture_output=True,
                            text=True, timeout=command_timeout())
    # Missing process visibility must never turn into permission to remove work.
    if result.returncode or result.stderr.strip():
        raise RuntimeError('process cwd inventory incomplete: ' + result.stderr.strip()[:300])
    paths = [line[1:] for line in result.stdout.splitlines() if line.startswith('n/')]
    if not paths:
        raise RuntimeError('empty process cwd inventory')
    return paths


def eligible(path, now, busy):
    if path.is_symlink() or path.absolute() != path.resolve() or not (path / '.git').is_file():
        return False
    target = str(path.resolve())
    if any(str(Path(p).resolve()) == target or str(Path(p).resolve()).startswith(target + '/') for p in busy):
        return False
    if run(['git', '-C', path, 'status', '--porcelain=v1', '--untracked-files=all']):
        return False
    # Hidden index edits are not clean, even when ordinary status hides them.
    index = run(['git', '-C', path, 'ls-files', '-v', '-z']).decode().split('\0')
    if any(line and (line[0].islower() or line[0] == 'S') for line in index):
        return False
    if any(entry.startswith(b'160000 ') for entry in run(['git', '-C', path, 'ls-files', '--stage', '-z']).split(b'\0')):
        return False
    admin = Path(run(['git', '-C', path, 'rev-parse', '--absolute-git-dir']).decode().strip())
    if (admin / 'modules').exists():
        return False
    run(['git', '-C', path, 'merge-base', '--is-ancestor', 'HEAD', 'origin/main'])
    ignored = run(['git', '-C', path, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z']).decode().split('\0')
    if any(name and not rebuildable(name) for name in ignored):
        return False
    for root, dirs, files in os.walk(path, followlinks=False):
        command_timeout()
        dirs[:] = [d for d in dirs if d != '.git' and not rebuildable(str(Path(root, d).relative_to(path)) + '/')]
        for name in files:
            relative = str(Path(root, name).relative_to(path))
            if relative == '.git' or rebuildable(relative):
                continue
            info = Path(root, name).lstat()
            if now - max(info.st_mtime, info.st_ctime) < IDLE_SECONDS:
                return False
    return True


def retire_worktrees(workspace, state, repo, bun, now):
    global retirement_deadline
    # Reuse the updater's own gate, rather than racing its queue with an unrelated lock.
    env = dict(os.environ, CONCIERGE_STATE_DIR=str(state))
    command = [bun, repo / 'bot/scripts/drain-status.ts']
    run(command + ['recover'], env=env)
    previous_path = state / 'mac-disk-maintenance.json'
    previous = json.loads(previous_path.read_text()) if previous_path.exists() else {}
    unconfirmed = previous.get('retirement_unconfirmed', [])
    result = {'retired': [], 'retirement_unconfirmed': unconfirmed, 'held': None, 'gate_released': True}
    if unconfirmed:
        result['held'] = 'prior worktree effect needs reconciliation'
        return result
    pending_cwds(state)
    claim = json.loads(run(command + ['claim', '--worktree-retirement', '--owner-pid', os.getpid()], env=env).decode())
    token = claim.get('token')
    if not token:
        result['held'] = 'update gate unavailable'
        return result
    result['gate_released'] = False
    retirement_deadline = time.monotonic() + 30
    try:
        busy = cwd_paths() + pending_cwds(state)
        # Same bounded roots as the server precedent; never crawl personal folders.
        candidates = sorted(set(workspace.glob('*/.wt/*')) | set(workspace.glob('*/*/.wt/*')))
        for path in candidates:
            if time.time() - now > 30:
                result['held'] = 'thirty-second upkeep budget'
                return result
            attempt = None
            try:
                if not eligible(path, now, busy):
                    continue
                if not eligible(path, now, cwd_paths() + pending_cwds(state)):
                    continue
                common = run(['git', '-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir']).decode().strip()
                head = run(['git', '-C', path, 'rev-parse', 'HEAD']).decode().strip()
                attempt = {'path': str(path), 'head': head, 'attempt': uuid.uuid4().hex, 'step': 'trash'}
                run(['/usr/bin/trash', '--stopOnError', path])
                receipt = {'path': str(path), 'head': head, 'registration_removed': False}
                result['retired'].append(receipt)
                # The folder is already in Trash; remove only this missing worktree's registration.
                attempt['step'] = 'registration'
                run(['git', '--git-dir=' + common, 'worktree', 'remove', '--force', path])
                receipt['registration_removed'] = True
            except (TimeoutError, subprocess.TimeoutExpired):
                if attempt:
                    result['retirement_unconfirmed'].append({**attempt, 'outcome': 'unconfirmed'})
                result['held'] = 'thirty-second upkeep budget'
                return result
            except subprocess.CalledProcessError:
                if attempt:
                    result['retirement_unconfirmed'].append({**attempt, 'outcome': 'unconfirmed'})
                    result['held'] = 'worktree effect needs reconciliation'
                    return result
                continue
        return result
    except (TimeoutError, subprocess.TimeoutExpired):
        result['held'] = 'thirty-second upkeep budget'
        return result
    finally:
        retirement_deadline = None
        try:
            run(command + ['release', token], env=env)
            result['gate_released'] = True
        except Exception as error:
            result['gate_error'] = 'retirement gate release unconfirmed: ' + str(error)


def write_state(path, value):
    staging = path.with_suffix('.json.tmp')
    fd = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(value, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(staging, path)


def send_pressure(episode, free, recovered):
    # Read the installer's actual peer configuration; never duplicate its server address or token.
    plist = Path.home() / 'Library/LaunchAgents/com.tejasdc.concierge.plist'
    with open(plist, 'rb') as source:
        env = plistlib.load(source)['EnvironmentVariables']
    peers = json.loads(env['CONCIERGE_PEERS'])
    cloud = next(peer for peer in peers if peer['name'] == 'cloud')
    token = Path(env['CONCIERGE_PEER_TOKEN_FILE']).read_text().strip()
    request = urllib.request.Request(cloud['url'] + '/sessions/v1/peers/mac-disk-warning',
        data=json.dumps({'episode': episode, 'freeBytes': free, 'recovered': recovered}).encode(),
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(request, timeout=15) as response:
        receipt = json.loads(response.read(4096))
    if receipt.get('status') not in ('recorded', 'duplicate') or receipt.get('key') != 'mac-disk-low:' + str(episode):
        raise RuntimeError('notice transport returned no matching acceptance receipt')


def low_space(state, free):
    path = state / 'mac-disk-pressure.json'
    prior = json.loads(path.read_text()) if path.exists() else {'episode': 0, 'low': False, 'pending': []}
    if free >= RECOVER_BYTES and prior['low']:
        prior['low'] = False
    if free < LOW_BYTES and not prior['low']:
        prior['episode'] += 1
        prior['low'] = True
        prior['pending'].append(prior['episode'])
    # Delivery is independent of pressure: recovery never erases an unaccepted obligation.
    write_state(path, prior)
    for episode in prior['pending'][:]:
        send_pressure(episode, free, episode != prior['episode'] or not prior['low'])
        prior['pending'].remove(episode)
        write_state(path, prior)
    write_state(path, prior)
    return prior


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--repo', type=Path, required=True)
    args = parser.parse_args()
    state = args.state.resolve()
    with open(state / 'mac-disk-maintenance.lock', 'a') as lock:
        os.chmod(lock.name, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        now = time.time()
        report = {'event': 'mac_disk_maintenance', 'rotated': [], 'errors': []}
        bun = state / 'bun/bin/bun'
        for name in LOG_NAMES:
            try:
                if rotate(state / 'logs' / name):
                    report['rotated'].append(name)
            except Exception as error:
                report['errors'].append(str(error))
                marker = state / 'logs' / (name + '.rotation.json')
                if marker.exists():
                    try:
                        identity = json.loads(marker.read_text())['archive']
                        run([bun, args.repo / 'bot/scripts/service-notice.ts', '--key',
                             'mac-log-retention:' + identity, '--title', 'Mac log retention needs repair', '--',
                             'Mac log rotation stopped after an interrupted publication. All prior archives '
                             'and the active log are preserved. Reconcile the retained rotation before '
                             'resuming retention; do not delete diagnostic evidence.'],
                            env=dict(os.environ, CONCIERGE_STATE_DIR=str(state)))
                    except Exception as notice_error:
                        report['errors'].append('rotation repair notice: ' + str(notice_error))
        try:
            report['identity_removed'] = clean_identity(state, now)
        except Exception as error:
            report['errors'].append('identity: ' + str(error))
        try:
            report.update(retire_worktrees(args.workspace.resolve(), state, args.repo.resolve(), bun, now))
            if report.get('retirement_unconfirmed'):
                attempt = report['retirement_unconfirmed'][0]
                run([bun, args.repo / 'bot/scripts/service-notice.ts', '--key',
                     'mac-worktree-retirement:' + attempt['attempt'], '--title', 'Mac worktree cleanup needs reconciliation', '--',
                     'A Mac worktree cleanup command ended without a confirmed outcome. Preserve the '
                     'exact path, commit and operation in the maintenance receipt; reconcile Trash '
                     'and Git registration before clearing it. Do not repeat the uncertain effect.'],
                    env=dict(os.environ, CONCIERGE_STATE_DIR=str(state)))
        except Exception as error:
            report['errors'].append('worktrees: ' + str(error))
        report['free_bytes'] = shutil.disk_usage(state).free
        try:
            report['pressure'] = low_space(state, report['free_bytes'])
        except Exception as error:
            report['errors'].append('notice: ' + str(error))
        report['duration_ms'] = round((time.time() - now) * 1000)
        receipt = state / 'mac-disk-maintenance.json'
        write_state(receipt, report)
        print(json.dumps(report))


if __name__ == '__main__':
    main()
