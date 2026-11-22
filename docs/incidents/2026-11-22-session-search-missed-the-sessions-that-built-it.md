---
failure: Session search and the request brief's earlier-work lookup did not find the Mac Codex sessions that built tejas.nyc's signal visualization when asked by subject.
date: 2026-11-22
fix_commits: [03a5f30b, 76c5972d]
cause_status: confirmed
---

# Search could not find the sessions that built the site's visualization

## What was seen

Tejas asked which album inspired the signal visualization on tejas.nyc and to text its cover to
Rohan. The messaging agent found "no source on the server" and the send check demanded evidence.
The sessions that built it exist as Mac Codex transcripts from July 22–24 and September 16
(the "pattern lab", weave/06 "signal-register", "Unknown Pleasures x textile"). A search for
"Unknown Pleasures" "signal register" "pattern lab" returned none of them; the request brief's
earlier-work list named unrelated sessions. Tejas: "Our session searches not bringing up the
session. Session would actually built it. If so, that's a real problem here."

## Cause

- The search command joined the quoted concepts with spaces, and every word search requires all
  of its words in one message, so the search required "unknown", "pleasures", "signal",
  "register", "pattern" and "lab" in one message. Only messages retelling the incident matched.
- Archived transcripts got only the result slots native sessions left: with ten results and ten
  native matches, archive matches were dropped with an omission line.
- The earlier-work lookup kept an archive meaning match only when the transcript was already
  imported as a session, so a never-imported Mac transcript could not appear.

## Fix

Concepts travel one per line and each is searched on its own; ranked lists are fused by
reciprocal rank; the archive examines up to the limit (at most 20) on its own; the earlier-work
lookup imports a closely matching transcript through the owner's search import path.

## Acceptance scenario

- **Seed:** the archive holds the Mac Codex pattern-lab transcripts; newer native sessions mention
  every word of the query.
- **Action:** `sessions search -- "Unknown Pleasures" "signal register" "pattern lab"`.
- **Expected:** pattern-lab Codex transcripts appear with word evidence, not only meaning matches,
  and no omission says archive candidates were cut because native results filled the limit.
- **Replayable offline:** no (needs the archive index and the meaning engine)
