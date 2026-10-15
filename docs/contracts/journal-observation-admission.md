# Journal observation admission

thnkr.ing's canonical server owns saved journal words and a durable queue for screen entries and check-ins. When one is ready, it calls `POST /sessions/v1/journal/observations` on Concierge's authenticated owner transport with `{clientActionId:"journal-tracker:<64 hex>",objectId:"journal-entry:<id>"|"checkin:<id>"}`. The route accepts only that shape and addresses the existing journal keeper session. It never accepts client-supplied journal text or a destination session.

Concierge records the input with **service** origin, a stable action ID and queued delivery. This is important: the ordinary thnkr.ing session input route records Tejas as author, and would misattribute a server-generated request. Retried calls with the same ID are one admitted input. The receipt proves Concierge took it, not that the keeper has filed values. The keeper reads the original source from thnkr.ing's private capability socket, records supported observations there, and reports the saved result.

This boundary keeps provenance at the system that owns each side: thnkr.ing owns note words and tracker properties; Concierge owns the keeper session and execution. It avoids another journal agent or a second tracker store. Release order is Concierge first, then thnkr.ing, because the latter begins calling this endpoint after activation.
