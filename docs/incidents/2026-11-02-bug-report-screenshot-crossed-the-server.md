---
failure: A thnkr.ing bug-report screenshot on his Mac travelled up to the server and back before it appeared, taking seconds for a system call that takes a fraction of one.
date: 2026-11-02
fix_commits: []
cause_status: confirmed
---

# S in a bug report took far longer than Control-Space

## What was seen

Tejas, thnkr.ing bug report of 2026-11-02 00:45 ET (capture 59ef334b): "How is a screenshot
depending on the server? … It's a lot faster when I do Control-Space." The recorded whole-screen
shot took 5.2 s from the key to the picture in the report.

## Cause

The page could reach thnkr.ing Capture on the Mac only through the server's relay: 1.2 s for the
request to reach the server, 0.4 s for the system call, 2.6 s uploading the 1 MB picture and about
1 s bringing it back. This Mac's live speech listener already offered the page a loopback route
with a trusted certificate, and nothing used it for screenshots. Full account in thnkr.ing's
failure ledger, case `thinkering-bug-report-screenshot-crossed-the-server`.

## Fix

The live speech listener answers `/screen/v1/shots` (`bot/src/local-screenshot.ts`): it asks
thnkr.ing Capture through `thnkring-capture://report-shot` to write the picture into a private
temporary folder and returns its bytes to the page. A Capture app that never marks the job started
within 4 s answers 503, and the page uses the server relay.

## Acceptance scenario

- **Seed:** A Mac with Concierge's speech listener running and a thnkr.ing Capture build that knows
  `report-shot`.
- **Action:** POST `/screen/v1/shots` `{"kind":"screen"}` on 127.0.0.1:8791 with Origin
  `https://thnkr.ing`.
- **Expected:** a `200 image/png` answer within about a second and a `local_screenshot` log line
  with `outcome: image`; with an older Capture app, `503 CAPTURE_APP_UNAVAILABLE` within 4 s.
- **Replayable offline:** yes, with a stand-in for macOS `open` that writes the start mark, the
  picture and the result file as the Capture action does.
