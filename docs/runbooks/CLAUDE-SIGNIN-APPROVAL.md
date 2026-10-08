# Claude sign-in approval on the Mac

Use the Mac Codex session's existing Chrome computer-use extension and Thinkering
Accounts. A real server sign-in completed through this path on 2026-10-08; Apple
Events did not work in the same session. No new Chrome-control permission was needed.

## Ownership and invocation

The server owns the pending sign-in, credential storage, account validation and
execution-account selection. The Mac worker drives the browser only. The automatic
trigger belongs to [provider usage](../architecture/PROVIDER-USAGE.md#sign-in-holds).
The worker address is currently `mac/session:WzIsMTAwLDFd`, owned by
`SIGNIN_WORKER` in `bot/src/signin-renewal.ts`.

For an addressed request from a server agent:

```sh
router-actions.sh sessions ask mac/session:WzIsMTAwLDFd \
  --source-input <current-input> --source-run <current-run> \
  --action-id <stable-action> --summary 'Renew the requested Claude sign-in' \
  -- 'Renew tejas@chann.app through This server in Thinkering Accounts, using Chrome computer use. Reply with the verified result; never put a sign-in link or code in the reply.'
```

The request names the account only. The worker opens its own tab at thnkr.ing,
opens Settings → Provider accounts → Open provider accounts, and starts or continues
the intended sign-in in **This server**, not Your Mac. Never start another pending
sign-in while one is already being handled. Verify the exact address displayed by
Claude against the request before Authorize.

If Claude shows a different account, use **Switch account → Continue with Google**,
select the exact saved account, and complete the existing sign-in. Recheck the
Claude account label after returning. A mismatch is a normal step, not a reason
to ask Tejas. A password, second factor or expired saved login that the worker
cannot complete is the actual human handoff.

After Authorize, use Claude's Copy code button and the browser session clipboard
to fill **Paste the code from that page** in the existing Accounts dialog, then
press Done. The extension clipboard is not macOS's pasteboard: `pbpaste` was empty
in the live check. Keep the code only in memory; do not print page snapshots that
contain it, write it to disk, or carry it in a peer message. Clear the temporary
clipboard value after use. Verify Accounts shows the expected signed-in account
and no pending sign-in before replying. Close only the tabs opened for this work.

## Verified account access

Chrome's **Default / Person 1** profile initially displayed `tejas@chann.app` on
Claude, although its Chrome Google identity was `tejastej.dc@gmail.com`.
The same profile's Google chooser had both saved accounts. Switching to Gmail
completed without a password, and Claude's authorize page then displayed
`tejastej.dc@gmail.com`. Both accounts are reachable through Default; a fixed
one-profile-per-Claude-account mapping would be false. No other person's profile
or existing tab was used.

## Evidence and limits

On 2026-10-08 this Concierge-created Mac Codex session used the Chrome extension
while the screen was locked. It completed a real server renewal as chann, copied
the code directly between browser pages, and verified chann in use with no pending
sign-in and 1% five-hour usage. A separate synthetic authorize page proved switching
from chann to Gmail; Authorize was never pressed on that synthetic flow.
No password or macOS permission prompt appeared. The browser remained signed in
to Gmail after that switch; server credentials remained independent.

The server owner reported the automatic trigger installed through the normal
deployment, with both account homes proven and no expiry notice to act on.
Its first genuine expiry remains the live test of dispatch; no working login was
invalidated to manufacture that test. Browser completion and trigger deployment
must not be reported as proof of an expiry that has not happened.

## Alternatives

| Path | Evidence and tradeoff for unattended renewal |
| --- | --- |
| Existing Chrome computer use | Real approval and code return passed; saved account switching passed. Reuses the browser and peer requests, but requires the Mac and extension to be available. |
| Apple Events helper | A shell entry point exists, but its live dry run timed out before tab creation. Full code extraction and account switching are unproven. No OS permission change is needed for the working extension path. |
| New custom extension or bridge | Could provide a deterministic narrow command; adds installation and ownership. No missing capability currently justifies that extra component. |
| Manual Accounts sign-in | Existing fallback when saved browser login really expires; requires Tejas each time, contrary to the routine renewal goal. |

The retained experimental command is `~/.local/bin/approve-claude-signin --dry-run`
(or `bun bot/scripts/approve-claude-signin.ts --dry-run` from source), with stdin JSON
`{"url":"<pending authorize URL>","account":"<expected email>"}`. It is not the
automatic worker's execution path. Earlier documentation incorrectly presented
it as proven and treated a recorded TCC denial as enough to conclude a permission
prompt was required. Observed facts were AppleEvent timeouts and no new prompt;
the extension needed no permission change.
