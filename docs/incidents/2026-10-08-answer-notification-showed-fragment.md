---
failure: Tejas's phone notifications for an agent's answer showed a meaningless fragment such as "1." or "Probably not." instead of what the answer said.
date: 2026-10-08
fix_commits: [fd767c0f]
cause_status: confirmed
---

# Answer notifications showed "1." instead of the answer

## What was seen

On 2026-10-08 (report at 3:27 PM) an agent's answer that opened with a numbered list reached his Lock Screen as
"1." (twice), and the Sonos answer as "Probably not.". History held ten such lines ("Done.", "Fixed and live.",
"You're right.").

## Cause

Confirmed from fd767c0f. When an agent's final answer was filed in his thread (`session-topics.ts`), the reading
item and the notification body took the first sentence after "TL;DR:". A list marker or a short opener is a
complete "sentence" to that cut, so the line carried no content.

## Fix

fd767c0f: new `answer-line.ts` `answerLine` reads the first paragraph of the TL;DR, drops list numbers and
bullets, and keeps sentences until the line says something (80+ characters, at most 240), cutting a long second
sentence rather than stopping at a short opener. `fragmentReason` refuses a router-filed decision under four
words, and a still-short agent line is prefixed with who answered. The reply's `--summary` is deliberately not
used (it is written to the asking agent). `.his-words.json` declares `answerLine` with 45 real answers whose old
line was a fragment (`answer-line-samples.json`); Thinkering's checker runs it at every commit and refused the
old cut on all 45.

## Acceptance scenario

- **Seed:** an agent final answer whose TL;DR starts "1. Yes, the speaker …" and another "Probably not. The
  Sonos …".
- **Action:** the answer is filed in its Inbox thread with a notification.
- **Expected:** the notification body is a readable 80–240 character line with no leading "1." and more than
  the short opener; none of the 45 recorded samples produces a fragment.
- **Replayable offline:** yes (pure function plus the sample file)
