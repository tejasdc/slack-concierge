#!/usr/bin/env bash
# Migrate every project's AGENTS.md from vault-real-with-code-symlink → code-real (no vault dep).
# CLAUDE.md remains a same-dir symlink to AGENTS.md (so it points to the real file too).
# Reversible: original vault file is renamed with .migrated-to-code-repo-<date> and copies saved to $BACKUP.
# Idempotent: skips projects already migrated.
#
# DRY_RUN=1 (default) — only prints planned actions.
# DRY_RUN=0 — actually applies.

set -euo pipefail

VAULT=/root/workspace/vault/projects
WORK=/root/workspace
DATE=$(date +%Y%m%d-%H%M%S)
BACKUP=/root/.local/state/agents-md-migration-backup-$DATE
DRY_RUN="${DRY_RUN:-1}"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

[ "$DRY_RUN" = "0" ] && mkdir -p "$BACKUP"

skipped_deleted=0
skipped_no_code=0
skipped_no_vault_agents=0
skipped_already_real=0
migrated=0
git_init_needed=()
committed=0

for pdir in "$VAULT"/*/; do
  slug=$(basename "$pdir")
  case "$slug" in *.deleted-*) skipped_deleted=$((skipped_deleted+1)); continue ;; esac

  code_dir="$WORK/$slug"
  vault_agents="$pdir/AGENTS.md"
  code_agents="$code_dir/AGENTS.md"
  code_claude="$code_dir/CLAUDE.md"

  if [ ! -d "$code_dir" ]; then
    skipped_no_code=$((skipped_no_code+1))
    log "skip (no code dir): $slug"
    continue
  fi
  if [ ! -e "$vault_agents" ]; then
    skipped_no_vault_agents=$((skipped_no_vault_agents+1))
    continue
  fi
  if [ -f "$code_agents" ] && [ ! -L "$code_agents" ]; then
    skipped_already_real=$((skipped_already_real+1))
    log "skip (already real): $slug"
    continue
  fi

  vault_real=$(realpath "$vault_agents")
  vault_sha=$(sha256sum "$vault_real" | awk '{print $1}')
  vault_size=$(stat -c %s "$vault_real")
  has_git=$([ -d "$code_dir/.git" ] && echo yes || echo no)

  log "MIGRATE $slug (git=$has_git, ${vault_size}B, sha=${vault_sha:0:12})"

  if [ "$DRY_RUN" = "1" ]; then
    migrated=$((migrated+1))
    [ "$has_git" = "no" ] && git_init_needed+=("$slug")
    continue
  fi

  # Backup
  mkdir -p "$BACKUP/$slug"
  cp -a "$vault_real" "$BACKUP/$slug/AGENTS.md.vault"

  # Remove symlink at code/AGENTS.md, replace with real content
  [ -L "$code_agents" ] && rm "$code_agents"
  cp "$vault_real" "$code_agents"

  new_sha=$(sha256sum "$code_agents" | awk '{print $1}')
  if [ "$new_sha" != "$vault_sha" ]; then
    log "SHA MISMATCH for $slug ($new_sha vs $vault_sha) — aborting"
    exit 1
  fi

  # Ensure CLAUDE.md → AGENTS.md same-dir symlink
  if [ -L "$code_claude" ]; then
    target=$(readlink "$code_claude")
    if [ "$target" != "AGENTS.md" ]; then rm "$code_claude"; ln -s AGENTS.md "$code_claude"; fi
  elif [ ! -e "$code_claude" ]; then
    ln -s AGENTS.md "$code_claude"
  fi

  # Move vault AGENTS.md aside so Obsidian doesn't see two copies
  mv "$vault_real" "${vault_real}.migrated-to-code-repo-$DATE"

  # Commit in code repo when git is initialised
  if [ "$has_git" = "yes" ]; then
    (cd "$code_dir" && git add AGENTS.md CLAUDE.md 2>/dev/null || true
     git -c user.email=slack-concierge@ax41 -c user.name="Slack Concierge" commit -m "chore: promote AGENTS.md to real file in code repo

Was symlinked into ~/workspace/vault/projects/<slug>/AGENTS.md.
Vault symlink dropped so agents can commit instruction updates
atomically alongside code changes." >/dev/null 2>&1 && \
      { committed=$((committed+1)); log "committed $slug"; } || log "no changes to commit in $slug"
    ) || true
  else
    git_init_needed+=("$slug")
    log "no git in $code_dir — leaving uncommitted; needs init"
  fi

  migrated=$((migrated+1))
done

echo
echo "=== summary (DRY_RUN=$DRY_RUN) ==="
echo "  migrated:              $migrated"
echo "  committed:             $committed"
echo "  git_init_needed:       ${#git_init_needed[@]}"
[ ${#git_init_needed[@]} -gt 0 ] && printf '    %s\n' "${git_init_needed[@]}"
echo "  skipped_deleted:       $skipped_deleted"
echo "  skipped_no_code_dir:   $skipped_no_code"
echo "  skipped_no_vault:      $skipped_no_vault_agents"
echo "  skipped_already_real:  $skipped_already_real"
[ "$DRY_RUN" = "0" ] && echo "  backup dir:            $BACKUP"
