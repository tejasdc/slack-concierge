/**
 * SQLite keeps an object's SQL exactly as it was first written, and `CREATE … IF NOT EXISTS` never
 * rewrites it. The live ledger's executions_open and executions_survival were created as
 * `IN ('intended', 'live', 'exited')` and `(provider, supervisor)`; the code now writes them without
 * the spaces. Comparing raw text called that a schema change on every update from 2026-11-04, so
 * each update copied the 8.4 GB ledger and re-checked all of it with Concierge stopped (over two
 * minutes, longer than an agent command waits). Spacing and keyword case outside quoted text mean
 * nothing to SQLite, so they are not compared. Operators whose doubled form means something else
 * (`- -` and `--`, `| |` and `||`) keep their spacing.
 */
export function canonicalSql(sql: string): string {
  return sql.split(/('(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\])/).map((part, index) => index % 2 ? part
    : part.toLowerCase().replace(/\s+/g, " ").replace(/ ?([(),=<>!;.]) ?/g, "$1")).join("").trim();
}
