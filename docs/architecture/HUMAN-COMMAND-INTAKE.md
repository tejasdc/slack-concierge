# Human command intake

The browser writes a command with its stable action ID and per-client/session sequence in one
IndexedDB transaction before its first network attempt. Thinkering's signed-in route names the
human's sign-in door and sends the unchanged method, owner path and body to
the independent capture ingress using its existing server-held Thinkering capture credential.
Ingress commits the command in its separate WAL database with `synchronous=FULL` before returning
`custody:server`. That receipt says only that the server holds the bytes. The public route never
returns an invented operation receipt.

The Concierge command worker reads the private capture queue with its existing queue credential.
It asks Thinkering's existing root-private capability socket to prepare the command using the
same metadata/validation function as the signed-in route. Ingress retains the resulting exact
prepared body before any owner attempt. The worker then asks the capability socket to forward
those bytes to the canonical session owner. If Thinkering or Concierge is down, the command stays
pending; if an owner answer is lost, the worker retries with the same action ID and prepared body.
The owner alone accepts, refuses, deduplicates and orders the effect. Terminal owner status and
response return to ingress, where the browser can poll by action ID after a reload. Semantic
validation happens after custody, so an invalid command occupies its terminal stream position
instead of leaving a missing predecessor. Browser cards
distinguish device custody, server custody, and owner acceptance.

The worker uses named attempt and age limits for each delivery window and for reaching the custody
queue. A malformed route or invalid prepared body settles as a preparation refusal before any owner
exchange. A lost owner answer, timeout or owner 5xx does not establish whether the effect happened:
after the first bounded window the worker files one repair notice, then starts another window and
keeps the same command, ordered position and prepared bytes. A later answer from the owner settles
the original action; its idempotency key makes an ambiguous retry safe. Other streams keep moving.
The browser keeps checking a pending command without making the person press Retry. An older
`unconfirmed` command can still be resumed explicitly with the same identity.

The capture store also reports ordered streams with a retained human message waiting at least one
minute behind an absent or exhausted predecessor. The command worker checks this every thirty
seconds without delaying delivery and files one durable notice to the standing repair agent per
stream head. The notice names the client, session, sequence, blocker and waiting count, without
message text. Its repair path checks exact custody and uses the existing resume or audited
missing-slot operation; it never creates a replacement message. Ingress logs each newly retained
human message and each explicit recovery decision by action identity, so the custody and recovery
steps can be correlated after an incident. The agent owner already monitors claimable turns and
returned answers; this check covers the earlier independent ingress boundary they cannot see.
If the browser receives a confirmed HTTP 404 or 413 before ingress custody, its authenticated gateway
records a small terminal refusal under that same action and stream sequence. The full original
body stays on the device for correction; no owner delivery is claimed. An existing ingress row
always wins if a late compact refusal races with an earlier accepted action.

A terminal preparation refusal names that stage and is not presented as an owner refusal. A
creation still pending in ingress can be withdrawn by exact action ID; this cancels transport
custody only and creates no owner receipt. Once claimed for delivery, withdrawal refuses and the
caller must use the canonical owner control after the creation is accepted.

The queue accepts only POST owner commands from the authenticated Thinkering gateway, with a fixed
owner-route allowlist; it accepts no arbitrary URL or provider command. Duplicate action IDs with
different bytes, or duplicate stream sequence slots, are refused. Predecessor commands in one
client/session stream must settle before the next is delivered; a terminal refusal releases that
stream. Sequence slots start at one; a missing earlier network arrival holds later ordinary
commands. The browser retains that earlier command and retries it while the page is open and after
reload; the queue must not invent a terminal slot without its bytes or a confirmed refusal.
If an older browser build already discarded a command before server custody, a private,
authenticated recovery operation may mark that exact absent sequence as missing. The queue
requires it to be the current stream head, still absent, with a later ordinary command
pending and eligible for automatic delivery; the operator supplies a stable recovery action
and reason. The marker is audited
separately from commands and makes no claim about the missing command's contents or owner
effect. It releases later retained commands with their original bytes and action IDs. If the
device later uploads the missing sequence, ingress saves its original bytes and identity
but holds it before preparation or owner delivery. This includes Stop and cancel actions:
neither may bypass the hold to affect work that followed the gap. An ordinary Retry cannot
release it. A separate private recovery operation can release that exact retained action
under a stable action ID and recorded reason once its content is reviewed; duplicate calls
return the same decision. The gap and late-release records remain for auditing. This
operation is for a proven historical gap, not a normal browser retry or a synthetic refusal.
Exact-run Stop and cancel-by-action bypass predecessor order. When cancellation arrives
while its exact session/action target is still pending in ingress,
one transaction freezes the target transport row and retains the cancellation command. The owner
records the cancellation intent under the exact session/action identity; it does not fabricate a
receipt for a target it has not accepted.

Delivery claims carry the worker's process identity (boot, PID and process start) and worker ID.
An ingress restart preserves a living worker's claim. A replacement worker recovers a dead
coordinator's claim even when ingress never restarted; one sequential worker may reclaim its own
unconfirmed exchange. Every claim has a fresh fence, so an old exchange cannot settle a newer
claim. Recovery retains the prepared bytes and canonical action ID.

The existing app gateway remains a dependency after custody for metadata preparation and owner
forwarding. A Thinkering outage does not remove ingress custody, but no owner acceptance happens
until the gateway returns. The browser outbox covers outages before ingress can answer. The
command worker starts independently of Slack sign-in and capture delivery readiness. Logs name
action IDs and stage durations, never command text.

Notification replies use this same intake before consulting the owner. Each reply UUID names a
one-message stream, so a device retry retains exactly the same envelope. At preparation, the
gateway resolves the original Inbox thread or outage choice and freezes both the owner path and
body. A later retry cannot reinterpret an outage answer as new agent input. A lagging projection
holds preparation rather than declaring the thread missing. The native app distinguishes a saved,
queued reply from one already accepted by the conversation. If preparation or the owner later
refuses a retained notification reply, the worker publishes one provider-free Inbox notice with
the retained words before settling it; notice failure leaves the command recoverable.
