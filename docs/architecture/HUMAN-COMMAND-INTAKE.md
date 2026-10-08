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

The worker uses named attempt and age limits for delivery and for reaching the custody queue.
A malformed route or invalid prepared body settles as a preparation refusal before any owner
exchange. A lost owner answer, timeout or owner 5xx does not establish whether the effect happened:
after the delivery budget it stops automatic attempts, preserves the command and its ordered
stream position, reports `unconfirmed`, and files one repair notice. Other streams keep moving.
An explicit Retry reopens the same action ID and prepared bytes; the owner still deduplicates it.
The browser also bounds status polling and retains its local command when the status budget ends.
If the browser receives a confirmed HTTP 413 before ingress custody, its authenticated gateway
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
commands. Exact-run Stop and cancel-by-action bypass predecessor order. When cancellation arrives
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
