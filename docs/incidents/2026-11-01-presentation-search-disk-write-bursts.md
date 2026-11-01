---
failure: The presentation worker rewrote gigabytes of its search database in a minute and delayed other services' logs.
date: 2026-11-01
fix_commits: []
cause_status: measured-projection-amplification
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
merges was not measured directly.

The first installed search-merge change did not resolve sustained writes: six
20-second worker samples still measured 98–228 MB/min. A bounded indexed lookup
then found that 516 of the 1,038 retained topics depend on the Inbox router
session. One change to that session marks all 516 topics dirty. Those topics
hold 80,891 bytes of search text, 1,609,685 bytes of topic summaries and
overviews, 5,931,326 bytes of item rows, 3,508,795 bytes of question rows,
and 4,525,660 bytes of retained chunks: about 15.7 MB of logical content.
Before this repair, every dirty topic deleted and recreated its children and
both FTS entries even when its projected content did not change. This is a
measured per-event amplification path; the precise WAL share of each child
table remains unknown. Recent change notifications named only individual
topics, confirming most dependency revisits were not visible changes.

## Fix

The existing presentation worker disables automatic and immediate crisis merges
for the large trigram search index. It performs a 512-page merge between replay
batches after 250 indexed changes or ten seconds, whichever comes first. The
change-count trigger keeps a fast rebuild from accumulating too many segments.
Search content, source custody, and the single worker writer are unchanged.
The topic writer now stages a topic's projected rows and retained detail,
compares a fingerprint of the full result with the last stored projection, and
performs no SQLite mutation for an identical result. Changed topics retain the
same children and references. Their topic FTS entries are replaced only when
the searchable text changes. Existing rows receive a fingerprint on their
first subsequent visit; this can cause one initial child rewrite after deploy.

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
