---
failure: Concierge refused an agent's authorized inspection of Tejas's thnkr.ing Mac web app as personal-browser control, then rejected the physical unlock request.
date: 2026-11-03
fix_commits: [09245e93, c18a5c18]
cause_status: confirmed
---

# Authorized thnkr.ing Mac app was refused as a personal browser

## What was seen

At 19:52 UTC on November 3, `concierge:8108` asked Tejas to copy unsaved writing out of his already-open thnkr.ing app before updating it. His 6:37 PM ET reply, input `f66f15dd-e251-4537-a9cd-347d0548434b`, explicitly asked why an agent with Computer Use could not do the app action. A Mac Codex agent then tried the installed thnkr.ing Safari web app, bundle `com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792`, for page `faf63877-6536-4ac6-86e9-5d63e03d3369`. Concierge refused the Computer Use call before it ran, saying it could not target Tejas's personal browser. The thnkr.ing failure ledger records this as `concierge-computer-use-refused-his-thnkring-app` (`thinkering/docs/retrospectives/agent-failure-ledger.md`).

After a later exact-app call passed Concierge, Computer Use returned `-10005 cgWindowNotFound` while macOS reported the console locked. The follow-up question asking Tejas to “unlock your physical Mac” was itself rejected by Concierge's only-he-can question check. This was a second cause of stalled recovery, not a reason to hand app or website actions to him.

## Cause

The Mac surface guard matched the word `Safari` in the installed web app's bundle identifier and treated the app as Tejas's personal Safari browser. The Mac request initially retained only a generic Mac-app need, so the guard could not bind the call to his exact app, page, and human authorization. The browser privacy boundary was appropriate; its classification of this authorized app was not. Separately, the physical-device question check did not accept the optional word “physical” in the unlock request, even after the agent had encountered the locked console.

The first repair commit, `09245e9312ad9b8d46368d844245a316e92fe74c`, answered Tejas's report but declared `Failure-record: none`. The unlock repair, `c18a5c18acf3eba20ae7a33267290a28666f8c42`, also declared `Failure-record: none`. This record retrospectively links both fixes to the observed failure.

## Fix

`09245e93` admitted direct read-only Computer Use selection of the exact thnkr.ing web-app bundle only when the accepted Mac-app request named that bundle, the page, and Tejas's authorizing input. Generic Safari and other browsers remained refused. Later owner-recorded handoff repairs preserved that grant across his Inbox unlock reply and work continuations without broadening the app target. `c18a5c18` admitted a question solely to unlock his physical Mac after the agent reached the locked device, while still refusing a question that combined unlocking with an app action such as clicking Save.

**Status of the eight in-memory notes:** No recorded Computer Use call read them. The earlier exact-app calls were either blocked before Computer Use or returned `cgWindowNotFound` while locked. On November 4, after the Mac was unlocked and the later exact-app guard was installed, a direct bundle selection and same-program accessibility/screenshot read reached Computer Use (`mac:274`, retained tool call `call_9aeebe6af2af403387271bb28301a781`). It returned one thnkr.ing window showing the Inbox behind the Deep work gate, not the old page or its eight editors. The Mac agent observed that the original web-app process had exited and a new app and WebContent process were running before that read. This suggests the original process memory did not survive, but the read cannot prove whether some restored copy exists. A separate private IndexedDB snapshot preserves 53 queued commands; it does not establish the contents of the eight memory-only notes. No reload, close, navigation, click, or content mutation was used for this verification.

## Acceptance scenario

- **Seed:** An accepted Mac-app request retains Tejas's exact authorization, the installed thnkr.ing bundle, and page ID. The Mac may be locked.
- **Action:** The agent selects the exact bundle through Computer Use and reads its accessibility state or screenshot. If macOS reports a locked console, the agent asks only for the physical unlock.
- **Expected:** The exact authorized read passes the Concierge guard; generic Safari, another app, and app actions remain refused. The unlock-only question is admitted, while “unlock your physical Mac and click Save” is refused. A Computer Use window error is reported as an OS/backend result, not as a claim that Tejas must perform the app inspection.
- **Replayable offline:** partially (the Mac policy and question boundaries have focused checks; a live window read depends on the physical Mac state).

The successful November 4 Computer Use read established that the scoped route can inspect the current app window. It did not inspect the original page or recover its eight memory-only notes. A later recovery result has not been verified in this record.
