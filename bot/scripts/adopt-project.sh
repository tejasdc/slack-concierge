#!/usr/bin/env bash
# adopt-project.sh — AX41-side project adoption for Slack Concierge.
#
# Runs on AX41. Takes an existing directory at /root/workspace/<slug>/ and
# wires it into the canonical Concierge layout:
#   vault/projects/<slug>/AGENTS.md          (real file, Obsidian-visible)
#   vault/projects/<slug>/notes/inbox.md     (real file, Obsidian-visible)
#   code/<slug>/AGENTS.md    -> vault/projects/<slug>/AGENTS.md
#   code/<slug>/CLAUDE.md    -> AGENTS.md
#   code/<slug>/notes        -> vault/projects/<slug>/notes/
#
# Rules:
# - AGENTS.md is always the canonical real file.
# - CLAUDE.md is always a symlink to AGENTS.md.
# - Same pattern applies whether project is fresh, has one file, both files
#   symlinked in some direction, or genuinely divergent.
# - Divergent-content case (both real files, non-identical): SKIP file work,
#   log clearly, exit success (other adoption steps still run so state.db
#   gets a row and notes/ symlinks land).
# - Notes: if code/notes exists as a real dir with content, MOVE that content
#   into vault/notes first, then symlink. Never lose files.
# - Runs at MIGRATION TIME, not per-Slack-channel-creation. Once run, the
#   project is fully set up for Codex/Claude to work on it, regardless of
#   whether a Slack channel exists yet.
#
# Vault ops: writes vault files via shell (cp/mv/ln). DESIGN.md rule 102
# says vault ops should go through Obsidian Local REST API to avoid racing
# obsidian-sync. For migration, pause obsidian-sync first OR run with
# --pause-sync (script handles it).
#
# Usage:
#   adopt-project.sh <slug> [--pause-sync] [--dry-run]

set -euo pipefail

SLUG="${1:-}"; shift || true
PAUSE_SYNC=0
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --pause-sync) PAUSE_SYNC=1; shift;;
    --dry-run) DRY_RUN=1; shift;;
    *) echo "unknown flag: $1" >&2; exit 2;;
  esac
done

if [ -z "$SLUG" ]; then
  echo "usage: adopt-project.sh <slug> [--pause-sync] [--dry-run]" >&2
  exit 2
fi

WORKSPACE_ROOT="${CONCIERGE_WORKSPACE_ROOT:-/root/workspace}"
VAULT_ROOT="$WORKSPACE_ROOT/vault"
VAULT_PROJECTS="$VAULT_ROOT/projects"
STATE_DB="${CONCIERGE_STATE_DB:-/root/.local/state/concierge/state.db}"

# Parse slug into hierarchy: `ideaflow_cortex` → `ideaflow/cortex`, `foo` → `foo`
REL="${SLUG//_/\/}"
CODE="$WORKSPACE_ROOT/$REL"
VAULT="$VAULT_PROJECTS/$REL"

log() { echo "[$(date -u +%FT%TZ)] adopt-project($SLUG) $*"; }
run() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "  DRY: $*"
  else
    eval "$*"
  fi
}

log "code=$CODE  vault=$VAULT"

# Pre-flight
if [ ! -d "$CODE" ]; then
  log "ERR: code dir $CODE does not exist. Run migration first."
  exit 1
fi

# Optionally pause obsidian sync to avoid racing on vault writes.
SYNC_PAUSED=0
if [ "$PAUSE_SYNC" = "1" ] && [ "$DRY_RUN" = "0" ]; then
  if systemctl is-active obsidian-sync >/dev/null 2>&1; then
    log "pausing obsidian-sync service for vault writes"
    systemctl stop obsidian-sync
    SYNC_PAUSED=1
  fi
fi
resume_sync() {
  if [ "$SYNC_PAUSED" = "1" ]; then
    log "resuming obsidian-sync"
    systemctl start obsidian-sync || true
  fi
}
trap resume_sync EXIT

# 1. Ensure vault directories exist
run "mkdir -p '$VAULT/notes'"

# 2. AGENTS.md / CLAUDE.md convergence
VAULT_AGENTS="$VAULT/AGENTS.md"
CODE_AGENTS="$CODE/AGENTS.md"
CODE_CLAUDE="$CODE/CLAUDE.md"

is_symlink_to_vault() {
  # $1 = path; returns 0 if $1 is a symlink resolving to vault AGENTS.md
  local p="$1"
  [ -L "$p" ] || return 1
  local real; real="$(readlink -f "$p" 2>/dev/null || true)"
  [ "$real" = "$VAULT_AGENTS" ]
}

is_symlink_to_agents_sibling() {
  local p="$1"
  [ -L "$p" ] || return 1
  local target; target="$(readlink "$p")"
  [ "$target" = "AGENTS.md" ] || [ "$target" = "./AGENTS.md" ]
}

already_canonical() {
  is_symlink_to_vault "$CODE_AGENTS" && is_symlink_to_agents_sibling "$CODE_CLAUDE" && [ -f "$VAULT_AGENTS" ]
}

if already_canonical; then
  log "AGENTS/CLAUDE symlinks already canonical, skipping file work"
else
  # Determine content source
  a_exists_real=0; c_exists_real=0
  [ -e "$CODE_AGENTS" ] && [ ! -L "$CODE_AGENTS" ] && a_exists_real=1
  [ -e "$CODE_CLAUDE" ] && [ ! -L "$CODE_CLAUDE" ] && c_exists_real=1

  # Divergent-files guard
  if [ "$a_exists_real" = "1" ] && [ "$c_exists_real" = "1" ]; then
    if ! diff -q "$CODE_AGENTS" "$CODE_CLAUDE" >/dev/null 2>&1; then
      log "WARN: $CODE_AGENTS and $CODE_CLAUDE differ ($(diff "$CODE_AGENTS" "$CODE_CLAUDE" | wc -l | tr -d ' ') diff lines). Skipping file convergence for this project."
      log "WARN: to reconcile, edit files manually then re-run: adopt-project.sh $SLUG"
      SKIP_FILE_WORK=1
    fi
  fi

  if [ "${SKIP_FILE_WORK:-0}" != "1" ]; then
    # Pick content
    CONTENT_SRC=""
    if [ "$a_exists_real" = "1" ]; then
      CONTENT_SRC="$CODE_AGENTS"
    elif [ "$c_exists_real" = "1" ]; then
      CONTENT_SRC="$CODE_CLAUDE"
    elif [ -L "$CODE_AGENTS" ]; then
      # AGENTS.md is symlink somewhere; follow it
      real="$(readlink -f "$CODE_AGENTS" 2>/dev/null || true)"
      [ -f "$real" ] && CONTENT_SRC="$real"
    elif [ -L "$CODE_CLAUDE" ]; then
      real="$(readlink -f "$CODE_CLAUDE" 2>/dev/null || true)"
      [ -f "$real" ] && CONTENT_SRC="$real"
    fi

    # If vault already has AGENTS.md and code has nothing, keep vault content
    if [ -z "$CONTENT_SRC" ] && [ -f "$VAULT_AGENTS" ]; then
      log "no code-side content; vault AGENTS.md already exists, keeping it"
    else
      if [ -n "$CONTENT_SRC" ] && [ -f "$VAULT_AGENTS" ] && ! diff -q "$CONTENT_SRC" "$VAULT_AGENTS" >/dev/null 2>&1; then
        log "WARN: vault already has AGENTS.md and code content differs. Keeping code content (overwriting vault)."
      fi
      if [ -n "$CONTENT_SRC" ]; then
        log "writing vault AGENTS.md from $CONTENT_SRC"
        run "cp '$CONTENT_SRC' '$VAULT_AGENTS'"
      elif [ ! -f "$VAULT_AGENTS" ]; then
        log "writing template vault AGENTS.md"
        run "printf '# %s\n\nProject at %s.\n\nWhere to write what:\n- Agent instructions: this file\n- Structured docs: docs/\n- Ephemeral captures: notes/inbox.md\n' '$SLUG' '$CODE' > '$VAULT_AGENTS'"
      fi
    fi

    # Remove code-side real files and any wrong-direction symlinks
    if [ -e "$CODE_AGENTS" ] || [ -L "$CODE_AGENTS" ]; then
      run "rm -f '$CODE_AGENTS'"
    fi
    if [ -e "$CODE_CLAUDE" ] || [ -L "$CODE_CLAUDE" ]; then
      run "rm -f '$CODE_CLAUDE'"
    fi

    # Create canonical symlinks. Relative link from code → vault (portable across
    # laptop / AX41 if both use identical structure).
    REL_TO_VAULT="$(python3 -c "import os,sys; print(os.path.relpath('$VAULT_AGENTS', os.path.dirname('$CODE_AGENTS')))")"
    run "ln -s '$REL_TO_VAULT' '$CODE_AGENTS'"
    run "ln -s 'AGENTS.md' '$CODE_CLAUDE'"
    log "symlinks set: code/AGENTS.md -> $REL_TO_VAULT; code/CLAUDE.md -> AGENTS.md"
  fi
fi

# 3. notes/ adoption
CODE_NOTES="$CODE/notes"
VAULT_NOTES="$VAULT/notes"

if [ -L "$CODE_NOTES" ]; then
  real="$(readlink -f "$CODE_NOTES" 2>/dev/null || true)"
  if [ "$real" != "$VAULT_NOTES" ]; then
    log "notes symlink points at $real, repointing to $VAULT_NOTES"
    run "rm '$CODE_NOTES'"
    run "ln -s '$(python3 -c "import os; print(os.path.relpath('$VAULT_NOTES', os.path.dirname('$CODE_NOTES')))")' '$CODE_NOTES'"
  fi
elif [ -d "$CODE_NOTES" ]; then
  log "code/notes is a real dir; merging contents into vault/notes"
  # Move each item; skip on collision (log). shopt guards handle empty globs.
  shopt -s nullglob dotglob
  for f in "$CODE_NOTES"/*; do
    base="$(basename "$f")"
    # Skip . and .. defensively (dotglob shouldn't include them, but be safe)
    [ "$base" = "." ] || [ "$base" = ".." ] && continue
    dest="$VAULT_NOTES/$base"
    if [ -e "$dest" ]; then
      log "  collision at $dest — leaving $f in place under $CODE_NOTES.bak-adopt/"
      run "mkdir -p '$CODE_NOTES.bak-adopt' && mv '$f' '$CODE_NOTES.bak-adopt/'"
    else
      run "mv '$f' '$dest'"
    fi
  done
  shopt -u nullglob dotglob
  # If code/notes is now empty, remove and symlink
  if [ -z "$(ls -A "$CODE_NOTES" 2>/dev/null || true)" ]; then
    run "rmdir '$CODE_NOTES'"
    run "ln -s '$(python3 -c "import os; print(os.path.relpath('$VAULT_NOTES', os.path.dirname('$CODE_NOTES')))")' '$CODE_NOTES'"
  else
    log "WARN: $CODE_NOTES not empty after merge (see .bak-adopt/); leaving as-is"
  fi
else
  # No code/notes at all — create symlink
  REL_NOTES="$(python3 -c "import os; print(os.path.relpath('$VAULT_NOTES', os.path.dirname('$CODE_NOTES')))")"
  run "ln -s '$REL_NOTES' '$CODE_NOTES'"
fi

# Ensure vault/notes/inbox.md exists
if [ ! -f "$VAULT_NOTES/inbox.md" ]; then
  run "printf '# %s inbox\n' '$SLUG' > '$VAULT_NOTES/inbox.md'"
fi

# 4. state.db row (via sqlite3 CLI to avoid needing the bot process)
if [ "$DRY_RUN" = "0" ]; then
  # Ensure the DB exists with the minimum schema before insert. The bot
  # runs the full migration set on startup; here we create only the
  # channels table so pre-Slack adoption isn't blocked on the bot ever
  # having been started.
  if [ ! -f "$STATE_DB" ]; then
    log "state.db not found at $STATE_DB — creating with channels table only"
    run "mkdir -p '$(dirname "$STATE_DB")'"
    sqlite3 "$STATE_DB" <<'DDL'
CREATE TABLE IF NOT EXISTS channels (
  slack_channel_id  TEXT PRIMARY KEY,
  slack_channel_name TEXT NOT NULL,
  vault_path        TEXT NOT NULL,
  code_path         TEXT,
  additional_paths  TEXT DEFAULT '[]',
  provider_default  TEXT NOT NULL DEFAULT 'codex',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  group_name        TEXT,
  name              TEXT,
  mode              TEXT NOT NULL DEFAULT 'agent-auto',
  bot_user_id       TEXT,
  canvas_id         TEXT,
  list_id           TEXT,
  list_title_column_id TEXT,
  list_completed_column_id TEXT
);
-- Migrated projects insert with slack_channel_id = NULL. SQLite (unlike
-- the SQL standard) permits NULL in a TEXT PRIMARY KEY column. The bot's
-- attachSlackChannelToCodePath UPDATEs the row when the channel_created
-- event fires; migrate-projects.sh also attaches directly for the
-- name_taken / existing-channel path where no event fires.
DDL
  fi

  GROUP_NAME=""
  if [[ "$REL" == */* ]]; then GROUP_NAME="${REL%%/*}"; fi
  NAME="${REL##*/}"

  # Escape single quotes for safe SQL interpolation (channels rarely have
  # them but Tejas's future projects could — being paranoid).
  esc() { printf %s "$1" | sed "s/'/''/g"; }
  q_slug=$(esc "$SLUG")
  q_vault=$(esc "$VAULT")
  q_code=$(esc "$CODE")
  q_group=$(esc "$GROUP_NAME")
  q_name=$(esc "$NAME")
  # INSERT if no row exists with matching code_path; else UPDATE the paths.
  # slack_channel_id is NULL for pre-Slack rows — bot's attach path fills it.
  sqlite3 "$STATE_DB" <<SQL
INSERT INTO channels
  (slack_channel_id, slack_channel_name, vault_path, code_path,
   additional_paths, provider_default, group_name, name, mode)
SELECT NULL, '$q_slug', '$q_vault', '$q_code', '[]', 'codex', '$q_group', '$q_name', 'agent-auto'
WHERE NOT EXISTS (SELECT 1 FROM channels WHERE code_path = '$q_code');
UPDATE channels SET vault_path='$q_vault', group_name='$q_group', name='$q_name'
  WHERE code_path = '$q_code';
SQL
  log "state.db row upserted for $CODE (slack_channel_id=NULL, awaiting attach)"
fi

log "adoption complete"
