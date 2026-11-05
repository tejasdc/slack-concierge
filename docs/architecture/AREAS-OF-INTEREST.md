# Areas of interest

Tejas browses an area such as **Sleep cycle** and sees the Inbox threads about it, even when a thread has an unrelated title. An area groups threads; a thread can belong to several areas. Threads still own their sessions, requests, messages, and lifecycle. The stored name `inbox_topics` continues to mean threads and never names an area.

## Authority and identity

Concierge owns `inbox_areas`, `inbox_area_threads`, and `inbox_area_neighbors` in its ledger. Area IDs and topic IDs are immutable; names are attributes. Membership is one row per area/thread pair. A neighbor is one explicit undirected edge, stored with sorted area IDs. Edges record who placed them and why. Shared area membership is a navigation fact, not evidence that two sessions worked together; the Mutuals search projection does not consume it.

Agent and human changes retain an action input and an owner event in the same transaction as their projection rows. The area events can rebuild the projection. A thread creation event carries its area links so creation and placement commit together. Agent-created threads require one to eight existing area IDs. The router can ask for name-based suggestions before creation, choose an existing area or create one, then provide `--area` on `sessions topics create`. The suggestion is advisory; explicit membership is the authority. Tejas's thread creation also supplies `areaIds`. Splitting a thread inherits its areas; merging carries source memberships to the destination. Owner-created service-notice threads use **System notices**.

## Reads and controls

The isolated presentation worker copies changed area records and edges into a disposable projection. `GET /sessions/v1/presentation/areas` pages areas in name order, with an indexed prefix query. `GET /sessions/v1/presentation/areas/:id` pages the area's threads and returns its neighboring areas. The thread cards come from the existing prepared thread projection; changing a thread title or summary needs no duplicate area copy. Reads return coverage while the worker catches up. Each read has a declared response and storage budget and a growth fixture.

An area page also returns each displayed thread's first three *other* area memberships and the complete other-area count. This lets the page mark overlap without multiplying requests per thread; the full reverse list is `GET /sessions/v1/presentation/topics/:id/areas`, paged by the area's stable name and ID. The disposable membership projection carries the existing placement reason so the browser can label `Filed by meaning:` links as inferred. Membership remains keyed by stable IDs, and area names resolve at read time. A name change therefore changes every visible label through one area row, without rewriting the threads or links. These reads never turn a shared area into a mutual work event.

The authenticated human surface creates areas at `POST /sessions/v1/inbox/areas` and changes one at `POST /sessions/v1/inbox/areas/:id/actions`. Every write needs a stable `clientActionId`. Action kinds are `rename`, `summary`, `link`, `unlink`, `neighbor`, and `unneighbor`. Agent commands use `sessions areas` with exact source input/run and stable action ID. `sessions areas suggest --title ...` reports matching names, with its scan coverage, before the router places a new thread. There is no area-derived session ranking or independent area store in Thinkering.

## Cost and recovery

Create or remove one membership touches one indexed edge. Rename touches one area row. Read an area page touches at most 20 thread cards and 20 neighbors. Rebuild runs off the accepting owner loop in bounded pages; each changed edge projects by its exact stable key. A name search uses the area name index. The growth fixture exercises 100, 1,000 and 10,000 areas and a 10,000-thread area. An interrupted worker resumes from the presentation change journal or rebuilds its disposable generation without losing canonical memberships.

The area projection keeps its own format version. When that version changes, the worker refreshes only area rows and edges in bounded pages before declaring area reads complete. This recovers previously consumed changes without rebuilding unrelated session or message history.

The first backfill starts with Sleep cycle and the scattered threads Tejas identified. Existing threads outside that area are left intact; their associations can be added through the same exact-ID command. A broad inferred backfill would invent interests and should be reviewed from his actual words and thread contents.

## Filing by meaning

Tejas, 2026-11-01: "why are these threads not getting entangled automatically, instead of relying on me to remember?" The router files a new thread by where its work lands; `bot/src/area-filing.ts` adds the theme areas it belongs to by meaning, with no question to him.

**When.** Every live topic change that can alter a thread's meaning (created, renamed, re-summarised, placed, routed, merged, reopened) names the thread to the filer, which runs two seconds later in the background. No clock: the only other pass is once at startup, over every open thread, so changes made while Concierge was down are filed too. The filer runs on the accepting owner, but its work is one embedding call per changed text (cached by exact words in `meaning-index.db`'s `documents` table) and a few hundred dot products.

**How.** A thread's text is its title plus the first two captured messages placed in it (his own words; thread summaries describe agents' activity, not the idea). It is embedded with the session search's EmbeddingGemma engine and compared with every other open thread. It joins an area when at least 2 of its 6 nearest threads (similarity at least 0.53) are already in that area, and that share is at least 3 times the area's share of all open threads. Only memberships chosen by the router or by him count as that evidence; a link the filer made never pulls in the next one. The link is an ordinary `area` event with origin `agent` and a reason beginning `Filed by meaning:` that names the close threads, so he sees why and can unlink it. A pair once linked by meaning, or unlinked by anyone, is never linked again by meaning.

**Why this rule.** The 2026-11-01 dry run over 249 open threads and 16 areas (`agent-scripts/area-meaning-calibrate.ts`) showed that an area's name and summary score its members and strangers alike (0.3–0.6), so a fixed threshold against the area's description cannot work with this model. Neighbours can: the rule above agreed with 15 existing memberships and proposed 18 new ones, nearly all of which a reader would pair (a journal entry about curiosity, the smart-notes habit and finding a meditation into "Doing great work"). The lift keeps a place area such as "thnkr.ing app" (69% of threads) from attracting everything, so themes gather threads and places do not. An area with no members yet attracts nothing until the router or he files its first two.

**New themes.** When a changed thread has at least 3 close neighbours and no area holding at most a quarter of open threads contains half of that group, the filer admits one service notice to the Inbox router listing the group, asking it to make a theme area if they share one idea and to leave them otherwise. Each thread is offered at most once (`area-theme-offered:<topic>` events).

## Earlier work for a thread

Tejas, 2026-11-01, after he connected "invest in a startup that employs me" with IdeaFlow only in the shower: "our system didn't notify me either ... showcase these connections." In the same pass as area filing, `bot/src/earlier-work.ts` links each changed thread, as a whole, to the strongest earlier things he thought about it: his sessions through the owner's own session search (ChatGPT conversations included), his vault notes (outside `Readwise`, `tmp`, `archive` and `templates`), and his other open Inbox threads.

**Per thread, his words only (2026-11-05).** The first version posted under every captured message and searched up to 14 windows of it. Tejas judged it close to useless ("why are we breaking up our text here? ... Why can't you do it for ... the entire thread at once? ... restrict it to the exact messages that is actually relevant"). Measured then: 371 posts and 717 links; 100 links found by a bug report form's own lines; agent-written alerts filed into his threads linked as if they were his; none of 264 links he could see ever opened. Now:

- The question is the text of his own captured messages in the thread (origin human), with a bug report's form scaffolding removed by the same rule as thnkr.ing's `captureWords`. The router-written title and agents' messages are not used.
- One search covers the whole text. At most two extra passages run, each naming something in the vault's `bio/standing-facts.md`, because the whole-thread question can drown them out (the IdeaFlow case). So each run makes at most three owner searches, down from fourteen per message.
- A thread is searched again only when his words in it change. The post's identity is the thread plus a digest of those words, and the thread's Work view shows only the newest one. Up to three links, each quoting the sentence of his that shares the most words with it.
- Each run logs `earlier_work_linked` with `durationMs` and the number of his messages, so the cost is measured, not guessed.
- Earlier means before his first message in the thread. The Inbox and sessions holding the thread's requests are passed over.

Whether it helps is read from thnkr.ing's usage records (`scripts/earlier-work-usefulness.mjs` in the thinkering checkout). If links are still never opened after a week or two, the panel should be removed.
