# September 21 settled-result returns: exact historical audit

The Inbox reported eleven answered requests that had no individual return input. The
original repair sent a 65-result digest to the Inbox in one later return input. The
Inbox's retained provider transcript contains that input, including all eleven
request IDs, final event IDs, and answer text. This establishes one content delivery
to the requesting conversation. It does **not** establish the original one-return-
receipt-per-request promise: the eleven original `return:<event>` inputs do not
exist in the installed owner's accepted-input ledger. Do not replay these answers;
the requester already received their words, and some describe effects already made.

The September 16 rule deliberately retained completed results without a requester
return. The September 21 repair removed that rule (`ff10f874`), then removed the
remaining wait for the answering session's whole run to end (`ab190a1a`). That
second wait mattered for a Mac Claude session that accepted new requests into one
long-running run. Failures and decisions had continued to return, explaining the
apparently intermittent symptom. The current contract has since added a named
Inbox-thread destination: a confirmed answer posted there does not also wake the
requester, while unresolved work and explicit returns do.

| Request | Original final event | Subject in the delivered digest |
| --- | --- | --- |
| `45da7e9a-1027-4ab1-8f61-004d6a42e15a` | `2f133fd5-79dd-4f46-ba02-7d9900d61152` | Watch recording row stuck after phone receipt |
| `1e237964-7eb6-457d-8678-e868441beb95` | `86bb103f-ab82-4ac8-88dd-f998159bef48` | Phone speech-session regression |
| `64195651-4763-42a3-80fd-8837c16f3a40` | `8fa695d4-27d2-4c84-b63f-c07c2dadb5f4` | Expanded notification scrolling and voice entry |
| `b21ff0f7-bca6-42c6-8bfa-73c29f61bc2e` | `68ae7a00-314f-45c2-9aa7-94a6c6893cf3` | Quick reply button and Action Button options |
| `c42e8ffb-dc61-49f1-849e-f9d939dac716` | `2137d86d-66b7-4e4c-a054-ab4ad893562c` | Parked Messages integration |
| `831fa374-7121-4311-87c2-ae0f557811b6` | `c3c13722-b172-4ffb-a9c7-d5878611c747` | Reply dictation lost when phone locks |
| `04186feb-a37f-431e-8b28-f19ac17b03ec` | `a4d1db01-ad4b-4d2f-b2cb-c433cd54c4bc` | Blank expanded notification screenshot |
| `6b0ac67c-2371-42ea-bafb-c232ab90dfef` | `437693f5-395d-4989-a2c8-3af135cb020d` | Inbox Open message target |
| `17db5c51-40e6-4754-bf16-f94474da3ff6` | `7e79ebbb-be24-473b-987b-c9b9a5c79a0f` | Repeated attention content in an Inbox conversation |
| `e57698d0-8593-4651-bcfc-12fb4ac0944f` | `46e06d4d-f140-48be-801d-2cde1e1bb317` | Parked server transcription idea |
| `a7750b47-0a3a-4565-830c-0c53ef596572` | `794596a4-c8cb-494a-92b5-9e9192b12eda` | Watch transcription latency regression history |

## Evidence and current boundary

- The original request, addressed to session `concierge:3537`, listed these eleven
  exact request IDs and the absent individual return inputs. Its retained Claude
  transcript is `940c06ab-292a-463e-b150-1247bbca7641.jsonl` in the server
  transcript archive, first user message.
- The Inbox's retained transcript
  `37d483bc-cc54-41a5-8525-ae6c2b5f5849.jsonl`, input
  `return:cca46c3e-b756-4e76-a4c4-c2aba7093040`, contains a 65-entry digest.
  Each row above appears as a separately numbered entry with its original final
  event and answer. The digest was admitted to session `concierge:3172` and
  appears in the provider's conversation, so it crossed both the owner and
  provider boundaries. Its body is the historical content carrier, not a
  direct return from any of the eleven original requests.
- On November 6, `reports chain return:<original-final-event>` returned
  `The accepted input was not found in this owner ledger` for each of the eleven.
  This is consistent with the reported zero individual returns. The runner's
  local SQLite database is not the owner ledger; this audit used the installed
  owner through its supported report route and the retained provider transcript.
- The two requests that were still `admitted` at the first September inspection
  were not part of the eleven missing completed returns. `a843bcfa-350e-45d3-8197-64303d85d111`
  later produced its own accepted return input, visible in the Inbox transcript
  at 21:44 UTC. `f25ec807-e6fc-47b6-8abf-db227b3f4490` settled at 20:33:42 UTC
  and appears as entry 65 of the delivered digest. These are separate outcomes;
  neither justifies replaying its work.
- The artifact inspected in the first audit, `572b7ee7687a20163d866c2769f48aba5a582782b20cc02ceaa743cd35cdaa0f`,
  names source commit `57d89c7909aa76f2662e19951cad261366723ae4`. Its
  contract sends ordinary completed work in a named Inbox thread to
  that thread; requests without a thread, failed work, decisions, and explicit
  returns wake the requester. A return can carry several requests only when
  each final event is linked to the carrier. That linkage is absent for this
  historical digest.
- A harmless November 6 request `8af6a474-30a8-4cc8-b00c-69b64b4458ca`
  settled `answered` while its Codex requester run was active. The installed
  owner admitted `return:4ce8c633-f072-46af-86ea-4d3e5a7afe95` to that
  requester within the same minute. That check proved owner admission only.
  A separate exact active-run probe then proved the next boundary: request
  `e52b856c-a9c2-4943-89f9-04442cff1a8c` produced one final event
  `3a5cbb13-157b-47aa-be6c-1bff82b4b54d`; its one accepted return was
  steered into requester turn 24521 and acknowledged by the Codex provider at
  2026-11-06 13:51:15 UTC. The return text appeared in that running turn.
  Separately, the named-thread request's prompt answer was posted through a
  received partial.
- As of the later installed artifact `e000f15344b76d01cdbeb2e72161fb80c9776a3c1eed544161fa887186135425`
  (source `3032adc9838d7bf19abff809aa793ec219820cf2`), the delivery and
  return-audit functions exercised by that probe are unchanged from the
  earlier artifact. The service is running; its `stuck_work_watch_started`
  record at 2026-11-06 20:52:23 UTC confirms the omission watch started.
  The watch checks eligible results after ten minutes, wakes the queues, and
  raises one Inbox notice if they remain stuck five minutes later. No positive
  stuck-result alarm was induced in production, so the watch's active state is
  the installed evidence, not proof of a production alarm firing.

There is no basis to re-run the eleven original requests or send their answers
again. A durable ledger-level attribution would need an owner-mediated command
that checks the existing digest carrier and each original final event before
linking them; a direct database edit would evade Concierge's custody rules.
The historical individual receipt guarantee remains unproven. The delivered
digest is an explicit historical exception, not eleven retroactively invented
return inputs.
