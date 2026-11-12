#!/usr/bin/env python3
"""Count how Claude Code sessions delegated work down and escalated it up.

The rule is the `model-selection` skill; the owner's own escalation records and
the usage breakdown ("who used the allowance") are the live counters for model
and helper call shares. This script is the transcript-level view they cannot
give: what a session actually ran, and whether a turn that escalated announced
it with an `Escalated:` line.

Reads every Claude transcript location on this machine — the default live
folder, each signed-in account's live folder, and both machines' copies in the
transcript archive — and prints one row per session: its own model, helpers it
started and on which model, read-only second opinions, ChatGPT Pro asks,
strong-model starts carrying an escalation reason, web research, and
`Escalated:` lines in its answers.

    scripts/model-use-audit.py --since 2026-11-01T00:00 [--until ...] [--project thinkering]
"""
import argparse
import calendar
import collections
import glob
import json
import os
import re
import time

ROOTS = [
    os.path.expanduser("~/.claude/projects"),
    *glob.glob(os.path.expanduser("~/.claude-accounts/*/projects")),
    "/root/transcript-archive/claude-projects",
    "/root/transcript-archive/mac-claude-projects",
]


def transcripts(project, since):
    """Transcripts that can hold a row in the window.

    The archives hold years of both machines' sessions, so a file last written
    before the window cannot contain a row inside it: skipping those by
    modification time is what keeps this runnable over the whole archive.
    """
    floor = calendar.timegm(time.strptime(since[:16], "%Y-%m-%dT%H:%M"))
    newest = {}
    for root in ROOTS:
        for path in glob.glob(os.path.join(root, "*", "*.jsonl")):
            if project and not os.path.basename(os.path.dirname(path)).endswith(project):
                continue
            if os.path.getmtime(path) < floor:
                continue
            name = os.path.basename(path)
            if name not in newest or os.path.getsize(path) > os.path.getsize(newest[name]):
                newest[name] = path
    return newest.values()


def text_of(content):
    if isinstance(content, str):
        return content
    return " ".join(part.get("text", "") for part in content or [] if isinstance(part, dict))


def count_command(command, delegated, counts):
    """Classify one shell command the session ran."""
    if re.search(r"\bcodex\b.*\bexec\b", command):
        model = re.search(r"(?:-m|--model)[ =](\S+)", command)
        named = model.group(1).strip("\"'") if model else "default"
        read_only = "-s read-only" in command or "--sandbox read-only" in command
        delegated[("second-opinion:" if read_only else "codex:") + named] += 1
        if "CODEX_ESCALATION_REASON" in command:
            counts["escalation_reason_starts"] += 1
    if re.search(r"\bclaude\b.*(?:-p|--print)\b", command):
        model = re.search(r"--model[ =](\S+)", command)
        delegated["claude-cli:" + (model.group(1).strip("\"'") if model else "default")] += 1
    if "sessions ask" in command:
        counts["session_requests"] += 1
        if "--provider chatgpt" in command:
            counts["chatgpt_pro_asks" if "--effort pro" in command else "chatgpt_asks"] += 1
        if "--escalation-reason" in command:
            counts["escalation_reason_starts"] += 1


def audit(path, since, until):
    own_models = collections.Counter()
    delegated = collections.Counter()
    counts = collections.Counter()
    for line in open(path, errors="replace"):
        try:
            row = json.loads(line)
        except ValueError:
            continue
        ts = row.get("timestamp") or ""
        if ts < since or (until and ts >= until) or row.get("type") != "assistant":
            continue
        message = row.get("message") or {}
        if message.get("model") and message["model"] != "<synthetic>":
            own_models[message["model"]] += 1
        if re.search(r"^Escalated:", text_of(message.get("content")), re.M):
            counts["escalated_lines"] += 1
        for part in message.get("content") or []:
            if not isinstance(part, dict) or part.get("type") != "tool_use":
                continue
            name, args = part.get("name"), part.get("input") or {}
            if name in ("Agent", "Task"):
                delegated["helper:" + (args.get("model") or "inherited")] += 1
            elif name in ("WebSearch", "WebFetch"):
                counts["web_research"] += 1
            elif name == "Bash":
                count_command(args.get("command", ""), delegated, counts)
    return own_models, delegated, counts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", required=True, help="UTC ISO prefix, e.g. 2026-11-01T00:00")
    parser.add_argument("--until")
    parser.add_argument("--project", help="project folder suffix, e.g. thinkering")
    options = parser.parse_args()
    for path in sorted(transcripts(options.project, options.since), key=os.path.getmtime):
        own, delegated, counts = audit(path, options.since, options.until)
        if not own:
            continue
        host = "mac" if "-Users-" in path else "box"
        project = os.path.basename(os.path.dirname(path)).split("workspace-")[-1]
        session = os.path.basename(path)[:8]
        print(f"{host} {project} {session} model={dict(own)} delegated={dict(delegated)} {dict(counts)}")


if __name__ == "__main__":
    main()
