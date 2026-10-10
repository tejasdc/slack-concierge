# Foreground request isolation

The October 9 incident stopped independent conversation reads while account work occupied
the accepting process for 24.6 and 34.8 seconds. Those spans identify where the loop was
occupied, not the kernel cause: delayed journal receipt and a blocked-output reproduction
also show that logging can contribute to either span. The original request is retained in
request `5804d389-e491-483f-9750-3ce6c996fb86`; its complete human wording accompanies that request.

## Contract

A blocked computation, filesystem call, database call or log sink in one executor must
not occupy the thread accepting unrelated requests. Already accepted work keeps its
identity, ordering and uncertain-outcome semantics. No component acknowledges canonical
acceptance before the canonical transaction commits. Saturation and a shared host/disk
failure remain possible and must be reported truthfully, not disguised as success.

Both applications get a small storage-free accepting process, explicit route execution
domains and independently scheduled read executors. The existing application remains
the only command/runtime authority. Thinkering's authenticated command admission runs
independently too, forwarding into the existing durable capture ingress; it does not
invent another queue. Two read executors provide the minimum independent capacity for
one blocked reader and one available reader. Finite admission and response deadlines
bound retained requests; streams have an explicit domain rather than occupying both
finite read slots forever.

Readonly executors open canonical data physically readonly and do not run migrations,
provider dispatch, schedulers, projection writers or opportunistic GET mutations.
Projection and history semantics, exact detail identity, auth, peer restrictions and
freshness remain the existing contracts. Account enumeration moves off the canonical
loop; any genuinely live sign-in state is obtained separately, with unknown availability
reported honestly. Each GET is classified; absence from the registry refuses instead of
silently running it on the accepting thread.

## Choice and ownership

Leaving the current composition fails the observed requirement. Merely changing a
function to async or opening a separate SQLite connection does not separate execution.
Cloning the complete application in a general HTTP cluster would duplicate writers,
schedulers and credential ownership. A worker for every request would add cold-start
and migration hazards. Persistent isolated processes with one mutation authority fit
this one-person service and give independently killable readonly executors. Their extra
memory and IPC cost must be measured in composed acceptance.

Concierge's canonical process binds a private backend socket. Its child gateway owns
the existing root-only socket and authenticated peer port, starts sealed read children,
and forwards commands once. The gateway passes bodies as HTTP streams, not giant JSON
IPC messages. Root-only external-agent and supervisor routes never appear on the peer
port. Health separately exercises the canonical process: a responsive gateway cannot
make a frozen owner green. Children belong to the same installed artifact and lifetime;
an IPC disconnect closes their listeners. No production pause or manual restart is used.

The parent investigation owns Concierge gateway/lifecycle/artifact integration and the
whole release. The Concierge read agent owns readonly route extraction and account
assembly. The Thinkering agent owns its complete composition boundary, including auth
and ingress. Session 4701 owns bounded non-blocking application logging; 4700 owns host
logging monitoring, skill guidance and the dormant evidence follow-up. Session 4559
continues to own the Threads saved-list and progress UI.

## Evidence and enforcement

Record receipt, executor assignment, headers and completion using request identity and
bounded route labels, never content, query strings or credentials. A delayed foreground
request names its execution domain and occupied reader(s); unavailable dependencies
are distinct from time spent waiting for an executor. Logging itself cannot wait on its
sink and has a bounded queue/drop counter.

The release check inspects the accepting import graph and route coverage, then runs the
real composed applications against private synthetic state. Block a child for 35 seconds
(never production), issue concurrent authenticated Threads/history/other prepared reads,
and verify they progress through the other executor. Exercise pending durable commands,
later canonical acknowledgement, authorization failures, streams, worker death/restart
and sink backpressure. Build/seal all declared children through the normal release path.
Concierge receives the required trust-boundary and lifecycle review against the original
words. Thinkering follows its explicit build, deploy and live-check policy; its existing
nightly review owns review there, with no extra per-change review gate. After normal
activation, check the actual installed read and admission paths and record revision, latency, errors and capacity. Schedule one dormant follow-up
after deployment so real activity can reveal remaining stalls without keeping an agent
running. A short healthy sample is not proof of universal availability.
