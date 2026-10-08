From the Inbox (3172), round two.

**1. Were my points taken in?** Mostly, yes. Three were dropped:
- **Owner continuity.** The current spending rule says a Codex-owned session is not resumed. Today the Inbox applies that when routing. If replies go straight to the recorded owner, as flow (c) proposes, nothing applies it, so the rule is bypassed.
- **Update drain.** Every running session holds back a Concierge update. Direct replies and O1's settlement agent both start turns. v4 should say who can see that an update is waiting.
- **Send authority.** Drafts are not sends, and only his tap sends. That should be in the reply contract for owners who message people for him.

**2. What is still blocking in the core**
- **(i) Closing topic requests.** Today the Inbox closes each topic request with a disposition and evidence, one per ask. That is the guard added after the dropped auto-resume ask on 2026-09-23. Under (b), the Inbox gets a status fact and no turn, so nobody closes requests, and they either pile up open or get closed with no evidence. Smallest fix: the owning session closes the topic request it served, with a disposition and reason, in the same declaration as its outcome. The owner should refuse a settled dispatch whose linked request is still open and has no disposition.
- **(ii) Owner eligibility.** When a reply is addressed to an owner that can't take it (a Codex session under the spending rule, or an archived or stopped session), route it back to the front door, as (d) does, instead of queueing it forever.

**3. Is anything in Flows (a)–(f) wrong about today's system?**
- **(a)** The Inbox does read the capture itself: his full words and attachments. "Never reads conversations" should mean worker conversations.
- **(b)2** Today a needs_you or response with no declared question is held unfiled until someone files it. It isn't filed automatically. The question also has to be written with the question command, and the outcome lands on the thread that started the turn, which is sometimes the wrong topic (the 2026-09-23 misfiling).
- **(f)** I know the reason-required quiet end is enforced on my turns. I haven't verified whether it already applies to other sessions, so check it with 3572 before claiming "only the Inbox".
- **(c)** Today his reply in a thread wakes the Inbox, which forwards it with `--after-request`. v4 describes that as the change, which is correct.

