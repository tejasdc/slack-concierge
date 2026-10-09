#!/usr/bin/env python3
"""Standalone Bun socket backpressure acceptance; run from any working directory."""
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
BUN = "/usr/local/lib/slack-concierge-deployment/bun"
CHILD = ROOT / "scripts/bounded-logging-child.ts"


def source_guard():
    # This one-shot search helper's stdout is a JSON result protocol read by its parent.
    # It is not an application log and must not acquire a newline or loss semantics.
    protocol_outputs = {"presentation-search-read.ts": {"process.stdout.write"}}
    direct = re.compile(r"\bconsole\s*(?:\.\s*\w+|\[)|\bprocess\s*\.\s*(?:stdout|stderr)\s*\.\s*write\s*\(")
    checked = 0
    for path in sorted((ROOT / "src").rglob("*.ts")):
        relative = path.relative_to(ROOT / "src").as_posix()
        if relative == "log.ts":
            continue
        source = path.read_text()
        for match in direct.finditer(source):
            call = re.sub(r"\s+", "", match.group())
            allowed = protocol_outputs.get(relative, set())
            if not any(call.startswith(item) for item in allowed):
                number = source.count("\n", 0, match.start()) + 1
                raise AssertionError(f"direct server output: {path.relative_to(ROOT)}:{number}: {call}")
        checked += 1
    print(f"source guard: PASS ({checked} server source files)")


def launch(mode, report):
    readers = []
    writers = []
    for _ in range(2):
        reader, writer = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        readers.append(reader)
        writers.append(writer)
    process = subprocess.Popen([BUN, str(CHILD), mode, str(report)],
        stdin=subprocess.DEVNULL, stdout=writers[0], stderr=writers[1], close_fds=True)
    for writer in writers:
        writer.close()
    return process, readers


def read_all(sock, destination):
    chunks = []
    try:
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
    finally:
        sock.close()
    destination.append(b"".join(chunks).decode())


def check_pause(folder):
    report = folder / "pause.json"
    child, readers = launch("pause", report)
    started = time.monotonic()
    try:
        time.sleep(3)
        outputs = [[], []]
        threads = [threading.Thread(target=read_all, args=(reader, output), daemon=True)
                   for reader, output in zip(readers, outputs)]
        for thread in threads:
            thread.start()
        child.wait(timeout=3)
        for thread in threads:
            thread.join(timeout=2)
            assert not thread.is_alive(), "output reader did not finish"
        assert child.returncode == 0, f"child exited {child.returncode}"
        result = json.loads(report.read_text())
        ticks = result["ticksAtPause"]
        assert ticks >= 240, f"10 ms timer fell below 80% during the 3 s pause: {ticks} ticks"
        assert result["rssGrowth"] < 32 * 1024 * 1024, f"RSS grew {result['rssGrowth']} bytes"
        assert result["counters"]["stdout"]["dropped"]["info"] > 0, "ordinary drops were not counted"
        stderr = [json.loads(line) for line in outputs[1][0].splitlines()]
        reserved = [i for i, row in enumerate(stderr) if row.get("marker") == "reserved-error"]
        summaries = [i for i, row in enumerate(stderr) if row.get("event") == "log_lines_dropped"]
        assert len(reserved) == 1, f"expected one reserved error, got {len(reserved)}"
        assert len(summaries) == 1 and summaries[0] > reserved[0], "one summary must follow the reserved error"
        assert stderr[summaries[0]]["error"] > 0, "evicted errors were not counted"
        print(f"paused reader: PASS (ticks={ticks}, RSS growth={result['rssGrowth']} bytes, "
              f"ordinary drops={result['counters']['stdout']['dropped']['info']}, "
              f"reserved error=1, stderr summaries=1, elapsed={time.monotonic()-started:.2f}s)")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        for reader in readers:
            reader.close()


def check_exit(folder):
    report = folder / "exit.json"
    child, readers = launch("exit", report)
    started = time.monotonic()
    try:
        child.wait(timeout=1)
        assert child.returncode == 0, f"exit child returned {child.returncode}"
        result = json.loads(report.read_text())
        assert result["counters"]["stdout"]["currentlyBlocked"], "exit was not tested against a blocked stream"
        print(f"blocked exit: PASS ({time.monotonic()-started:.2f}s, reader remained paused)")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        for reader in readers:
            reader.close()


if __name__ == "__main__":
    assert os.path.isfile(BUN), f"server Bun runtime missing: {BUN}"
    source_guard()
    with tempfile.TemporaryDirectory(prefix="bounded-logging-") as directory:
        folder = Path(directory)
        check_pause(folder)
        check_exit(folder)
