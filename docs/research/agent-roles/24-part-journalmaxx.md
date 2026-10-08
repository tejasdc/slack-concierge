# journalmaxx's answer to the threads-as-metabolism proposal

Sources: Mac session transcripts at
`/root/transcript-archive/mac-claude-projects/-Users-tejasdc-workspace-obsidian-vault-journalmaxx/3d5c7409-002e-4ec0-b42f-f1a2d4ee351e.jsonl` and
`.../2a45c54a-d09f-41a1-9068-38ff7bd82b2a.jsonl` (both carry an identical `/ingest` spec, discussed live on 2026-09-02 — I could not find content dated 2026-09-20 in `3d5c7409`; its real content runs 2026-08 to 2026-09-07), and
`/root/transcript-archive/mac-claude-projects/-Users-tejasdc-workspace-obsidian-vault-journalmaxx-auto-capture/f57e56ce-9f55-47a1-bbb6-d521ed2fc0d4.jsonl` (thin — see Q4).

## 1. What we discussed, decided, built
On 2026-09-02 Tejas ran his first-ever full vault review: *"it's been a while... this is going to be my first potential review... I have not even looked at all of the notes that you have been ingesting."* He rejected the existing tag scheme outright: *"I think we should also improve how we're taking atomic notes and like the kind of tags... I think this is completely bullshit... That's not a good model at all."* That session decided: drop `#type/*`/`#area/*` tags for evergreen notes, keep them only for the daily atom stream, and adopt typed frontmatter fields read by the Breadcrumbs + Wikilink Types plugins — chosen live over three alternatives (raw tags, inline `key::` fields, a since-rejected "Typed Links" plugin). Six-pair vocabulary: `part_of`/`contains`, `seed`/`sprouted`, `supports`/`supported_by`, `contradicts` (symmetric, *kept unresolved on purpose*), `next`/`prev`, `example_of`. Structural hierarchy: **note ⊂ thread ⊂ project**, with plain project fields `desire`, `fear`, `status` (active/parked/someday/done), `kind` (note/thread/project/list). Driving principle, his words: *"Why are we doing things that agents can automate?"* — so the ingest agent, not Tejas, lifts `desire`/`pattern` evidence from daily notes up into the project note.

Separately, the `/ingest` command (running code, not a proposal) defines the atom unit: `- [rN] <sentence>. #type/<t> #<namespace>/<value> [status:: provisional] [provenance:: inferred] [day:: YYYY-MM-DD]`, inferred in real time per capture (*"Tejas can't wait; if atoms don't surface in real-time he won't use the tool"*), later promoted to a permanent block ID on endorsement.

## 2. What contradicts or would break
**Naming collision, not just loose overlap.** The proposal's "thread" (the top-level unit of attention) is journalmaxx's **project**; journalmaxx's own "thread" is a smaller unit nested *inside* a project. Reusing "thread" verbatim in this vault collides with a vocabulary already shipped in Breadcrumbs/Dataview configs.
**No "blocks"/"merged-into" analog.** The nearest typed link, `contradicts`, was deliberately built to *stay open*, the opposite intent of a link meant to force resolution.
**No salience/decay model exists or was attempted.** The lifecycle here is human-gated (provisional → endorsed via `/review`, strike/rewrite/accept), not automatic fading. A nightly process that "fades all salience a little" has no working precedent to check against here.

## 3. What the proposal should reuse
- The **atom line format and lifecycle** above, verbatim — it's tested and running, not hypothetical.
- The **typed-link vocabulary and its elimination log** (why tags lost, why one plugin was rejected) — `seed`/`sprouted` is a direct model for "spawned-from"; `supports`/`contradicts` for "related-to."
- `projects/<slug>.md` as a working prototype of "the face": already a page Tejas edits directly *and* the agent updates from daily-note evidence — *"Human writes at the point of thought, agent files."*
- The **captured_at routing rule**: atoms land on the day they were dictated, not the day they were processed, specifically so time-windowed consolidation isn't corrupted by late arrivals.

## 4. What's missing, learned the hard way
No "TFC" tag or extreme-capture scenario turned up anywhere — I grepped every session file (word-boundary) in both directories and found none; that detail likely belongs to a different project. The auto-capture companion is thin: its one archived session is a 2026-09-01 bug fix (*"why is every agent running creating empty daily notes even when there are no voice recordings for the day?"*), not a burst-splitting design discussion — don't cite this project as prior art for "splitting bursts." The real hard-won lesson is the captured-at routing rule above: the proposal's "sleep" replay must key off original capture time or it will corrupt exactly like an un-routed backfill would have here. Second: before shipping automatic salience decay, ask what fails when Tejas skips a week of review — this project's whole 09-02 crisis was an unreviewed backlog, and decay dressed up as "help" could quietly bury exactly what an ADHD user forgot to look at.
