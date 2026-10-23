#!/usr/bin/env python3
"""Make one bounded SQLite diagnostic snapshot without exposing a partial result.

The copy is written through to disk in small pieces as it goes. A large copy that is
only flushed at the end leaves gigabytes of dirty, journal-ordered data on the shared
filesystem, and every other fsync on that filesystem (the ledger's own durability sync
among them) then waits for all of it: on 2026-10-23 a 5.4 GB ledger copy under the
agents' disk write cap held the Concierge owner for 31 seconds.
"""

import argparse
import os
import signal
import sqlite3
import stat
import sys
import tempfile
import time
from pathlib import Path

# Dirty copy data outstanding at any moment is bounded by this many bytes. Each flush
# forces the filesystem journal to wait for at most this much, so neighbours sharing
# the filesystem see sub-second waits instead of the whole copy.
FLUSH_BYTES = 32 * 1024 * 1024
BACKUP_STEP_PAGES = 128


class SnapshotError(Exception):
    pass


def positive_int(value):
    result = int(value)
    if result <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return result


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("source", type=Path, help="absolute path to one existing WAL SQLite database")
    parser.add_argument("destination", type=Path, help="absolute path to a new snapshot file")
    parser.add_argument("--max-seconds", type=positive_int, default=120,
                        help="whole copy including its flushes to disk (default 120)")
    parser.add_argument("--max-bytes", type=positive_int, default=8 * 1024**3)
    return parser.parse_args()


def stop_on_terminate(signum, _frame):
    # Raising here lets the staging directory, both connections and the pinned read
    # snapshot be released; Python's default would end the process with them in place.
    raise SnapshotError(f"stopped by signal {signum}")


def flush_written(fd):
    # fdatasync on a second descriptor of the same inode writes out what SQLite has
    # spilled so far; DONTNEED then returns those pages so the copy never evicts the
    # serving process's own cached data.
    os.fdatasync(fd)
    os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)


def snapshot(source_path, destination_path, max_seconds, max_bytes):
    if not source_path.is_absolute() or not destination_path.is_absolute():
        raise SnapshotError("both paths must be absolute")
    if not stat.S_ISREG(source_path.lstat().st_mode):
        raise SnapshotError("source must be a regular file")
    source_path = source_path.resolve(strict=True)
    destination_parent = destination_path.parent.resolve(strict=True)
    destination_path = destination_parent / destination_path.name
    if not stat.S_ISDIR(destination_parent.stat().st_mode):
        raise SnapshotError("destination parent must be a directory")
    if os.path.lexists(destination_path):
        raise SnapshotError("destination already exists")
    if source_path == destination_path:
        raise SnapshotError("source and destination must differ")

    started = time.monotonic()
    deadline = started + max_seconds
    source = None
    destination = None
    try:
        # A read-only URI plus query_only protects the logical source database.
        source = sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True, timeout=0)
        source.execute("PRAGMA query_only=ON")
        journal_mode = source.execute("PRAGMA journal_mode").fetchone()[0].lower()
        if journal_mode != "wal":
            raise SnapshotError("source must use WAL mode")
        source.execute("BEGIN")
        # BEGIN alone does not acquire a snapshot. This read pins one committed cut.
        source.execute("SELECT count(*) FROM sqlite_schema").fetchone()
        page_size = source.execute("PRAGMA page_size").fetchone()[0]
        page_count = source.execute("PRAGMA page_count").fetchone()[0]
        total_bytes = page_size * page_count
        if total_bytes > max_bytes:
            raise SnapshotError("source snapshot exceeds byte limit")
        if time.monotonic() >= deadline:
            raise SnapshotError("snapshot deadline exceeded")

        # The private directory contains every temporary SQLite sidecar. Its database
        # filename cannot be confused with the requested destination on failure.
        with tempfile.TemporaryDirectory(prefix=".sqlite-snapshot-", dir=destination_parent) as staging:
            staged_path = Path(staging) / "snapshot.db"
            staged_fd = os.open(staged_path, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
            try:
                destination = sqlite3.connect(staged_path, timeout=0)
                copied = {"bytes": 0, "flushed_at": 0}

                def check_progress(_status, remaining, total):
                    copied["bytes"] = (total - remaining) * page_size
                    if total * page_size > max_bytes:
                        raise SnapshotError("snapshot limit exceeded")
                    if copied["bytes"] - copied["flushed_at"] >= FLUSH_BYTES:
                        flush_written(staged_fd)
                        copied["flushed_at"] = copied["bytes"]
                    if time.monotonic() >= deadline:
                        raise SnapshotError(
                            f"snapshot deadline exceeded after copying {copied['bytes']} of "
                            f"{total_bytes} bytes in {max_seconds}s; raise --max-seconds for this source")

                source.backup(destination, pages=BACKUP_STEP_PAGES, progress=check_progress, sleep=0)
                destination.close()
                destination = None
                flush_written(staged_fd)
                if time.monotonic() >= deadline:
                    raise SnapshotError("snapshot deadline exceeded")
                # link() is atomic and refuses an existing destination, including a
                # path created after the first check. No incomplete file is published.
                os.link(staged_path, destination_path, follow_symlinks=False)
                parent_fd = os.open(destination_parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(parent_fd)
                finally:
                    os.close(parent_fd)
            finally:
                if destination is not None:
                    destination.close()
                os.close(staged_fd)
    finally:
        if source is not None:
            try:
                if source.in_transaction:
                    source.rollback()
            finally:
                source.close()
    return time.monotonic() - started


def main():
    args = parse_args()
    signal.signal(signal.SIGTERM, stop_on_terminate)
    try:
        seconds = snapshot(args.source, args.destination, args.max_seconds, args.max_bytes)
    except (SnapshotError, OSError, sqlite3.Error, ValueError) as error:
        print(f"snapshot failed: {error}", file=sys.stderr)
        return 1
    print(f"snapshot complete in {seconds:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
