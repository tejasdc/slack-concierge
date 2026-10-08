#!/usr/bin/env python3
"""Make one bounded SQLite diagnostic snapshot without exposing a partial result."""

import argparse
import os
import sqlite3
import stat
import sys
import tempfile
import time
from pathlib import Path


class SnapshotError(Exception):
    pass


def positive_int(value):
    result = int(value)
    if result <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return result


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="absolute path to one existing WAL SQLite database")
    parser.add_argument("destination", type=Path, help="absolute path to a new snapshot file")
    parser.add_argument("--max-seconds", type=positive_int, default=120)
    parser.add_argument("--max-bytes", type=positive_int, default=8 * 1024**3)
    return parser.parse_args()


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

    deadline = time.monotonic() + max_seconds
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
        if page_size * page_count > max_bytes:
            raise SnapshotError("source snapshot exceeds byte limit")
        if time.monotonic() >= deadline:
            raise SnapshotError("snapshot deadline exceeded")

        # The private directory contains every temporary SQLite sidecar. Its database
        # filename cannot be confused with the requested destination on failure.
        with tempfile.TemporaryDirectory(prefix=".sqlite-snapshot-", dir=destination_parent) as staging:
            staged_path = Path(staging) / "snapshot.db"
            fd = os.open(staged_path, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
            os.close(fd)
            destination = sqlite3.connect(staged_path, timeout=0)
            try:
                def check_progress(_status, _remaining, total):
                    if total * page_size > max_bytes or time.monotonic() >= deadline:
                        raise SnapshotError("snapshot limit or deadline exceeded")

                source.backup(destination, pages=128, progress=check_progress, sleep=0)
                destination.close()
                destination = None
                if time.monotonic() >= deadline:
                    raise SnapshotError("snapshot deadline exceeded")
                with staged_path.open("rb") as output:
                    os.fsync(output.fileno())
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
    finally:
        if source is not None:
            try:
                if source.in_transaction:
                    source.rollback()
            finally:
                source.close()


def main():
    args = parse_args()
    try:
        snapshot(args.source, args.destination, args.max_seconds, args.max_bytes)
    except (SnapshotError, OSError, sqlite3.Error, ValueError) as error:
        print(f"snapshot failed: {error}", file=sys.stderr)
        return 1
    print("snapshot complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
