---
failure: Every ChatGPT research request made by an agent on the Mac failed at once with "chatgpt start unavailable".
date: 2026-10-15
fix_commits: [e6236826]
cause_status: confirmed
---

# ChatGPT asks from Mac agents always failed

## What was seen

Agents on the Mac that asked ChatGPT for research (`sessions ask --provider chatgpt`) got an immediate
failure instead of an answer. On 2026-10-15, for example, the requester was told "“Traktor Maschine
mapping and stem research” could not finish your request … chatgpt start unavailable", and the same
happened to a "Spotify lyrics display options retry" ask. No chat ever reached ChatGPT.

## Cause

ChatGPT runs only in thnkr.ing's signed-in Chrome on the server, reached through Concierge's
capability socket (`CONCIERGE_SESSION_CAPABILITY_SOCKET`), which only the server instance has. The
communication owner (`bot/src/session-communication.ts`) created the ChatGPT session on whichever
machine the asking agent was on. On the Mac the runtime had no ChatGPT capability, so the start
failed immediately with "chatgpt start unavailable". Unless the agent added `--peer` by hand, every
Mac ask took that path.

## Fix

e6236826: when the provider is `chatgpt`, no peer is named, and this machine's runtime does not
have ChatGPT available, the owner turns the ask into a peer ask to the machine that runs it.
`SessionPeers.chatGptHost()` (`bot/src/session-peers.ts`) chooses it as the always-on peer whose
archive is not kept locally, i.e. the server. The chat is created there and its answer returns to
the Mac agent through the existing peer reply path. It is queued if the server is briefly
unreachable. With no such peer the ask fails with a clear message. Considered and rejected: a second
ChatGPT browser on the Mac (one signed-in Chrome is the capability boundary), and telling agents to
type `--peer` (they would keep hitting the failure). `docs/runbooks/PEER-INSTANCES.md` and the
router help text were updated.

## Acceptance scenario

- **Seed:** A Mac-shaped instance without a capability socket, peered with a server-shaped instance
  that has a ChatGPT runtime (a stub capability host is enough).
- **Action:** An agent session on the Mac instance runs `sessions ask --provider chatgpt` without
  `--peer`.
- **Expected:** No local ChatGPT session is created and no "chatgpt start unavailable" failure
  appears. A peer request is recorded to the server, the chat starts there, and its answer is
  delivered back to the Mac requester.
- **Replayable offline:** partly (two local instances and a stub ChatGPT host replay the routing; a
  real ChatGPT answer needs the server's signed-in browser)
