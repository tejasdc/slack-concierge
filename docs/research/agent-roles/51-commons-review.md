**Verdict: NO-SHIP.** Two defects make the board fail at its own core jobs: posts can be silently lost, and proposal rounds don't work as designed. Both have small fixes, and the store design is otherwise sound.

I read the four files plus the parts of the owner they call (how session addresses are resolved, how inputs are admitted, how a live run is checked, how a peer address is split). I confirmed the event-id findings and the reveal refusal with a probe against a temporary commons folder (`/root/workspace/agent-scripts/board-review-probe.ts`).

## Blocking

### 1. A post is silently dropped when an agent reuses an action id (High, confirmed)
- **Evidence:** `eventId(author, actionId)` (`commons-board.ts:58`) hashes only the author and the action id. There is no board, thread or source run in it.
  - Everywhere else in Concierge an action id is scoped to the source input (for example `session-owner.ts:1327`, `scope:\`session:${sourceInputId}\``). So agents reasonably reuse simple ids like `post` or `reply-1` from turn to turn.
  - In the probe, a later turn posting new words with `--action-id post` in the same thread got back `duplicate:true` and the *old* text ("first"). The new words were never written.
  - Across threads, the same id produces the same event id in two folders. Receipts are keyed `receipts/<event.id>--<n>.json` for the whole board (`:244`, `:250`), so the second thread's mention reads as already delivered and is never sent. The admission input id `board:<id>:<n>` collides the same way.
- **Smallest fix:** hash `author + sourceInput + board + (thread or 'open') + actionId`. A retry from the same run keeps the same source input, so retries stay idempotent. Optionally name receipts by thread as well.

### 2. Deciders and members can never match an author, so sealed proposal rounds don't work (High, confirmed)
- **Evidence:** authors are recorded as `concierge:<n>` (`commons-board-service.ts:32`). The help text tells agents to pass `--decider <address>` and `--member <address>`, and an address is `session:<base64>` (`session-owner.ts:392`). Peer addresses are `mac/session:…`.
  - **Auto-reveal never fires:** `members.every(m => sealedAuthors.has(m))` at `commons-board.ts:160` compares addresses with `concierge:<n>` ids.
  - **A named decider can never reveal or close:** the checks at `:214` and `:219-220` compare `input.author` with `state.decider`. The probe's reveal by a non-owner was refused.
  - Result: only the owner can reveal or close. That brings back the anchoring problem the design's sealed rounds were meant to prevent.
- **Smallest fix:** in `boardCommand`, turn each member, decider and mention into the canonical `concierge:<id>` (or `<peer>:<id>`) before writing, using `resolveSessionAddress` locally and the peer split otherwise. Keep `tejas` as a literal. Keep the original address separately for delivery.

## Should fix (not blocking alone)

### 3. A mention to a Mac session is a request that owes a reply, and it can only be sent while the poster's run is alive (Medium)
- **Evidence:** `askPeer` calls `this.ask(... requestedEffect:'informational')` (`session-communication.ts:640`).
  - That opens a correlated request. The Mac agent's reply-owed stop hook will send it back to reply, and the reply returns to the poster as a new input that wakes it.
  - This contradicts the notice text ("owes no sessions reply") and the design's rule that nobody is interrupted except by a mention.
  - `ask` also calls `actor()`, which needs the poster's run to still be live (`session-communication.ts:127-135`). So `board sweep` can never re-deliver a peer mention after that run ends; it stays in `pendingMentions` forever.
- **Fix options:**
  - Deliver peer mentions as a service notice through the peer channel, keyed by the event id.
  - Or, minimally, say plainly that peer mentions are delivered once at post time and that peer sessions see them on a board read. Mark them as such in `status.json` so the supervisor doesn't chase them forever.

### 4. A sealed post's words leak through mentions and the raw folder (Medium, requirement fidelity)
- **Evidence:** `mentionText` includes `event.text` in full even when the post is `sealed` (`commons-board-service.ts:38`). The mentioned member reads the hidden position before the reveal.
  - Separately, `read` returns `rawFolder`, and every mention notice prints the raw path. Agents run as root, so a member can `cat` sealed files.
  - The design accepts that sealing is no secret from the supervisor, but this hands the path to the members themselves.
- **Fix:** omit the text from mentions of sealed posts. Add one README sentence: before the reveal, a member must not read other members' sealed files directly.

### 5. A file another process is still writing can be moved to `rejected/` mid-write (Low–Medium, supervisor contract)
- **Evidence:** `readEvents` runs on every read and render. It moves any `.md` that fails to parse (`commons-board.ts:134-143`). The README invites agents to write event files by hand while Concierge is down, but doesn't tell them to write a hidden temporary name and rename it. A plain `cat > x.md` racing a read gets rejected half-written.
- **Fix:** add one README line: write `.<name>.tmp`, then rename. Dotfiles are already skipped. Also give rejected copies a unique suffix: `rename` over an earlier rejection of the same name currently loses it.

### 6. The task claim lock depends on a side file, so it can be left stuck or bypassed (Low)
- **Stuck:** the `.claim` marker is created before the later checks. `claim --sealed` creates the marker, then throws at `:222`, and nobody can ever claim that task.
- **Bypassed:** a claim written by hand while Concierge is down creates no marker, so a later command-line claim by someone else also succeeds. The first file still wins in `threadState`, so the second claimant is misinformed.
- **Fix:** run all validation before creating the marker. Also refuse when `state.claimedBy` is already set.

### 7. Commits can catch half-written files, and a failed push is never retried (Low)
- **Evidence:** `git add -A` runs in a separate process while the owner writes synchronously, so it can pick up `.*.tmp` or `status.json.tmp`. `lab-commons/.gitignore` only ignores `tmp/` and `notes`.
  - It also commits any unrelated edits in that repository.
  - If the supervisor also pushes, a rejected push is only logged and never rebased, so pushes quietly stop.
- **Fix:** add `*.tmp` to that repository's `.gitignore`. On push failure, do `pull --rebase` once, which is safe because the only writes are new files.

## Checked and fine at this scale
- **Event loop:** every write reads everything synchronously four to five times (render, every `THREAD.md`, status, mentions). That is tens of milliseconds for thousands of small files. Acceptable for about nine sessions; the per-turn cost grows with total history, so revisit it if closed threads pile up.
- **Existing behaviour:** the only change outside the new modules is one route in `routed-request-api.ts:67` and the new parser branch. Neither touches the ledger or other operations.
- **Local mention delivery:** it follows the watches pattern (`admit` keyed by a stable input id, which is idempotent; receipt written after admission). A crash between the two is safe.
- **Posts written without identity:** they are never delivered and are logged at warn on every sweep. That matches the stated intent, but `status.json` should mark them "undeliverable: no identity" rather than pending.
- **Supervisor contract:** the status file, atomic writes, rejected files with their reasons, and re-delivery keyed by the event are all present, apart from items 1 and 5.

## Requirement fidelity
The core requirement is met: one visible place, plain files that can be read and repaired without Concierge, and a protected place for deep work, since only a mention wakes anyone.

Three gaps:
- **Unverified:** the board files say Tejas reads `BOARD.md` in thnkr.ing. Nothing in this change publishes `lab-commons` to thnkr.ing.
- **Not built:** his own posting path and the Needs-you item for decisions waiting on him, both in the design. That's fine if declared, but the design doc's header still says "design, not built" and should be updated.
- **Mentions into a busy Claude session:** they join Claude's own message queue rather than waiting for the turn to end, the same as watches. The design says "queued, never steered"; that's acceptable, but the doc should say which it is.

**To flip to SHIP:** fix items 1 and 2. Item 3 should be fixed or documented, and item 4's mention-text change is one line.
