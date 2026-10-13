# Session location and feature parity

The October 13, 2026 request asks why a session on the Mac repeatedly behaves differently from
one on the server (capture `7a1657195d22c0ddc6b9805530294888a5d122d99df0b70db9fdb21069828e28`).
The product invariant is: a feature addresses a canonical session, and the owning Concierge
answers it through the same session contract regardless of machine. The machine affects
availability and physical capabilities, not the meaning of a session action.

## Ownership and path

Each machine keeps one ledger and runs the same `SessionOwner` implementation. The server is the
always-on intake and usually starts new work. A Mac session remains owned by the Mac; the server
keeps peer request and return custody and queues an addressed request while the Mac sleeps. The
Mac's own owner admits the request when it wakes. Neither machine writes the other's ledger.

There are two runtime compositions because the server still carries the retained Slack adapter
while the Mac runs the native-only composition. Both now call `createSessionPeerServices` to
construct peer clients, project setup, link orders, and session communication, then bind those
services to their local `SessionOwner`. Feature code belongs in the shared owner and peer
services, not in either startup composition. The candidate presentation check refuses a release
if either composition stops using that shared entrance or constructs one of those services on
its own. The check is a composition guard; it does not prove that a browser feature works.

thnkr.ing has one authenticated session surface backed by a federated owner client. That client
must route every session-scoped read and mutation to the machine owning its session. Its own
route contract and release check must refuse a new feature that silently falls through to the
server owner. The application still supplies a machine choice for **creating** a session, because
the project folder and provider credentials are local; the choice must not alter later session
semantics. See thnkr.ing's session presentation and owner federation documentation for its
surface-side contract.

## Differences with a reason

| Difference | Reason | Session behavior |
| --- | --- | --- |
| The Mac sleeps | Physical laptop availability | An addressed request is retained and delivered on wake; reads say when the owner is unavailable. |
| Project folders and provider sign-ins differ | Files and credentials are machine-local | Creation selects an available machine/project; an existing session keeps its owner and provider. |
| Inbox capture and public ingress run on the server | One canonical human intake | Inbox topics are server-owned, but a Mac session may be an addressed participant and reply target. |
| Screenshot, Xcode, Simulator, Messages relay, and speech engines differ | Physical platform capabilities | A capability acts on the machine that has it; ordinary session reads, inputs, actions, history, and replies retain the common contract. |

These are machine capabilities and availability states, not permission to omit a session feature
on the Mac. A new exception needs an explicit physical reason and a visible refusal or queued
state; a missing route or untested assumption is a defect.

## Release and live acceptance

The candidate-owned `presentation-release-check.ts` runs the composition guard before
activation. The thnkr.ing release must exercise the same declared session routes against
server and Mac owner fixtures and reject an undeclared or one-owner route. After both installed
revisions are known, use real server and Mac sessions through the authenticated surface and
the agent's marked entrance: discover each, read exact history/receipt, send an addressed
request, and confirm its answer returns to the same thread. Record which machine answered and
whether the Mac was awake. A passing source check or one owner's response is not live parity.
