#!/usr/bin/env bash
# Points every git checkout on this machine at scripts/git-hooks, whose pre-push refuses a push
# that rewrites history the remote already has (refuse-history-rewrite) and whose dispatcher runs
# each repository's own hooks as git otherwise would. Git 2.43 has no hooks in config, so a
# machine-wide core.hooksPath is how one check reaches every checkout and worktree.
#
#   --system  (root) installs to /usr/local/share/concierge-git-hooks and sets core.hooksPath in
#             the system config of every git on this machine. remote-box's deploy runs it on the
#             box through install-codex-stop-hook.sh; the Mac runs that with its password once.
#   --user    installs to ~/.local/share/concierge-git-hooks and sets it in this user's global
#             config, needing no password: the Mac's unattended update runs this every time.
# A checkout that sets its own core.hooksPath overrides both and must call the check itself
# (slack-concierge's .githooks/pre-push does). Idempotent; refuses to replace a hooks path it did
# not set.
set -euo pipefail

mode=${1:-}
here=$(cd "$(dirname "$0")" && pwd)
case "$mode" in
  --system) dir=/usr/local/share/concierge-git-hooks; scope=--system ;;
  --user) dir="$HOME/.local/share/concierge-git-hooks"; scope=--global ;;
  *) echo "Usage: $0 --system|--user" >&2; exit 2 ;;
esac

hooks="applypatch-msg pre-applypatch post-applypatch pre-commit pre-merge-commit prepare-commit-msg
commit-msg post-commit pre-rebase post-checkout post-merge pre-push pre-receive update proc-receive
post-receive post-update reference-transaction push-to-checkout pre-auto-gc post-rewrite
sendemail-validate post-index-change p4-changelist p4-prepare-changelist p4-post-changelist p4-pre-submit"

mkdir -p "$dir"
install -m 0755 "$here/git-hooks/dispatch" "$dir/dispatch"
install -m 0755 "$here/git-hooks/refuse-history-rewrite" "$dir/refuse-history-rewrite"
for name in $hooks; do ln -sfn dispatch "$dir/$name"; done

gits=$(for g in /usr/bin/git /opt/homebrew/bin/git /usr/local/bin/git "$(command -v git || true)"; do [ -x "$g" ] && echo "$g"; done | sort -u)
for g in $gits; do
  current=$("$g" config "$scope" --get core.hooksPath 2>/dev/null || true)
  if [ -n "$current" ] && [ "$current" != "$dir" ]; then
    echo "$g $scope core.hooksPath is $current, not set by this installer; add the pre-push check there by hand." >&2
    exit 1
  fi
  "$g" config "$scope" core.hooksPath "$dir"
  echo "$g $scope core.hooksPath -> $dir"
done
