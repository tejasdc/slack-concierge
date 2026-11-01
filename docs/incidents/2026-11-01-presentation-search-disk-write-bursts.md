---
failure: The presentation worker rewrote gigabytes of its search database in a minute and delayed other services' logs.
date: 2026-11-01
fix_commits: []
cause_status: best-explanation
---

# Presentation search disk write bursts

## What was seen

The server's per-minute owner I/O records rose from roughly 1–4 MB/min to
100–250 MB/min after 15:48 ET, with several 2–6 GB/min bursts. The presentation
worker dominated `concierge-bot.service` writes. During the incident window,
structured log lines from Concierge and Thinkering took up to 7.3 seconds to
reach the journal. Other agent units and a deployment also wrote heavily, so
the presentation worker was a contributor, not the proven sole cause.

## Cause

The prepared search index uses FTS5 trigram segments. Bounded live index seeks
found a 646,284-page segment, about 2.5 GiB, in the search index, while sampled
topic-search segments were under 100 pages. At 20:59 UTC, 41 messages added only
0.05 MiB of text during a reported 4.8 GiB/min burst. SQLite's default FTS5
automatic and crisis merges can rewrite accumulated index segments inside an
insertion. An isolated FTS5 reproduction with 2,500 fixed 4 KiB documents wrote
675 MB under defaults and reached 7.9 MB in a single insertion. Bounded explicit
merges reduced the largest insertion to 1.9 MB; they moved much of the total
write volume to maintenance. The exact share of the live bursts due to FTS
merges was not measured directly, so this is the best supported explanation.

## Fix

The existing presentation worker disables automatic and immediate crisis merges
for the large trigram search index. It performs a 512-page merge between replay
batches after 250 indexed changes or ten seconds, whichever comes first. The
change-count trigger keeps a fast rebuild from accumulating too many segments.
Search content, source custody, and the single worker writer are unchanged.

## Acceptance scenario

- **Seed:** A search index with large retained FTS5 segments and a stream of
  fixed-size new messages, including a fast 10,000-document rebuild.
- **Action:** Apply new messages through the presentation worker while measuring
  process `write_bytes` and testing exact search results.
- **Expected:** Search results stay exact; insertion writes do not include an
  unbounded merge of old segments; merge work stays bounded between batches;
  the installed worker's per-minute write rate and bursts fall under comparable
  event volume.
- **Replayable offline:** yes (the fixed-input FTS5 probe and prepared-search
  growth fixture); live I/O correlation still requires the installed worker.
