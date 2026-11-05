---
failure: An agent's reading link to an Android source page was reported as a file link that would not open, so the agent filed an issue saying the reading was broken.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# A working source-page reading link was reported as unopenable

## What was seen

On 2026-11-05 at 04:10 UTC a final reply in an Inbox thread linked
`https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android16-release/core/res/AndroidManifest.xml`
as a reading. The reply was posted, but its result carried `unopenable_links` with the path
`/refs/heads/android16-release/core/res/AndroidManifest.xml`. The posting agent filed an issue
report saying the AOSP reading could not open in thnkr.ing's reading view. In fact thnkr.ing had
already fetched and stored the page (35,293 words, 0.99 parse confidence) as an offered reading.

## Cause

The post/reply link check (`unopenableLinks` in `bot/src/workspace-files.ts`) finds absolute
paths with a lookbehind that excludes word characters, `:`, `/`, `.`, `~` and `-`. Gitiles
addresses put `+` before `/refs/…`, so the search started a "path" inside the web address and
the viewer read correctly refused it as missing.

## Fix

Web addresses are blanked out of the text before the path search, so no character inside one
can start a path. This replaces enumerating characters in the lookbehind.

## Acceptance scenario

- **Seed:** a post text containing the Markdown link above, a bare
  `https://android.googlesource.com/…/+/refs/heads/main/services/Foo.java`, and a missing
  `/root/workspace/thinkering/tmp/does-not-exist.md`.
- **Action:** run `unopenableLinks(text, '/root/workspace')`.
- **Expected:** only the missing `/root/…` file is returned; neither web address contributes a path.
- **Replayable offline:** yes
