# Claude Code Fork Support

Date: 2026-08-06

## Finding

Claude Code 2.1.222 on AX41 supports session forking through the `--fork-session` flag, used together with `--resume` and `--print`.

Verified command shape:

```sh
claude --resume <session-id> --fork-session --print --verbose --output-format stream-json "reply with just: FORKED"
```

Observed behavior on AX41:

- Parent session: `c0f2ec4e-5099-4dd2-9960-03b102478f80`
- Fork command returned a new `system.init.session_id`: `a407d3a3-511b-48e8-8b1b-a55dcfe78859`
- Assistant text was emitted as `assistant.message.content[]` with `{ "type": "text", "text": "FORKED" }`
- Final result repeated the new `session_id`

## Related Resume Check

Plain resume was also verified:

```sh
claude --resume c0f2ec4e-5099-4dd2-9960-03b102478f80 --print --verbose --output-format stream-json "reply with just: RESUMED"
```

That returned the same `session_id`, confirming normal resume keeps the parent session while `--fork-session` creates a new one.

## Implementation Implication

The Concierge Claude provider should call:

```sh
claude --print --verbose --output-format stream-json --resume <session-id> --fork-session <prompt>
```

and must reject fork results that do not return a new UUID.
