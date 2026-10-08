**Verdict: SHIP.** Both blockers are fixed, and I re-ran my probe to confirm it. The should-fix items are fixed or documented. I found no regression.

The fixes are commit `eef513c` (the same content as `/tmp/commons-board-fixes.diff`). I tested them with a new probe, `/root/workspace/agent-scripts/board-rereview-probe.ts`, run against an empty commons folder. A type-check showed no errors in the board files.

## Blockers

**1. Posts dropped when an action id is reused: fixed.**
- The event id now hashes `author + sourceInput + board + (thread | 'open') + actionId` (`commons-board.ts:62`).
- In the probe:
  - The same action id in two threads gives different ids, so receipts and `board:<id>:<n>` admissions no longer collide.
  - A later turn reusing `post` writes its new words.
  - A retry from the same run is still a duplicate.
  - A retried thread open still finds the thread it already created.
- Event files written under the old id scheme are only from today; at worst, a retry that spans the deploy writes one extra post. That's negligible.

**2. Deciders and members never matching an author: fixed.**
- `identityOf` (`commons-board-service.ts:39`) turns every `--member` and `--decider` into `concierge:<n>`. A peer address `mac/session:<b64>` becomes `mac:<n>`, and `tejas` is kept as is.
- Mentions keep their original addresses for delivery, as I suggested.
- In the probe:
  - A sealed post stays hidden from the other member.
  - Auto-reveal fires once every member has posted.
  - The named decider can close the thread.
- The reveal and seal checks now run before the claim marker is created, so the order is correct.

## Should-fix items
- **3. Peer mentions:** documented rather than changed. There is a code comment and a line in the design doc. `status.json` now gives `lastFailure` for each pending mention, so the supervisor can see why one is stuck. That meets the "document it" option.
- **4. Sealed words leaking:** fixed. A sealed post's words are left out of the mention notice, the raw path is gone from notices, and the README now has the sentence about not opening other members' sealed files.
- **5. Half-written files:** fixed. The README now says to write a `.tmp` file and then rename it, and rejected copies get a unique timestamp in their name.
- **6. Claim lock:** fixed. The marker is created last, and an existing `claimedBy` is refused. The probe confirmed that a refused sealed claim no longer locks the task.
- **7. Commits and pushes:** fixed. `lab-commons/.gitignore` now ignores `*.tmp`, and a refused push does one `pull --rebase` and pushes again.

## Small follow-ups (not blocking)
- **Peer mention wording:** the notice to a Mac session still says "it owes no sessions reply". It is actually an informational request, so the Mac's stop hook will ask that agent to reply. The text should be different for peer mentions.
- **Pull can fail on a dirty tree:** `pull --rebase` without `--autostash` refuses to run if `BOARD.md` or `status.json` has uncommitted changes at that moment. It sorts itself out on the next change's push, so it's low risk; adding `--autostash` would close it.
- **README wording:** `commons-board.ts:76-77` still calls members and mentions "addresses". Line 72 now says they are written as `concierge:<n>`, so for members, lines 76-77 are out of date.

I put a short note of this verdict in `tmp/reviews/agent-roles-design/52-commons-rereview.md`.
