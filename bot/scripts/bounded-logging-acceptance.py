#!/usr/bin/env python3
"""Standalone Bun socket backpressure acceptance; run from any working directory."""
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
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


def check_oversized(folder):
    report = folder / "oversized.json"
    child, readers = launch("oversized", report)
    try:
        outputs = [[], []]
        threads = [threading.Thread(target=read_all, args=(reader, output), daemon=True)
                   for reader, output in zip(readers, outputs)]
        for thread in threads:
            thread.start()
        child.wait(timeout=3)
        for thread in threads:
            thread.join(timeout=2)
            assert not thread.is_alive(), "oversized output reader did not finish"
        assert child.returncode == 0, f"oversized child exited {child.returncode}"
        result = json.loads(report.read_text())
        stdout = outputs[0][0].splitlines(keepends=True)
        stderr = outputs[1][0].splitlines(keepends=True)
        assert len(stdout) == len(stderr) == 1, "expected one complete record per stream"
        normal = json.loads(stdout[0])
        marker = json.loads(stderr[0])
        assert normal["event"] == "logging_acceptance_normal" and normal["message"] == "é"
        assert "truncated" not in normal, "normal record changed"
        assert stdout[0] == json.dumps(normal, ensure_ascii=False, separators=(",", ":")) + "\n", "normal bytes changed"
        assert len(stdout[0].encode()) <= result["cap"]
        assert len(stderr[0].encode()) <= result["cap"], "marker exceeded record cap"
        assert marker["event"] == "logging_acceptance_oversized"
        assert marker["level"] == "error" and marker["ts"]
        assert marker["truncated"] is True and marker["originalBytes"] > result["cap"]
        assert result["counters"]["stderr"]["truncated"]["error"] == 1
        print(f"oversized record: PASS (cap={result['cap']} bytes, marker={len(stderr[0].encode())} bytes, "
              f"original={marker['originalBytes']} bytes, counted=1)")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        for reader in readers:
            reader.close()


def check_closed(folder):
    report = folder / "closed.json"
    child, readers = launch("closed", report)
    try:
        deadline = time.monotonic() + 2
        while not Path(f"{report}.ready").exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert Path(f"{report}.ready").exists(), "child did not open its streams"
        for reader in readers:
            reader.close()
        child.wait(timeout=3)
        assert child.returncode == 0, f"closed child exited {child.returncode}"
        result = json.loads(report.read_text())
        for output in ("stdout", "stderr"):
            assert result["counters"][output]["streamFailures"] == 1, f"{output} failure not counted"
        assert result["counters"]["stdout"]["dropped"]["info"] == 1, result
        assert result["counters"]["stderr"]["dropped"]["error"] == 1, result
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        for reader in readers:
            reader.close()

    report = folder / "throw.json"
    child, readers = launch("throw", report)
    try:
        child.wait(timeout=3)
        assert child.returncode == 0, f"throw child exited {child.returncode}"
        result = json.loads(report.read_text())
        for output, level in (("stdout", "info"), ("stderr", "error")):
            assert result["counters"][output]["streamFailures"] == 1
            assert result["counters"][output]["dropped"][level] == 1
        print("closed streams: PASS (real closed stdout/stderr, EPIPE and ERR_STREAM_DESTROYED "
              "synchronous throws, asynchronous error events; no caller throw or unhandled error)")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        for reader in readers:
            reader.close()


if __name__ == "__main__":
    assert len(sys.argv) == 1 or sys.argv[1:] == ["--source-guard"], "usage: bounded-logging-acceptance.py [--source-guard]"
    if sys.argv[1:] == ["--source-guard"]:
        source_guard()
        sys.exit(0)
    assert os.path.isfile(BUN), f"server Bun runtime missing: {BUN}"
    source_guard()
    with tempfile.TemporaryDirectory(prefix="bounded-logging-") as directory:
        folder = Path(directory)
        check_oversized(folder)
        check_closed(folder)
        check_pause(folder)
        check_exit(folder)
