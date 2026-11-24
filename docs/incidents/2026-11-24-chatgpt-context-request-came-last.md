---
failure: A ChatGPT Pro research answer listed the context it was missing only at the end, after doing the work.
date: 2026-11-24
fix_commits: []
cause_status: confirmed
---

# ChatGPT asked for missing context last instead of first

## What was seen

Tejas read a ChatGPT Pro research answer that listed the context it was missing only at its end, after about ten minutes of work.

## Cause

The shared line added to every agent question told ChatGPT to list missing context but to "still give your best answer with what you have". Concierge also appended it after the question, so ChatGPT read it last.

## Fix

The line now comes first and tells ChatGPT to stop and ask when required context is missing, to name optional context as optional at the start, and only then to work.

## Acceptance scenario

- **Seed:** an agent question that lacks a required file.
- **Action:** send it to ChatGPT Pro.
- **Expected:** the reply is only a numbered list of what is needed, and no analysis.
- **Replayable offline:** no (it needs ChatGPT's answer).
