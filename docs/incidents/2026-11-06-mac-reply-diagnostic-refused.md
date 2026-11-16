---
failure: A Mac worker could not quote a Computer Use refusal in its final Concierge reply.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Mac reply diagnostic refused

## What was seen

Mac session 100 tried twice to close an owed sign-in request with a final reply
that quoted the Computer Use diagnostic, “The user changed Google Chrome.”
The Mac PreToolUse guard refused each reply as direct browser use. Rephrased
replies later settled the requests. The attempts belong to turns 1427 and
1473, requests 1c14fc59-6ae7-4435-8d16-9ccf0e3c5437 and
fac5ad17-22ca-4f9d-865d-04422caaa761. Agent report capture
f69d24e197eb95df040362e30944c591111c856c74e37cb62b6255e6323b75bd
preserves the source identity.

## Cause

The guard matched “Google Chrome” anywhere in the shell command text. It did
not distinguish a quoted reply argument from an executable browser action.
The refused command contained one Concierge sessions reply and no browser
invocation.

## Fix

The guard recognizes a single standalone Concierge sessions reply as reporting
data before applying Mac browser-action patterns to its arguments. It still
checks actual Computer Use calls and refuses shell commands with another action
or a command substitution.

## Acceptance scenario

- **Seed:** A Mac agent owes a final reply after Computer Use says the user changed Google Chrome.
- **Action:** The agent sends one sessions reply quoting that diagnostic.
- **Expected:** The reply reaches Concierge and closes its exact request; a chained browser launch or unauthorized Computer Use call is still refused.
- **Replayable offline:** yes, for guard classification; installed Mac delivery needs a fresh harmless request.
