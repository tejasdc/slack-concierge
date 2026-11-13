/**
 * Only project work opts in. Probe the executable on its execution host: an outside
 * turn may run on a runner with a different CLI version from the coordinator.
 * The CLI owns saved trust and explicit-untrusted refusal; config overrides would
 * bypass that refusal. A help probe never submits a provider turn.
 */
export const TRUSTED_CODEX_EXEC_SCRIPT = `
concierge_codex=$1
shift
concierge_help=$("$concierge_codex" exec --help) || exit $?
case "$concierge_help" in
  *'      --trust'*)
    echo 'Concierge Codex project trust: explicit' >&2
    exec "$concierge_codex" exec --trust "$@"
    ;;
  *)
    echo 'Concierge Codex project trust: legacy CLI' >&2
    exec "$concierge_codex" exec "$@"
    ;;
esac
`;

/** Arguments start after `exec`; every model, prompt and path stays a literal argv. */
export function trustedCodexExecCommand(executable: string, args: string[]): string[] {
  return ["/bin/sh", "-c", TRUSTED_CODEX_EXEC_SCRIPT, "concierge-codex-exec", executable, ...args];
}
