# Areas of interest

Tejas browses an area such as **Sleep cycle** and sees the Inbox threads about it, even when a thread has an unrelated title. An area groups threads; a thread can belong to several areas. Threads still own their sessions, requests, messages, and lifecycle. The stored name `inbox_topics` continues to mean threads and never names an area.

## Authority and identity

Concierge owns `inbox_areas`, `inbox_area_threads`, and `inbox_area_neighbors` in its ledger. Area IDs and topic IDs are immutable; names are attributes. Membership is one row per area/thread pair. A neighbor is one explicit undirected edge, stored with sorted area IDs. Edges record who placed them and why. Shared area membership is a navigation fact, not evidence that two sessions worked together; the Mutuals search projection does not consume it.

Agent and human changes retain an action input and an owner event in the same transaction as their projection rows. The area events can rebuild the projection. A thread creation event carries its area links so creation and placement commit together. Agent-created threads require one to eight existing area IDs. The router can ask for name-based suggestions before creation, choose an existing area or create one, then provide `--area` on `sessions topics create`. The suggestion is advisory; explicit membership is the authority. Tejas's thread creation also supplies `areaIds`. Splitting a thread inherits its areas; merging carries source memberships to the destination. Owner-created service-notice threads use **System notices**.

## Reads and controls

The isolated presentation worker copies changed area records and edges into a disposable projection. `GET /sessions/v1/presentation/areas` pages areas in name order, with an indexed prefix query. `GET /sessions/v1/presentation/areas/:id` pages the area's threads and returns its neighboring areas. The thread cards come from the existing prepared thread projection; changing a thread title or summary needs no duplicate area copy. Reads return coverage while the worker catches up. Each read has a declared response and storage budget and a growth fixture.

The authenticated human surface creates areas at `POST /sessions/v1/inbox/areas` and changes one at `POST /sessions/v1/inbox/areas/:id/actions`. Every write needs a stable `clientActionId`. Action kinds are `rename`, `summary`, `link`, `unlink`, `neighbor`, and `unneighbor`. Agent commands use `sessions areas` with exact source input/run and stable action ID. `sessions areas suggest --title ...` reports matching names, with its scan coverage, before the router places a new thread. There is no area-derived session ranking or independent area store in Thinkering.

## Cost and recovery

Create or remove one membership touches one indexed edge. Rename touches one area row. Read an area page touches at most 20 thread cards and 20 neighbors. Rebuild runs off the accepting owner loop in bounded pages; each changed edge projects by its exact stable key. A name search uses the area name index. The growth fixture exercises 100, 1,000 and 10,000 areas and a 10,000-thread area. An interrupted worker resumes from the presentation change journal or rebuilds its disposable generation without losing canonical memberships.

The first backfill starts with Sleep cycle and the scattered threads Tejas identified. Existing threads outside that area are left intact; their associations can be added through the same exact-ID command. A broad inferred backfill would invent interests and should be reviewed from his actual words and thread contents.
