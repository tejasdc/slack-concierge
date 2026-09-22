#!/usr/bin/env python3
"""Count how Claude Code sessions handed work to other models in a time window.

Reads provider transcripts (the box's live directory plus both machines' copies
in the transcript archive) and prints one row per session: its own model, the
sub-agents it started and with which model, `codex exec` runs, `claude -p` runs,
session requests, web research, and `Escalated:` lines in its answers. The rule
being checked is the global instructions' Model selection section.

    scripts/model-use-audit.py --since 2026-09-21T20:00 [--until ...] [--project thinkering]
"""
import argparse
import collections
import glob
import json
import os
import re

ROOTS = [
    os.path.expanduser("~/.claude/projects"),
    "/root/transcript-archive/claude-projects",
    "/root/transcript-archive/mac-claude-projects",
]


def transcripts(project):
    newest = {}
    for root in ROOTS:
        for path in glob.glob(os.path.join(root, "*", "*.jsonl")):
            if project and not os.path.basename(os.path.dirname(path)).endswith(project):
                continue
            name = os.path.basename(path)
            if name not in newest or os.path.getsize(path) > os.path.getsize(newest[name]):
                newest[name] = path
    return newest.values()


def text_of(content):
    if isinstance(content, str):
        return content
    return " ".join(part.get("text", "") for part in content or [] if isinstance(part, dict))


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
                delegated["agent:" + (args.get("model") or "inherited")] += 1
            elif name in ("WebSearch", "WebFetch"):
                counts["web_research"] += 1
            elif name == "Bash":
                command = args.get("command", "")
                if re.search(r"\bcodex\b.*\bexec\b", command):
                    model = re.search(r"(?:-m|--model)[ =](\S+)", command)
                    delegated["codex:" + (model.group(1) if model else "default")] += 1
                if re.search(r"\bclaude\b.*(?:-p|--print)\b", command):
                    model = re.search(r"--model[ =](\S+)", command)
                    delegated["claude-cli:" + (model.group(1) if model else "default")] += 1
                if "sessions ask" in command:
                    counts["session_requests"] += 1
    return own_models, delegated, counts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", required=True, help="UTC ISO prefix, e.g. 2026-09-21T20:00")
    parser.add_argument("--until")
    parser.add_argument("--project", help="project folder suffix, e.g. thinkering")
    options = parser.parse_args()
    for path in sorted(transcripts(options.project), key=os.path.getmtime):
        own, delegated, counts = audit(path, options.since, options.until)
        if not own:
            continue
        host = "mac" if "-Users-" in path else "box"
        project = os.path.basename(os.path.dirname(path)).split("workspace-")[-1]
        session = os.path.basename(path)[:8]
        print(f"{host} {project} {session} model={dict(own)} delegated={dict(delegated)} {dict(counts)}")


if __name__ == "__main__":
    main()
