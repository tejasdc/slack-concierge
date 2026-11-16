---
failure: Imported historical sessions advertised consultation without the retained source pins needed to prepare it.
date: 2026-11-13
fix_commits: []
cause_status: confirmed
---

# Imported history advertised consultation without usable source pins

## What was seen

The installed view for `session:WzIsODcxMSwxXQ` identified an imported historical session with `send:false`, a null consultation source, and `consult:true`. An informational ask was invited, then refused with “Consultation requires the exact retained source version and branch boundary.”

## Cause

The public session view derived `consult` from provider availability. Consultation preparation separately required retained source identity, matching source/version pins, a nonempty boundary, and a source context reader; it then verified the returned source identity and historical dialogue evidence. The canonical source adapter also validates its consultation packet version. The view therefore advertised an operation that its own admission path could not prepare.

## Fix

The view now advertises consultation only when the retained source and consultation pins are complete and internally matched and the context reader exists. Its read-only reason names missing or malformed evidence for unavailable, non-ChatGPT historical sessions. Imported history search and display are unchanged. Admission still re-reads and verifies exact source identity, branch, dialogue bytes, and supplied evidence before creating the restricted consultation child. Earlier-work answerability already reads the public capability and therefore stops suggesting consultation for this session.

## Acceptance scenario

- **Seed:** Imported historical session with provider consultation support but no retained consultation pin, as in session 8711; also consider incomplete, mismatched, malformed pins, absent source reader, and a valid retained pin.
- **Action:** Read the session view, find it through earlier-work answerability, search its archive, read history, and attempt consultation where eligible.
- **Expected:** Invalid or absent proof yields `consult:false` with an explicit read-only reason and earlier-work text that does not invite an ask; search and history still work. Complete matching pins and a context reader retain consultation behavior, while admission continues to reject changed source bytes, branch, boundary, or dialogue evidence.
- **Replayable offline:** yes (view eligibility is deterministic from retained metadata and configured source-reader presence; admission retains its exact source checks).
