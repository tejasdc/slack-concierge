---
failure: A server Reader check sent routine desktop browser work to Tejas's Mac and disturbed his work.
date: 2026-10-30
fix_commits: []
cause_status: confirmed
---

# Server browser checks ran on Tejas's Mac

## What was seen

At about 01:14 ET, Tejas saw an agent opening things in Chrome on his Mac and an iPhone Simulator. His Mac owner ledger shows one active agent session at that time, session 223. Its two requests from server session 7545 explicitly asked for desktop browser checks on the Mac alongside real iPhone Safari touch checks. At 01:13:35 ET, the Mac session called a Playwright browser tool. The activity event stream recorded neither that browser call nor the Simulator commands. The specific Chrome window the tool used was not independently identified. The server's direct link-opening ledger had no order since October 12, so that route was not the October 30 source.

## Cause

The server request treated desktop browser verification and native iOS touch verification as one Mac assignment. The former was server-capable; the latter needed Apple's simulator. Existing peer creation required a nonempty free-text reason, but addressed Mac work and local Mac session creation did not. The existing Mac activity classifier did not recognize the Playwright tool or Simulator commands, and there was no managed provider tool refusal for a Mac browser check.

## Fix

The accepting Mac owner now requires a structured physical need for new and addressed work, including local agent requests. The shared managed pre-tool hook refuses agent browser and foreground app control on the Mac, and allows background Simulator command-line work only when the accepted request names native iOS behavior. The direct link opener now requires the current accepted human input. Browser verification and Thinkering guidance route desktop and phone-sized checks to the server. The Mac activity classifier records browser and Simulator tool starts. The diagnostic snapshot helper also works with macOS Python, which exposed the Mac ledger evidence safely during this investigation.

## Acceptance scenario

- **Seed:** A server agent with an accepted work request, a registered Mac peer, and an isolated Reader page with both desktop and native iOS selection behavior.
- **Action:** The agent asks for Mac work without a physical need, then an admitted Mac turn attempts Playwright or a foreground Chrome launch; separately, a request with `ios-native` runs background Simulator commands.
- **Expected:** The first Mac request and the browser or foreground calls are refused before use. Native iOS command-line work is admitted with its reason. A desktop viewport check runs on the server. Mac activity records identify any allowed browser or Simulator tool start.
- **Replayable offline:** yes (owner admission and managed tool decisions); actual desktop focus and native selection require a Mac observation.
