# Provider contract

Every agent provider that runs sessions answers one table, `bot/src/provider-contract.ts`. For each
guarantee the answer is either met, with how, or missing, with the platform limit or the unbuilt
piece and what the session does instead. The guarantees are steering a running agent, Stop,
carrying on through a Concierge update, running on both the server and the Mac, history and fork.

Gemini (Antigravity) shipped on 2026-10-12 without steering, and its runs held every update. The
cause was that each guarantee was a separate branch naming Claude and Codex, so nothing compared a
new provider against them (Tejas, 2026-10-13, thnkr.ing report `ff393b34`).

## Who reads it

- Provider capability flags (`providers.ts`): steer, stop, history and fork come from the table.
  Unmet answers become the session's capability reason.
- The update rule (`execution-survival.ts`) uses it twice.
  - What may start during an update is decided per provider from where it runs (`runsIn`).
  - A provider whose runs live in the execution host is trusted once any provider's run has been
    taken back live on that host's supervisor. Proving each provider separately could never
    finish, because the update waits for every unproven run.
- The candidate release check (`bot/scripts/provider-contract-check.ts`, inside
  `presentation-release-check.ts`) refuses a release in any of these cases:
  - A provider in the `ProviderId` union has no answer.
  - An answer lacks its reason or its "instead".
  - A provider's capability flag is a literal instead of the contract.
  - The update rule names a provider.
  - A provider's `machineSetup` step is missing from the server deploy or the Mac install.

## Gemini steering

Google's headless CLI (`agy --input-format stream-json`) runs one turn per stdin line, in order,
in the same process. A message written while a turn runs is picked up when that turn's result
is out. It cannot join the running answer: the `queuedMessages: send-immediately` setting only
affects the interactive terminal (verified with agy 1.3.4 on 2026-10-13).

The adapter keeps the CLI's input open until every message written to it has been picked up. Each
`user_input` step acknowledges the oldest written message. The earlier answer is published as its
own message, and the run's result is the last answer. After an answer, a message still not
picked up gets 15 seconds before the run ends and it is left uncertain, never resent.

Gemini's status line writes the account identity through a staging file; it now removes that file
when the CLI stops it with a signal, which left 92 staging files on the Mac by 2026-10-13.
