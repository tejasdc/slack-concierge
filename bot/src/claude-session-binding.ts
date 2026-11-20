/**
 * The authoritative binding of a Claude session UUID to the account its subprocess
 * must run on. This supersedes the JSONL first-row `session-owner` header as the
 * source of truth for the launcher.
 *
 * Why this exists: on 2026-11-19 the dispatcher picked hey@tejas.nyc for a turn whose
 * transcript's first-row `session-owner` header pointed at chann.app's `accountUuid`.
 * `agent-claude-launch.ts` exact-resume branch read the header and silently rebound
 * the subprocess to chann.app's home, producing a chann.app-labelled refusal that
 * the dispatcher cached under hey@tejas.nyc's scope. Right refusal data, wrong account
 * label — no retire-by-reading could ever retire it.
 *
 * Model: the dispatcher's choice is a VERIFIED binding. The header is informational,
 * recording who first created the session in Claude's UI. When they disagree, the
 * launcher trusts the binding and logs `session_owner_header_mismatch`.
 *
 * See architecture doc §4 and `bot/tests/incidents/2026-11-19-session-owner-header-override.test.ts`.
 */

import { db } from "./state";
import { log } from "./log";

export type ClaudeSessionBinding = Readonly<{
  sessionUuid: string;
  accountLabel: string;
  accountUuid: string | null;
  organizationUuid: string | null;
  boundAtMs: number;
  boundByDispatchRevision: number;
}>;

export function readClaudeSessionBinding(sessionUuid: string): ClaudeSessionBinding | null {
  if (!sessionUuid) return null;
  const row = db.query(
    `SELECT session_uuid, account_label, account_uuid, organization_uuid, bound_at_ms, bound_by_dispatch_revision
     FROM claude_session_account_bindings WHERE session_uuid = ?`,
  ).get(sessionUuid) as {
    session_uuid: string; account_label: string; account_uuid: string | null;
    organization_uuid: string | null; bound_at_ms: number; bound_by_dispatch_revision: number;
  } | null;
  if (!row) return null;
  return {
    sessionUuid: row.session_uuid,
    accountLabel: row.account_label,
    accountUuid: row.account_uuid,
    organizationUuid: row.organization_uuid,
    boundAtMs: row.bound_at_ms,
    boundByDispatchRevision: row.bound_by_dispatch_revision,
  };
}

export function writeClaudeSessionBinding(binding: {
  sessionUuid: string;
  accountLabel: string;
  accountUuid?: string | null;
  organizationUuid?: string | null;
  boundByDispatchRevision?: number;
}): { written: boolean; reason?: "stale-revision" | "same-revision-conflict" | "same" } {
  if (!binding.sessionUuid?.trim() || !binding.accountLabel?.trim()) return { written: false, reason: "same" };
  const now = Date.now();
  const existing = readClaudeSessionBinding(binding.sessionUuid);
  const incomingRevision = binding.boundByDispatchRevision ?? 0;
  // I4 (2026-11-19): CAS on `bound_by_dispatch_revision`. The schema stored the field
  // but UPSERT overwrote unconditionally — a stale write from an in-flight dispatcher
  // could clobber a newer selection. The guarded UPDATE WHERE existing <= new only
  // commits when the incoming revision is at least as high as the stored one.
  if (existing && existing.boundByDispatchRevision > incomingRevision) {
    log("info", "claude_session_binding_write_stale", {
      session_uuid: binding.sessionUuid,
      stored_revision: existing.boundByDispatchRevision,
      incoming_revision: incomingRevision,
      stored_account: existing.accountLabel,
      incoming_account: binding.accountLabel,
    });
    return { written: false, reason: "stale-revision" };
  }
  if (existing && existing.accountLabel !== binding.accountLabel) {
    log("warn", "claude_session_account_rebound", {
      session_uuid: binding.sessionUuid,
      from_account: existing.accountLabel, to_account: binding.accountLabel,
      from_revision: existing.boundByDispatchRevision, to_revision: incomingRevision,
    });
  }
  // M3 (2026-11-20): same-revision writes with a DIFFERENT account label are a race
  // between two dispatchers that both minted the same revision number. Neither has
  // more authority than the other, so neither should silently overwrite — fail closed
  // and let the caller retry with a fresh revision.
  if (existing && existing.boundByDispatchRevision === incomingRevision && existing.accountLabel !== binding.accountLabel) {
    log("warn", "claude_session_binding_same_revision_conflict", {
      session_uuid: binding.sessionUuid,
      revision: incomingRevision,
      stored_account: existing.accountLabel,
      incoming_account: binding.accountLabel,
    });
    return { written: false, reason: "same-revision-conflict" };
  }
  // The guarded UPDATE: an INSERT must still run for first-time bindings, but on CONFLICT
  // the UPDATE is conditional on the incoming revision winning. SQLite's "WHERE" in an
  // ON CONFLICT DO UPDATE clause acts as the CAS guard.
  db.query(
    `INSERT INTO claude_session_account_bindings
       (session_uuid, account_label, account_uuid, organization_uuid, bound_at_ms, bound_by_dispatch_revision)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_uuid) DO UPDATE SET
       account_label = excluded.account_label,
       account_uuid = COALESCE(excluded.account_uuid, account_uuid),
       organization_uuid = COALESCE(excluded.organization_uuid, organization_uuid),
       bound_at_ms = excluded.bound_at_ms,
       bound_by_dispatch_revision = excluded.bound_by_dispatch_revision
     WHERE excluded.bound_by_dispatch_revision > bound_by_dispatch_revision
        OR (excluded.bound_by_dispatch_revision = bound_by_dispatch_revision AND excluded.account_label = account_label)`,
  ).run(
    binding.sessionUuid,
    binding.accountLabel,
    binding.accountUuid ?? null,
    binding.organizationUuid ?? null,
    now,
    incomingRevision,
  );
  return { written: true };
}

/**
 * Report that the launcher found a JSONL `session-owner` header that disagrees with
 * the binding. The launcher ALWAYS trusts the binding. The event lets us measure how
 * often the header is stale (expected: whenever the dispatcher moves a session's
 * account across the week).
 */
export function recordSessionOwnerHeaderMismatch(info: {
  sessionUuid: string;
  bindingLabel: string;
  headerAccountUuid: string | null;
  headerOrganizationUuid: string | null;
}): void {
  log("warn", "session_owner_header_mismatch", {
    session_uuid: info.sessionUuid,
    binding_account: info.bindingLabel,
    header_account_uuid: info.headerAccountUuid,
    header_organization_uuid: info.headerOrganizationUuid,
  });
}
