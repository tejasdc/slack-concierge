#!/usr/bin/env bash

set -euo pipefail

LANE_COUNT=4
CONTROL_ROOT=${CONCIERGE_SANDBOX_CONTROL_ROOT:-/var/lib/slack-concierge-sandbox/control}
LANE_ROOT=${CONCIERGE_SANDBOX_LANE_ROOT:-/var/lib/slack-concierge-sandbox/lanes}
CONFIG_ROOT=${CONCIERGE_SANDBOX_CONFIG_ROOT:-/etc/concierge/sandbox/lanes}
BUN_BIN=${CONCIERGE_BUN_BIN:-/root/.bun/bin/bun}
START_TIMEOUT_SECONDS=${CONCIERGE_SANDBOX_START_TIMEOUT_SECONDS:-60}
OWNER_PUBLICATION_TIMEOUT_SECONDS=${CONCIERGE_SANDBOX_OWNER_PUBLICATION_TIMEOUT_SECONDS:-1}
WAIT_RECHECK_SECONDS=${CONCIERGE_SANDBOX_WAIT_RECHECK_SECONDS:-0.1}
CAPTURE_PORT_BASE=${CONCIERGE_SANDBOX_CAPTURE_PORT_BASE:-8180}
COMMAND=${1:-}
SCRIPT_PATH=$(realpath "$0")

usage() {
  printf '%s\n' \
    'Usage:' \
    '  sandbox-lane-control.sh claim --owner TEXT --worktree PATH [--requester TEXT] [--label TEXT] [--no-wait]' \
    '  sandbox-lane-control.sh status' \
    '  sandbox-lane-control.sh reload --lane 1..4 --run-id ID' \
    '  sandbox-lane-control.sh release --lane 1..4 --run-id ID [--timeout SECONDS]' >&2
  exit 2
}

fail_json() {
  local exit_code=$1
  local message=$2
  jq -cn --arg status error --arg error "$message" '{status:$status,error:$error}'
  exit "$exit_code"
}

require_commands() {
  local command_name
  for command_name in flock jq git realpath sha256sum nohup openssl setpriv; do
    command -v "$command_name" >/dev/null || fail_json 2 "required command is unavailable: $command_name"
  done
}

ensure_roots() {
  install -d -m 0700 "$CONTROL_ROOT" "$LANE_ROOT"
}

validate_lane() {
  local lane=$1
  [[ "$lane" =~ ^[1-4]$ ]] || fail_json 2 "lane must be an integer from 1 through 4"
}

canonical_worktree() {
  local requested=$1
  CANONICAL_WORKTREE=$(realpath -e "$requested") || fail_json 2 "worktree does not exist: $requested"
  git -C "$CANONICAL_WORKTREE" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || fail_json 2 "worktree is not a Git checkout: $CANONICAL_WORKTREE"
  test -f "$CANONICAL_WORKTREE/bot/src/index.ts" \
    || fail_json 2 "worktree does not contain bot/src/index.ts: $CANONICAL_WORKTREE"
}

source_identity() {
  local worktree=$1
  local git_sha branch dirty_digest source_id untracked_path untracked_object
  git_sha=$(git -C "$worktree" rev-parse HEAD)
  branch=$(git -C "$worktree" symbolic-ref --short -q HEAD || printf 'detached')

  if git -C "$worktree" diff --quiet HEAD -- \
    && test -z "$(git -C "$worktree" ls-files --others --exclude-standard)"; then
    dirty_digest=""
    source_id=$git_sha
  else
    dirty_digest=$(
      {
        git -C "$worktree" diff --binary HEAD --
        git -C "$worktree" status --porcelain=v2 -z --untracked-files=all
        while IFS= read -r -d '' untracked_path; do
          printf '%s\0' "$untracked_path"
          untracked_object=$(git -C "$worktree" hash-object --no-filters -- "$untracked_path" 2>/dev/null || printf 'unsupported')
          printf '%s\0' "$untracked_object"
        done < <(git -C "$worktree" ls-files --others --exclude-standard -z)
      } | sha256sum | awk '{print $1}'
    )
    source_id="${git_sha}+${dirty_digest:0:16}"
  fi

  jq -cn \
    --arg git_sha "$git_sha" \
    --arg branch "$branch" \
    --arg dirty_digest "$dirty_digest" \
    --arg source_id "$source_id" \
    '{git_sha:$git_sha,branch:$branch,dirty_digest:($dirty_digest | if length > 0 then . else null end),source_id:$source_id}'
}

process_start_ticks() {
  local pid=$1
  awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true
}

boot_id() {
  tr -d '\n' </proc/sys/kernel/random/boot_id
}

process_identity_is_live() {
  local pid=$1 expected_ticks=$2 expected_boot_id=$3
  test "$expected_boot_id" = "$(boot_id)" || return 1
  test -n "$expected_ticks" || return 1
  test "$expected_ticks" = "$(process_start_ticks "$pid")" || return 1
  kill -0 "$pid" 2>/dev/null
}

atomic_json_write() {
  local destination=$1
  local temporary="${destination}.tmp.$$.$RANDOM"
  umask 077
  jq . >"$temporary"
  mv "$temporary" "$destination"
}

lane_lock_path() {
  printf '%s/lane-%s.lock\n' "$CONTROL_ROOT" "$1"
}

lane_owner_path() {
  printf '%s/lane-%s.owner.json\n' "$CONTROL_ROOT" "$1"
}

lane_status_json() {
  local lane=$1 lock_path owner_path lock_fd owner_json
  lock_path=$(lane_lock_path "$lane")
  owner_path=$(lane_owner_path "$lane")
  exec {lock_fd}>"$lock_path"
  if flock -n "$lock_fd"; then
    flock -u "$lock_fd"
    exec {lock_fd}>&-
    if test -s "$owner_path" && jq -e . "$owner_path" >/dev/null 2>&1; then
      owner_json=$(jq -c . "$owner_path")
      jq -cn --argjson lane "$lane" --argjson stale "$owner_json" \
        '{lane:$lane,status:"free",stale_owner:$stale}'
    else
      jq -cn --argjson lane "$lane" '{lane:$lane,status:"free"}'
    fi
  else
    exec {lock_fd}>&-
    if test -s "$owner_path" && jq -e . "$owner_path" >/dev/null 2>&1; then
      owner_json=$(jq -c . "$owner_path")
      jq -cn --argjson lane "$lane" --argjson owner "$owner_json" \
        '{lane:$lane,status:"occupied",owner:$owner}'
    else
      jq -cn --argjson lane "$lane" \
        '{lane:$lane,status:"occupied",owner:null}'
    fi
  fi
}

all_lane_statuses() {
  local lane
  for lane in $(seq 1 "$LANE_COUNT"); do
    lane_status_json "$lane"
  done | jq -cs .
}

all_occupied_owners_are_published() {
  local lane owner_path
  for lane in $(seq 1 "$LANE_COUNT"); do
    owner_path=$(lane_owner_path "$lane")
    test -s "$owner_path" && jq -e '.owner | type == "string" and length > 0' "$owner_path" >/dev/null 2>&1 \
      || return 1
  done
}

write_request() {
  local request_path=$1 run_id=$2 lane=$3 owner=$4 requester=$5 label=$6 worktree=$7 source=$8 expected_identity=$9 fixtures=${10}
  jq -cn \
    --arg run_id "$run_id" \
    --argjson lane "$lane" \
    --arg owner "$owner" \
    --arg requester "$requester" \
    --arg label "$label" \
    --arg worktree "$worktree" \
    --argjson source "$source" \
    --argjson expected_identity "$expected_identity" \
    --argjson fixtures "$fixtures" \
    '{run_id:$run_id,lane:$lane,owner:$owner,requester:($requester | if length > 0 then . else null end),label:($label | if length > 0 then . else null end),worktree:$worktree,source:$source,expected_identity:$expected_identity,fixtures:$fixtures}' \
    | atomic_json_write "$request_path"
}

write_metadata() {
  local destination=$1 request_path=$2 status=$3 supervisor_pid=$4 supervisor_ticks=$5
  local candidate_pid=${6:-} candidate_ticks=${7:-} generation=${8:-0} exit_code=${9:-}
  local source=${10:-null} started_at=${11:-} updated_at=${12:-}
  local run_id lane owner requester label worktree run_root capture_port expected_identity fixtures browser_profile
  run_id=$(jq -r .run_id "$request_path")
  lane=$(jq -r .lane "$request_path")
  owner=$(jq -r .owner "$request_path")
  requester=$(jq -r '.requester // ""' "$request_path")
  label=$(jq -r '.label // ""' "$request_path")
  worktree=$(jq -r .worktree "$request_path")
  expected_identity=$(jq -c .expected_identity "$request_path")
  fixtures=$(jq -c .fixtures "$request_path")
  browser_profile=$(jq -r .fixtures.browser.profile_path "$request_path")
  run_root="$LANE_ROOT/lane-$lane/runs/$run_id"
  capture_port=$((CAPTURE_PORT_BASE + lane))
  test "$source" != null || source=$(jq -c .source "$request_path")

  jq -cn \
    --arg run_id "$run_id" \
    --argjson lane "$lane" \
    --arg owner "$owner" \
    --arg requester "$requester" \
    --arg label "$label" \
    --arg worktree "$worktree" \
    --arg status "$status" \
    --arg started_at "$started_at" \
    --arg updated_at "$updated_at" \
    --argjson source "$source" \
    --argjson lane_identity "$expected_identity" \
    --argjson lane_fixtures "$fixtures" \
    --argjson supervisor_pid "$supervisor_pid" \
    --arg supervisor_ticks "$supervisor_ticks" \
    --arg supervisor_boot_id "$(boot_id)" \
    --arg candidate_pid "$candidate_pid" \
    --arg candidate_ticks "$candidate_ticks" \
    --arg generation "$generation" \
    --arg exit_code "$exit_code" \
    --arg config_path "$CONFIG_ROOT/lane-$lane/slack.toml" \
    --arg fixtures_path "$CONFIG_ROOT/lane-$lane/fixtures.json" \
    --arg browser_profile "$browser_profile" \
    --arg state_dir "$run_root/state" \
    --arg capture_state_dir "$run_root/capture-state" \
    --arg evidence_dir "$run_root/evidence" \
    --arg workspace_root "$run_root/workspace" \
    --arg candidate_log "$run_root/candidate.log" \
    --arg ready_file "$run_root/state/ready.json" \
    --argjson capture_port "$capture_port" \
    '{
      run_id:$run_id,
      lane:$lane,
      owner:$owner,
      requester:($requester | if length > 0 then . else null end),
      label:($label | if length > 0 then . else null end),
      worktree:$worktree,
      source:$source,
      lane_identity:$lane_identity,
      lane_fixtures:$lane_fixtures,
      status:$status,
      started_at:$started_at,
      updated_at:$updated_at,
      generation:($generation | tonumber),
      supervisor:{pid:$supervisor_pid,start_ticks:$supervisor_ticks,boot_id:$supervisor_boot_id},
      candidate:(if $candidate_pid == "" then null else {pid:($candidate_pid | tonumber),start_ticks:$candidate_ticks} end),
      exit_code:(if $exit_code == "" then null else ($exit_code | tonumber) end),
      paths:{config:$config_path,fixtures:$fixtures_path,browser_profile:$browser_profile,state:$state_dir,capture_state:$capture_state_dir,evidence:$evidence_dir,workspace:$workspace_root,candidate_log:$candidate_log,ready_file:$ready_file},
      reserved_capture:{url:("http://127.0.0.1:" + ($capture_port | tostring)),port:$capture_port,token_file:($state_dir + "/capture-queue.token"),active:false}
    }' | atomic_json_write "$destination"
}

remove_active_owner_if_current() {
  local owner_path=$1 run_id=$2
  if test -s "$owner_path" && test "$(jq -r '.run_id // ""' "$owner_path" 2>/dev/null)" = "$run_id"; then
    rm -f "$owner_path"
  fi
}

ready_receipt_matches() {
  local ready_file=$1 candidate_pid=$2 run_id=$3 lane=$4 request_path=$5
  local expected_team_id expected_app_id expected_bot_user_id expected_bot_id
  expected_team_id=$(jq -r .expected_identity.team_id "$request_path")
  expected_app_id=$(jq -r .expected_identity.app_id "$request_path")
  expected_bot_user_id=$(jq -r .expected_identity.bot_user_id "$request_path")
  expected_bot_id=$(jq -r .expected_identity.bot_id "$request_path")
  jq -e \
    --argjson candidate_pid "$candidate_pid" \
    --arg run_id "$run_id" \
    --argjson lane "$lane" \
    --arg team_id "$expected_team_id" \
    --arg app_id "$expected_app_id" \
    --arg bot_user_id "$expected_bot_user_id" \
    --arg bot_id "$expected_bot_id" \
    '.schema_version == 1
      and .pid == $candidate_pid
      and .run_id == $run_id
      and .lane == $lane
      and .team_id == $team_id
      and .app_id == $app_id
      and .bot_user_id == $bot_user_id
      and .bot_id == $bot_id
      and (.ready_at | type == "string" and length > 0)' \
    "$ready_file" >/dev/null 2>&1
}

wait_for_candidate_exit() {
  local candidate_pid=$1 wait_status
  set +e
  while true; do
    wait "$candidate_pid"
    wait_status=$?
    kill -0 "$candidate_pid" 2>/dev/null || break
  done
  set -e
  CANDIDATE_EXIT_STATUS=$wait_status
}

claim_lane() {
  shift
  local owner="" requester="" label="" worktree="" wait_for_lane=1 waiting_announced=0
  while (($#)); do
    case "$1" in
      --owner) owner=${2:-}; shift 2 ;;
      --requester) requester=${2:-}; shift 2 ;;
      --label) label=${2:-}; shift 2 ;;
      --worktree) worktree=${2:-}; shift 2 ;;
      --no-wait) wait_for_lane=0; shift ;;
      *) usage ;;
    esac
  done
  test -n "$owner" || fail_json 2 "--owner is required"
  test -n "$worktree" || fail_json 2 "--worktree is required"
  canonical_worktree "$worktree"
  worktree=$CANONICAL_WORKTREE

  local lane lock_path lock_fd run_id lane_directory run_root request_path owner_path source
  local config_path identity_path fixtures_path expected_identity fixtures config_mode
  local lanes publication_deadline supervisor_pid=""
  cancel_claim() {
    trap - TERM INT
    test -z "$supervisor_pid" || kill -TERM "$supervisor_pid" 2>/dev/null || true
    exit 130
  }
  trap cancel_claim TERM INT

  while true; do
    for lane in $(seq 1 "$LANE_COUNT"); do
    lock_path=$(lane_lock_path "$lane")
    exec {lock_fd}>"$lock_path"
    if ! flock -n "$lock_fd"; then
      exec {lock_fd}>&-
      continue
    fi

    run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
    lane_directory="$LANE_ROOT/lane-$lane"
    run_root="$lane_directory/runs/$run_id"
    request_path="$run_root/request.json"
    owner_path=$(lane_owner_path "$lane")
    config_path="$CONFIG_ROOT/lane-$lane/slack.toml"
    identity_path="$CONFIG_ROOT/lane-$lane/identity.json"
    fixtures_path="$CONFIG_ROOT/lane-$lane/fixtures.json"
    if test -L "$config_path" || test -L "$identity_path" || test -L "$fixtures_path"; then
      exec {lock_fd}>&-
      fail_json 2 "sandbox lane $lane configuration files must be regular files, not symlinks"
    fi
    if ! test -f "$config_path" || ! test -f "$identity_path" || ! test -f "$fixtures_path"; then
      exec {lock_fd}>&-
      fail_json 2 "sandbox lane $lane configuration is incomplete under $CONFIG_ROOT/lane-$lane"
    fi
    if ! expected_identity=$(jq -ce --arg lane_id "lane-$lane" '
      select(.schema_version == 1)
      | select(.lane_id == $lane_id)
      | {schema_version,lane_id,team_id,app_id,bot_user_id,bot_id,manifest_digest}
      | select(.team_id | test("^T[A-Z0-9]+$"))
      | select(.app_id | test("^A[A-Z0-9]+$"))
      | select(.bot_user_id | test("^U[A-Z0-9]+$"))
      | select(.bot_id | test("^B[A-Z0-9]+$"))
      | select(.manifest_digest | test("^[a-f0-9]{64}$"))
    ' "$identity_path" 2>/dev/null); then
      exec {lock_fd}>&-
      fail_json 2 "sandbox lane $lane identity metadata is missing or invalid: $identity_path"
    fi
    if ! fixtures=$(jq -ce --arg lane_id "lane-$lane" '
      select(.schema_version == 1)
      | select(.lane_id == $lane_id)
      | select(.installer_user_id | test("^U[A-Z0-9]+$"))
      | select(.dm_channel_id | test("^D[A-Z0-9]+$"))
      | select([.channels.core,.channels.project,.channels.capture] | all(.id | test("^C[A-Z0-9]+$")))
      | select([.channels.core,.channels.project,.channels.capture] | all(.name | test("^[a-z0-9-]+$")))
      | select(.browser.namespace | test("^[a-z0-9-]+$"))
      | select(.browser.profile_path | type == "string" and startswith("/"))
    ' "$fixtures_path" 2>/dev/null); then
      exec {lock_fd}>&-
      fail_json 2 "sandbox lane $lane fixture metadata is missing or invalid: $fixtures_path"
    fi
    test -r "$config_path" || {
      exec {lock_fd}>&-
      fail_json 2 "sandbox lane $lane Slack configuration is unreadable: $config_path"
    }
    config_mode=$(stat -c '%a' "$config_path")
    if ((8#$config_mode & 077)); then
      exec {lock_fd}>&-
      fail_json 2 "sandbox lane $lane Slack configuration must not be group- or world-accessible: $config_path"
    fi
    install -d -m 0700 "$run_root/state" "$run_root/capture-state" "$run_root/evidence" "$run_root/workspace"
    umask 077
    openssl rand -hex 32 >"$run_root/state/capture-queue.token"
    chmod 0600 "$run_root/state/capture-queue.token"
    source=$(source_identity "$worktree")
    write_request "$request_path" "$run_id" "$lane" "$owner" "$requester" "$label" "$worktree" "$source" "$expected_identity" "$fixtures"
    write_metadata "$owner_path" "$request_path" starting 0 "" "" "" 0 "" "$source" \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    nohup "$SCRIPT_PATH" _supervise "$lane" "$lock_fd" "$request_path" \
      >>"$run_root/supervisor.log" 2>&1 </dev/null &
    supervisor_pid=$!
    # The supervisor owns the readiness deadline and diagnostic finalization.
    # Give it a small handoff window before treating the supervisor itself as stuck.
    local deadline=$((SECONDS + START_TIMEOUT_SECONDS + 2))
    while ((SECONDS <= deadline)); do
      if test -s "$owner_path" \
        && test "$(jq -r '.run_id // ""' "$owner_path" 2>/dev/null)" = "$run_id" \
        && test "$(jq -r '.status // ""' "$owner_path" 2>/dev/null)" = running; then
        jq -c . "$owner_path"
        exec {lock_fd}>&-
        trap - TERM INT
        return 0
      fi
      if ! kill -0 "$supervisor_pid" 2>/dev/null; then
        remove_active_owner_if_current "$owner_path" "$run_id"
        exec {lock_fd}>&-
        fail_json 1 "sandbox lane $lane supervisor exited before the candidate became ready; see $run_root/supervisor.log"
      fi
      sleep 0.05
    done

    kill -TERM "$supervisor_pid" 2>/dev/null || true
    exec {lock_fd}>&-
    fail_json 1 "sandbox lane $lane supervisor did not settle after the $START_TIMEOUT_SECONDS-second readiness deadline; run $run_id remains visible until it drains"
    done

    publication_deadline=$((SECONDS + OWNER_PUBLICATION_TIMEOUT_SECONDS))
    while ((SECONDS <= publication_deadline)) && ! all_occupied_owners_are_published; do
      sleep 0.02
    done
    lanes=$(all_lane_statuses)
    if test "$wait_for_lane" = 0; then
      trap - TERM INT
      jq -cn --arg status busy --arg error "all four sandbox lanes are occupied" --argjson lanes "$lanes" \
        '{status:$status,error:$error,lanes:$lanes}'
      return 10
    fi
    if test "$waiting_announced" = 0; then
      jq -cn --arg status waiting --arg message "all four sandbox lanes are occupied; waiting for the first released lane" --argjson lanes "$lanes" \
        '{status:$status,message:$message,lanes:$lanes}'
      waiting_announced=1
    fi
    sleep "$WAIT_RECHECK_SECONDS"
  done
}

status_lanes() {
  local lanes
  lanes=$(all_lane_statuses)
  jq -cn --arg status ok --argjson lanes "$lanes" '{status:$status,lanes:$lanes}'
}

load_current_owner() {
  local lane=$1 run_id=$2 owner_path metadata_pid metadata_ticks metadata_boot_id
  owner_path=$(lane_owner_path "$lane")
  test -s "$owner_path" || fail_json 11 "sandbox lane $lane has no active owner"
  jq -e . "$owner_path" >/dev/null 2>&1 || fail_json 11 "sandbox lane $lane owner metadata is unreadable"
  test "$(jq -r .run_id "$owner_path")" = "$run_id" \
    || fail_json 11 "sandbox lane $lane is owned by a different run"
  metadata_pid=$(jq -r .supervisor.pid "$owner_path")
  metadata_ticks=$(jq -r .supervisor.start_ticks "$owner_path")
  metadata_boot_id=$(jq -r .supervisor.boot_id "$owner_path")
  process_identity_is_live "$metadata_pid" "$metadata_ticks" "$metadata_boot_id" \
    || fail_json 11 "sandbox lane $lane owner process identity is no longer live"
  CURRENT_OWNER_PATH=$owner_path
}

reload_lane() {
  shift
  local lane="" run_id=""
  while (($#)); do
    case "$1" in
      --lane) lane=${2:-}; shift 2 ;;
      --run-id) run_id=${2:-}; shift 2 ;;
      *) usage ;;
    esac
  done
  validate_lane "$lane"
  test -n "$run_id" || fail_json 2 "--run-id is required"
  local owner_path supervisor_pid old_generation deadline
  load_current_owner "$lane" "$run_id"
  owner_path=$CURRENT_OWNER_PATH
  supervisor_pid=$(jq -r .supervisor.pid "$owner_path")
  old_generation=$(jq -r .generation "$owner_path")
  kill -USR1 "$supervisor_pid"
  deadline=$((SECONDS + START_TIMEOUT_SECONDS))
  while ((SECONDS <= deadline)); do
    if test -s "$owner_path" \
      && test "$(jq -r '.run_id // ""' "$owner_path" 2>/dev/null)" = "$run_id" \
      && test "$(jq -r '.status // ""' "$owner_path" 2>/dev/null)" = running \
      && test "$(jq -r '.generation // 0' "$owner_path" 2>/dev/null)" -gt "$old_generation"; then
      jq -c . "$owner_path"
      return 0
    fi
    kill -0 "$supervisor_pid" 2>/dev/null \
      || fail_json 1 "sandbox lane $lane supervisor exited while reloading"
    sleep 0.05
  done
  fail_json 12 "sandbox lane $lane did not reload within $START_TIMEOUT_SECONDS seconds"
}

release_lane() {
  shift
  local lane="" run_id="" timeout=30
  while (($#)); do
    case "$1" in
      --lane) lane=${2:-}; shift 2 ;;
      --run-id) run_id=${2:-}; shift 2 ;;
      --timeout) timeout=${2:-}; shift 2 ;;
      *) usage ;;
    esac
  done
  validate_lane "$lane"
  [[ "$timeout" =~ ^[0-9]+$ ]] || fail_json 2 "--timeout must be a non-negative integer"
  test -n "$run_id" || fail_json 2 "--run-id is required"
  local owner_path supervisor_pid deadline lock_path lock_fd run_path
  load_current_owner "$lane" "$run_id"
  owner_path=$CURRENT_OWNER_PATH
  supervisor_pid=$(jq -r .supervisor.pid "$owner_path")
  run_path="$LANE_ROOT/lane-$lane/runs/$run_id/run.json"
  kill -TERM "$supervisor_pid"
  deadline=$((SECONDS + timeout))
  lock_path=$(lane_lock_path "$lane")
  while ((SECONDS <= deadline)); do
    exec {lock_fd}>"$lock_path"
    if flock -n "$lock_fd"; then
      flock -u "$lock_fd"
      exec {lock_fd}>&-
      if test -s "$run_path"; then
        jq -c . "$run_path"
      else
        jq -cn --arg status released --arg run_id "$run_id" --argjson lane "$lane" \
          '{status:$status,run_id:$run_id,lane:$lane}'
      fi
      return 0
    fi
    exec {lock_fd}>&-
    sleep 0.05
  done
  fail_json 12 "sandbox lane $lane did not drain within $timeout seconds and remains owned by run $run_id"
}

supervise_lane() {
  local lane=$2 lock_fd=$3 request_path=$4
  validate_lane "$lane"
  test -r "/proc/$$/fd/$lock_fd" || fail_json 1 "lane lock file descriptor was not inherited"
  flock -n "$lock_fd" || fail_json 1 "lane lock is not held by this supervisor"

  local run_id owner worktree run_root owner_path run_path ready_file started_at supervisor_ticks
  local expected_team_id expected_app_id expected_bot_user_id expected_bot_id
  run_id=$(jq -r .run_id "$request_path")
  owner=$(jq -r .owner "$request_path")
  worktree=$(jq -r .worktree "$request_path")
  test "$(jq -r .lane "$request_path")" = "$lane" || fail_json 1 "request lane does not match supervisor lane"
  run_root="$LANE_ROOT/lane-$lane/runs/$run_id"
  owner_path=$(lane_owner_path "$lane")
  run_path="$run_root/run.json"
  ready_file="$run_root/state/ready.json"
  expected_team_id=$(jq -r .expected_identity.team_id "$request_path")
  expected_app_id=$(jq -r .expected_identity.app_id "$request_path")
  expected_bot_user_id=$(jq -r .expected_identity.bot_user_id "$request_path")
  expected_bot_id=$(jq -r .expected_identity.bot_id "$request_path")
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  supervisor_ticks=$(process_start_ticks $$)

  local requested_action=run candidate_pid="" candidate_ticks="" candidate_exit="" generation=0 source source_head source_diff_digest updated_at
  request_reload() {
    requested_action=reload
    test -z "$candidate_pid" || kill -TERM "$candidate_pid" 2>/dev/null || true
  }
  request_release() {
    requested_action=release
    test -z "$candidate_pid" || kill -TERM "$candidate_pid" 2>/dev/null || true
  }
  # nohup deliberately makes SIGHUP uncatchable for the exec'd supervisor.
  # SIGUSR1 is therefore the explicit reload control signal.
  trap request_reload USR1
  trap request_release TERM INT

  while true; do
    requested_action=run
    generation=$((generation + 1))
    source=$(source_identity "$worktree")
    source_head=$(printf '%s\n' "$source" | jq -r .git_sha)
    source_diff_digest=$(printf '%s\n' "$source" | jq -r '.dirty_digest // "clean"')
    updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    rm -f "$ready_file"
    write_metadata "$owner_path" "$request_path" starting $$ "$supervisor_ticks" "" "" "$generation" "" "$source" "$started_at" "$updated_at"
    write_metadata "$run_path" "$request_path" starting $$ "$supervisor_ticks" "" "" "$generation" "" "$source" "$started_at" "$updated_at"

    install -d -m 0700 "$run_root/state" "$run_root/capture-state" "$run_root/evidence" "$run_root/workspace"
    (
      cd "$worktree/bot"
      export HOME=${HOME:-/root}
      export CONCIERGE_RUNTIME_PROFILE=sandbox
      export CONCIERGE_TEST_MODE=1
      export CONCIERGE_SANDBOX_LANE=$lane
      export CONCIERGE_SANDBOX_RUN_ID=$run_id
      export CONCIERGE_SANDBOX_OWNER=$owner
      export CONCIERGE_SANDBOX_EXPECTED_TEAM_ID=$expected_team_id
      export CONCIERGE_SANDBOX_EXPECTED_APP_ID=$expected_app_id
      export CONCIERGE_SANDBOX_EXPECTED_BOT_USER_ID=$expected_bot_user_id
      export CONCIERGE_SANDBOX_EXPECTED_BOT_ID=$expected_bot_id
      export CONCIERGE_SANDBOX_READY_FILE=$ready_file
      export CONCIERGE_CONFIG_PATH="$CONFIG_ROOT/lane-$lane/slack.toml"
      export CONCIERGE_SANDBOX_FIXTURES="$CONFIG_ROOT/lane-$lane/fixtures.json"
      export CONCIERGE_SANDBOX_BROWSER_PROFILE="$(jq -r .fixtures.browser.profile_path "$request_path")"
      export CONCIERGE_SANDBOX_CAPTURE_PORT=$((CAPTURE_PORT_BASE + lane))
      export CONCIERGE_STATE_DIR="$run_root/state"
      export CONCIERGE_CAPTURE_STATE_DIR="$run_root/capture-state"
      export CONCIERGE_SANDBOX_EVIDENCE_DIR="$run_root/evidence"
      export CONCIERGE_WORKSPACE_ROOT="$run_root/workspace"
      export CONCIERGE_SANDBOX_SOURCE_HEAD=$source_head
      export CONCIERGE_SANDBOX_SOURCE_DIFF_DIGEST=$source_diff_digest
      exec {lock_fd}>&-
      exec setpriv --pdeathsig TERM "$BUN_BIN" run src/index.ts
    ) >>"$run_root/candidate.log" 2>&1 &
    candidate_pid=$!
    candidate_ticks=$(process_start_ticks "$candidate_pid")
    updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    write_metadata "$owner_path" "$request_path" starting $$ "$supervisor_ticks" "$candidate_pid" "$candidate_ticks" "$generation" "" "$source" "$started_at" "$updated_at"
    write_metadata "$run_path" "$request_path" starting $$ "$supervisor_ticks" "$candidate_pid" "$candidate_ticks" "$generation" "" "$source" "$started_at" "$updated_at"

    local ready_deadline=$((SECONDS + START_TIMEOUT_SECONDS))
    while ! ready_receipt_matches "$ready_file" "$candidate_pid" "$run_id" "$lane" "$request_path"; do
      if ! kill -0 "$candidate_pid" 2>/dev/null; then
        wait_for_candidate_exit "$candidate_pid"
        candidate_exit=$CANDIDATE_EXIT_STATUS
        updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        if test "$requested_action" = reload; then
          write_metadata "$owner_path" "$request_path" reloading $$ "$supervisor_ticks" "" "" "$generation" "$candidate_exit" "$source" "$started_at" "$updated_at"
          write_metadata "$run_path" "$request_path" reloading $$ "$supervisor_ticks" "" "" "$generation" "$candidate_exit" "$source" "$started_at" "$updated_at"
          candidate_pid=""
          continue 2
        fi
        if test "$requested_action" = release; then
          write_metadata "$run_path" "$request_path" released $$ "$supervisor_ticks" "" "" "$generation" "$candidate_exit" "$source" "$started_at" "$updated_at"
          remove_active_owner_if_current "$owner_path" "$run_id"
          return 0
        fi
        write_metadata "$run_path" "$request_path" failed_start $$ "$supervisor_ticks" "" "" "$generation" "$candidate_exit" "$source" "$started_at" "$updated_at"
        remove_active_owner_if_current "$owner_path" "$run_id"
        return 1
      fi
      if ((SECONDS > ready_deadline)); then
        kill -TERM "$candidate_pid" 2>/dev/null || true
        wait_for_candidate_exit "$candidate_pid"
        candidate_exit=$CANDIDATE_EXIT_STATUS
        updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        write_metadata "$run_path" "$request_path" failed_start $$ "$supervisor_ticks" "" "" "$generation" "$candidate_exit" "$source" "$started_at" "$updated_at"
        remove_active_owner_if_current "$owner_path" "$run_id"
        return 1
      fi
      sleep 0.05
    done
    updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    write_metadata "$owner_path" "$request_path" running $$ "$supervisor_ticks" "$candidate_pid" "$candidate_ticks" "$generation" "" "$source" "$started_at" "$updated_at"
    write_metadata "$run_path" "$request_path" running $$ "$supervisor_ticks" "$candidate_pid" "$candidate_ticks" "$generation" "" "$source" "$started_at" "$updated_at"

    wait_for_candidate_exit "$candidate_pid"
    candidate_exit=$CANDIDATE_EXIT_STATUS
    updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    if test "$requested_action" = reload; then
      write_metadata "$owner_path" "$request_path" reloading $$ "$supervisor_ticks" "" "" "$generation" "$candidate_exit" "$source" "$started_at" "$updated_at"
      write_metadata "$run_path" "$request_path" reloading $$ "$supervisor_ticks" "" "" "$generation" "$candidate_exit" "$source" "$started_at" "$updated_at"
      candidate_pid=""
      continue
    fi

    if test "$requested_action" = release; then
      write_metadata "$run_path" "$request_path" released $$ "$supervisor_ticks" "" "" "$generation" "$candidate_exit" "$source" "$started_at" "$updated_at"
      remove_active_owner_if_current "$owner_path" "$run_id"
      return 0
    fi

    write_metadata "$run_path" "$request_path" exited $$ "$supervisor_ticks" "" "" "$generation" "$candidate_exit" "$source" "$started_at" "$updated_at"
    remove_active_owner_if_current "$owner_path" "$run_id"
    return "$candidate_exit"
  done
}

require_commands
[[ "$CAPTURE_PORT_BASE" =~ ^[0-9]+$ ]] || fail_json 2 "CONCIERGE_SANDBOX_CAPTURE_PORT_BASE must be an integer"
[[ "$OWNER_PUBLICATION_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] \
  || fail_json 2 "CONCIERGE_SANDBOX_OWNER_PUBLICATION_TIMEOUT_SECONDS must be a non-negative integer"
[[ "$WAIT_RECHECK_SECONDS" =~ ^[0-9]+([.][0-9]+)?$ ]] \
  || fail_json 2 "CONCIERGE_SANDBOX_WAIT_RECHECK_SECONDS must be a non-negative number"
test "$CAPTURE_PORT_BASE" -ge 1024 && test $((CAPTURE_PORT_BASE + LANE_COUNT)) -le 65535 \
  || fail_json 2 "reserved sandbox capture ports must remain between 1025 and 65535"
ensure_roots

case "$COMMAND" in
  claim) claim_lane "$@" ;;
  status) test "$#" -eq 1 || usage; status_lanes ;;
  reload) reload_lane "$@" ;;
  release) release_lane "$@" ;;
  _supervise) supervise_lane "$@" ;;
  *) usage ;;
esac
