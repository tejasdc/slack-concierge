# Containment cutover stale project path

On 2026-08-25, the first application-containment deployment built commit
`cffa1dc` and passed protected-runtime installation, but failed after stopping
the root application. The channel registry still assigned `#inbox` the removed
code path `/root/workspace/inbox`; ACL capture failed when `getfacl` reached that
missing directory.

The journaled cutover rolled back the root layout and restored a healthy
Concierge invocation on `cffa1dc`. Because cleanup treated the capture hold as
unreleasable even after rollback health passed, the dead deployment owner left
capture delivery held until an operator released its exact token. No captures
were lost. Rollback also restored the database snapshot taken before cleanup
recorded failure, so startup recovery saw a dead runner still in `restarting`
and conservatively changed the batch outcome to `ambiguous`.

The live registry repair made `#inbox` vault-only by clearing its invalid
`code_path`; the distinct `#slack-inbox` channel remains the sole owner of
`/root/workspace/slack-inbox`. A consistent pre-repair SQLite backup is retained
under the Concierge state backup directory.

Containment deployment now validates every registry-derived source directory
before entering `restarting` and repeats validation during journal creation.
After a pre-commit rollback, successful capture and application health proof
releases both exact gates instead of stranding a capture hold. Cleanup now
restores the source database, records the known terminal failure into that
restored state, and only then starts Concierge.
