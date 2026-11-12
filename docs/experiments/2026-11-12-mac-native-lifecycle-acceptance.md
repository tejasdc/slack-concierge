# Mac native Claude lifecycle acceptance — November 12, 2026

This record combines two scoped Mac observations from November 12. They used
separate disposable native Claude conversations: one checked Pause/Continue and
same-account context; the other checked an ordinary account change and retained
context. Their inputs, identities, and limits remain separate below.

## Pause, held input, and Continue

Controller: Codex GPT-6.1 Sol, Mac session `concierge:381`, address
`session:WzIsMzgxLDFd`, in
`/Users/tejasdc/workspace/slack-concierge/.wt/mac-native-pause-continuity`.
Source request `5146e5bb-2dbd-413b-8e6b-7d8a39042996`, run
`452b1579-75fb-4b38-8e7d-4494d7b836e8`.

Target `concierge:382`, address `session:WzIsMzgyLDFd`, native UUID
`3b19a4c8-ae77-4a2a-93fc-24ad9668b0d9`, completed baseline request
`2e4fad77-e26a-4b18-879c-69d422c49b20` (run
`b3951ed9-aadc-4ea2-8967-8b25cc5f23bd`) at 22:34:22–22:34:51 UTC. At
22:35:19, a source-validated Pause suspended it. The
marked local input `8e57839f-3398-42bc-936f-8695e5000f86` was accepted at
22:35:53 and remained `INPUT_HELD`, with no run or acknowledgement. Comparison
session `concierge:383` (native UUID
`b346b3e7-c714-4cb4-9d96-ed4f3bcc14a8`) completed at 22:36:08–22:36:27 while
the target stayed held; the target transcript was byte-identical to its
pre-acceptance snapshot and the outside controller remained usable.

At 22:33:26, the live launchd job PID 38921 used helpers
`272e2bdc2b0047852049ffc7b876fe0b98032e3d`; the two required repairs were
`c845c015ce1c4521168e89219067ad45fc6d7326` and
`0a5d63e7b189e75a4cffaafce062b4b0637d96c0`. A separate coordinator update
later restarted the launcher; at 22:37:25, PID 60879 used helpers
`904bd96e5c878dab01a1572056ebd131ca96ac25`. The provider turn had completed
before that update; this controller did not request it.

Continue at 22:36:59 released that same input. It appeared once in the original
native conversation at 22:37:02.495, recalled its earlier synthetic fact before
tools, and completed at 22:37:10. Ordinary `claude auth status` before and after
reported the same Gmail home and organization. No input was resent. Delayed
replays preserved later Pause/Continue choices, and changing the old action's
verb conflicted. These control replay observations straddled an external
coordinator update.

The full 1,598-byte admitted prompt matches the owner's retained hash and omits
the synthetic fact. All selected API message references and the recorded
system/tools shape reconstruct; this supports recorded request construction,
not independent network-delivery capture. The local source-validated marked
input route was used; the public test-device HTTP capture helper into a
Mac-local target was **not run**. No active provider was killed or claimed to
have been stopped. This establishes the observed admission hold and release in
this trial, not universal exactly-once external effects, all-process survival,
credential-byte preservation, or cross-account memory.

The original report's final “Mac acceptance incomplete” status preceded the
separate account-continuation observation below. It remains accurate for the
scope of this Pause/Continue trial alone.

## Ordinary continuation under another account

Controller: Codex GPT-6.1 Sol, the same Mac session `concierge:381` and address
`session:WzIsMzgxLDFd`. Target `concierge:270`, address
`session:WzIsMjcwLDFd`, kept its Claude Opus 5.5 binding and native UUID
`ac65216e-6eee-4598-ac98-a9b251b22120`.
The continuation request was `30201c9c-011e-4260-8721-334bf69b137b`, source
run `b1f607b9-3f94-4f20-bff5-8ab63cc88a48`.

The historical baseline was November 3, not a fresh `claude auth status`
measurement. Request `df2f02c3-1fce-4632-8ea4-3ad6d38ef24a`, run
`131c25c6-1d15-4cdb-99be-a1daa0686908`, completed in this same native UUID.
At 21:41:22.401 UTC, a tool read four selected nonsecret fields from the
inherited account home's sign-in configuration: Hey (`hey@tejas.nyc`), home
`/Users/tejasdc/.claude-accounts/hey-tejas-nyc`, account UUID
`b09b1cdc-bdc2-4f13-94f2-3858ea045518`, and organization UUID
`7b2cfe7e-72b5-4f65-8962-f16ffdf95bc7`. The independent owner event at
21:41:15 UTC records Hey, expected Hey, reason `stayed-on-its-account`; the
native turn completed at 21:41:37.982 UTC. Do not relabel this historical
instrument as `claude auth status`.

On November 12 at 22:49:27 UTC, the controller admitted one ordinary, unpinned
marked continuation, input/operation `849463d0-1d79-44e8-bfbe-a7c587872bf5`,
action `mac381-270-single-account-continuation`, run
`311c43f0-9884-449c-b579-994f19c9db7b`. The same native UUID admitted it at
22:49:31.527. Before any tool call, the assistant recalled
the exact November 3 account UUID at 22:49:35.119. The first tool, at
22:49:35.574, was ordinary `claude auth status`; it reported logged-in Gmail,
home `/Users/tejasdc/.claude-accounts/tejastej-dc-gmail-com`, and organization
UUID `978dff84-c20e-4845-a790-615dc4e7f536`. The owner event records Gmail,
expected Gmail, reason `stayed-on-its-account`—not `moved-for-room`. The exact
input completed at 22:49:46.483.

The full 1,816-byte admitted prompt and the selected API request were
reconstructed. Neither old UUID appears in the new prompt or selected
system/tools shape; the oracle appears in three retained November 3 dialogue
messages. This supports the observed recall from retained conversation context
and recorded request construction, not an independent capture of network
delivery. The historical account-home/config read and current auth-status read
are different instruments. The evidence does not locate when or why the
conversation's account preference changed during the intervening nine days.
Both identity observations belong to this native Mac conversation; an
SSH-run `claude auth status` is not evidence of Mac Keychain sign-in state.

## Review and limits

The designer reviewed both complete attached reports and their scoped raw
archives: all 53 Pause-evidence and 33 account-evidence member hashes passed;
the inspected extractors passed; the held transcript was byte-identical; and
all 18 Pause and 12 account API references and their recorded shapes
reconstructed. The Pause report's 18 references and the account report's 12
references are separate audits.

The Mac Pause/Continue and ordinary different-account continuation cells now
have bounded observations. Fresh allowance exhaustion and refusal recovery
remain unrun. The public-device HTTP capture hop remains unrun and is not an
additional lifecycle acceptance gate for these completed cells. No account was
pinned or changed by the controller, no quota was manufactured, and no
credential was copied. No universal exactly-once external-effect, all-process
survival, or credential-byte preservation guarantee follows.

Mac queue release also does not mean immediate provider start: the start gate
applies its configured pace and memory-pressure holds after release. See
[Mac paced starts and memory-pressure behavior](../architecture/TURN-LIFECYCLE.md#paced-starts).
