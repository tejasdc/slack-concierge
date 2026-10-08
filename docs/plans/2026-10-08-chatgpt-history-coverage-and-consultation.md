# ChatGPT history coverage and consultation

Tejas asked on October 8, 2026 to recover complete ChatGPT history and let the lab ask past conversations questions. The initial live check found 695 retained and indexed conversations, a September 29 last successful account read, and an expired browser login. The November 2025 export holds 504 conversations, 22 absent from the mirror, for 717 distinct known IDs across both sources. The daily timer returned `partial` with exit 0, so a running timer did not imply fresh coverage.

## Choice

| Path | Meets | Loses |
| --- | --- | --- |
| Continue the native ChatGPT thread through the existing browser binding | ChatGPT's current model, account context and native thread | A browser send would put an agent's question in the provider's user role. The existing bind path requires explicit human intent and exact account/conversation/anchor verification. It is unsuitable as the default historical question path. |
| Ask a restricted model to read an exact saved snapshot | Preserves the original conversation and clearly attributes the new answer to a consulting agent; works while ChatGPT login is down | It is a present interpretation of the retained text, without ChatGPT memories, instructions, files or later unsynced messages. |
| Offer both through their existing separate paths | Gives an explicit human the native path and agents an information-only source reading | Requires the surface to keep the two effects visibly distinct. |
| Leave search and context only | Keeps the current source boundary | Does not answer the requested questions or support the lab's comparative synthesis. |

Use both existing paths, with snapshot consultation as the agent-facing default. A question to an imported ChatGPT address creates a restricted Claude child pinned to the source version and branch. The child gets cited user and assistant text, no tools or network, and its answer is recorded as the child agent's reading. It cannot send to the original conversation or act for the imported user. Native continuation remains a separate, human-explicit verified binding.

## Coverage contract

Each daily pass enumerates regular and archived inventory twice, checks its reported count, reads changed bodies and bodies not checked within 24 hours, and retains exact raw versions. A complete result means the accessible signed-in account's current inventory was enumerated and its bodies saved and indexed. Import the 22 export-only records through the existing source owner under a separate dated export scope, preserving their original provenance and making them consultable. The retained 2025 export and browser inventory have different dates and scopes; neither alone proves every conversation that ever existed, including deleted or temporary chats. A fresh official account export is the independent census for that stronger claim. Login failure, rate limiting and partial bodies must remain visible; the operator job fails and raises native attention on a partial pass. No retry sends a model message or starts a second browser owner.

## Acceptance

Check the installed pass after Tejas restores the dedicated browser login: authenticated account scope unchanged; account reported count equals discovered, saved and indexed; `lastCompleteAt` advances; an older conversation appears when newly present; one imported ChatGPT address answers a cited question through a restricted child; the original ChatGPT conversation has no new agent-authored user message. Until the login is restored, report live coverage as unconfirmed and do not call the all-time requirement complete.
