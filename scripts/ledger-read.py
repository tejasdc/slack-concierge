#!/usr/bin/env python3
"""Answer one read-only SQL question against a live Concierge database, bounded in time and rows.

This is the sanctioned way for an agent to analyse the live ledger. It costs no disk: the query
runs against the database where it is, through a read-only connection that cannot write, and
each statement holds its read snapshot only while it runs. A deadline interrupts a runaway scan
so it cannot pin the write-ahead log or keep the shared disk busy for long.

On 2026-11-04 two investigations each copied the whole 8 GB ledger into /tmp to run a few dozen
queries; each copy pushed the root disk under its 50 GB floor and fired the disk alert.
Every one of those queries would have run here in seconds.

Usage:
  python3 scripts/ledger-read.py "SELECT count(*) FROM inbox_topics WHERE state = 'open'"
  python3 scripts/ledger-read.py --database meaning-index "SELECT ..."
  python3 scripts/ledger-read.py --database /abs/other.db --max-seconds 60 "SELECT ..."

Output is one JSON object per row on stdout; the row count and time go to stderr.
"""

import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

# The progress callback runs every this many SQLite virtual-machine steps; small enough that a
# deadline is noticed within milliseconds, large enough to cost nothing measurable.
PROGRESS_STEPS = 10_000


class ReadError(Exception):
    pass


def state_directory():
    configured = os.environ.get("CONCIERGE_STATE_DIR")
    return Path(configured) if configured else Path.home() / ".local" / "state" / "concierge"


def database_path(name):
    """A bare name is a database in Concierge's state directory, followed to its real home."""
    path = Path(name) if os.sep in name else state_directory() / f"{name}.db"
    if not path.is_absolute():
        raise ReadError("a database path must be absolute, or a bare name such as state")
    try:
        return path.resolve(strict=True)
    except FileNotFoundError:
        if os.environ.get("CONCIERGE_RUNNER_STATE"):
            # A runner has no ledger: it lives with the owner (docs/architecture/RUNNERS.md).
            raise ReadError(f"no database at {path}: this shell runs on a Concierge runner, which holds no ledger; "
                            "name the owner's database by absolute path when it is on this machine") from None
        raise ReadError(f"no database at {path}") from None


def positive_int(value):
    result = int(value)
    if result <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return result


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("sql", help="one SELECT (or other read-only) statement")
    parser.add_argument("--database", default="state",
                        help="state (default), meaning-index, presentation, or an absolute path")
    parser.add_argument("--max-seconds", type=positive_int, default=30,
                        help="interrupt the statement after this long (default 30)")
    parser.add_argument("--max-rows", type=positive_int, default=1000,
                        help="print at most this many rows (default 1000)")
    return parser.parse_args()


def read(path, sql, max_seconds, max_rows, out=sys.stdout):
    connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5,
                                 isolation_level=None)
    try:
        connection.execute("PRAGMA query_only=ON")
        started = time.monotonic()
        deadline = started + max_seconds
        connection.set_progress_handler(lambda: 1 if time.monotonic() >= deadline else 0, PROGRESS_STEPS)
        cursor = connection.cursor()
        try:
            cursor.execute(sql)
            columns = [column[0] for column in cursor.description or []]
            printed = 0
            while printed < max_rows:
                row = cursor.fetchone()
                if row is None:
                    break
                out.write(json.dumps(dict(zip(columns, row)), default=str, ensure_ascii=False) + "\n")
                printed += 1
            truncated = printed == max_rows and cursor.fetchone() is not None
        except sqlite3.OperationalError as error:
            if "interrupt" in str(error).lower():
                raise ReadError(
                    f"stopped after {max_seconds}s; narrow the query (an indexed WHERE, a LIMIT) "
                    "rather than raising --max-seconds") from None
            raise
        finally:
            cursor.close()
        return printed, truncated, time.monotonic() - started
    finally:
        connection.close()


def main():
    args = parse_args()
    try:
        path = database_path(args.database)
        rows, truncated, seconds = read(path, args.sql, args.max_seconds, args.max_rows)
    except (ReadError, sqlite3.Error, ValueError) as error:
        print(f"read failed: {error}", file=sys.stderr)
        return 1
    more = f"; stopped at --max-rows {args.max_rows}, more rows exist" if truncated else ""
    print(f"{rows} rows in {seconds:.2f}s from {path}{more}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
