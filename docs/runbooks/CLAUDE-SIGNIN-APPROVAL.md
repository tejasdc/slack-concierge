# Claude sign-in approval on the Mac

The cloud instance obtains a Claude Code paste-code authorize link. A Mac agent runs the
installed `~/.local/bin/approve-claude-signin` helper, sending one JSON object on stdin:

```json
{"url":"https://claude.ai/oauth/authorize?...","account":"tejas@chann.app"}
```

`--dry-run` opens and inspects the authorize page, then closes its tab without clicking
Authorize. On a full run it verifies the exact account Claude shows, clicks the exact
Authorize button, reads one code from Claude's code callback page, and closes its tab.
The one JSON stdout line has `ok`, `account`, and `code` on approval. A dry run also
reports `profile` and `authorized:false`; failure has `ok:false` and a plain `reason`.
Pass the code only to the requesting
sign-in flow. Neither the link nor the code belongs in command arguments, logs, or docs.

The helper accepts only the observed `claude.ai` authorize route for Claude Code's
known OAuth client, paste-code callback, and PKCE flow. It tries Chrome's Default and
Profile 1 one at a time and trusts the account shown by Claude, not Chrome's Google
profile label. On 2026-10-08, a read-only browser check proved Default was signed in
to Claude as `tejas@chann.app`; the Claude profile for `tejastej.dc@gmail.com` remains
unknown. Profile 2 belongs to another person and is outside this helper's scope.
Each attempt opens a new blank Chrome window for the profile, then navigates only its
new tab. Tab and window IDs are captured before navigation so cleanup cannot close a
neighboring tab. The callback must carry the original sign-in's state and exactly one
authorization code. An unexpected page, mismatched state, or ambiguous code is a
failure, never another approval attempt.

The Mac installer copies the helper and builds the existing signed agent-host app with
an Automation purpose string for Google Chrome. macOS recorded the agent host's Chrome
Automation permission as denied on 2026-09-21, so it will not prompt again. On
2026-10-08, from an agent session, Apple Events to Calendar (allowed) answered at once
while Chrome (denied) and apps with no decision hung until the helper's timeout; the
helper checks this before opening any window and reports the setting to turn on:
System Settings → Privacy & Security → Automation → thnkr.ing → Google Chrome.

The Chrome setting “Allow JavaScript from Apple Events” must be enabled in whichever
profile owns the Claude session. The helper requires that setting to inspect the page;
it does not use Accessibility or screen capture.
