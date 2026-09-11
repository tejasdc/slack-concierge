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
CAPTURE_INGRESS_PORT_BASE=${CONCIERGE_SANDBOX_CAPTURE_PORT_BASE:-8180}
CAPTURE_QUEUE_PORT_BASE=${CONCIERGE_SANDBOX_CAPTURE_QUEUE_PORT_BASE:-8280}
CAPTURE_BUN_BIN=${CONCIERGE_SANDBOX_CAPTURE_BUN_BIN:-$BUN_BIN}
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

write_sandbox_capture_config() {
  local run_root=$1 lane=$2 dm_channel=$3 worktree=$4
  local journal_sink
  journal_sink=$("$CAPTURE_BUN_BIN" run "$worktree/bot/scripts/sandbox-capture-source.ts" "$worktree/config/capture-routes.toml")
  local ingress_port=$((CAPTURE_INGRESS_PORT_BASE + lane))
  local queue_port=$((CAPTURE_QUEUE_PORT_BASE + lane))
  local state_dir="$run_root/state"
  local credentials_dir="$state_dir/capture-credentials"
  local config_path="$state_dir/capture-routes.toml"
  install -d -m 0700 "$credentials_dir" "$run_root/audio-inbox" "$run_root/journal-inbox"
  umask 077
  openssl rand -hex 32 >"$credentials_dir/capture_queue"
  openssl rand -hex 32 >"$credentials_dir/pebble_index"
  openssl rand -hex 32 >"$credentials_dir/watch_audio"
  openssl rand -hex 32 >"$credentials_dir/thinkering"
  chmod 0400 "$credentials_dir/capture_queue" "$credentials_dir/pebble_index" "$credentials_dir/watch_audio" "$credentials_dir/thinkering"
  chmod 0500 "$credentials_dir"
  printf '%s\n' \
    '[server]' \
    'host = "127.0.0.1"' \
    "port = $ingress_port" \
    'health_path = "/health"' \
    'max_request_body_bytes = 67108864' \
    '[queue]' \
    'host = "127.0.0.1"' \
    "port = $queue_port" \
    'auth_token_credential = "capture_queue"' \
    '[[routes]]' \
    'id = "thinkering"' \
    'path = "/thinkering"' \
    'label = "Thinkering"' \
    'adapter = "thinkering"' \
    'max_body_bytes = 262144' \
    'auth_token_credential = "thinkering"' \
    '[routes.destination]' \
    'type = "slack"' \
    "channel_id = \"$dm_channel\"" \
    '[[routes]]' \
    'id = "watch-audio"' \
    'path = "/audio"' \
    'label = "Watch audio"' \
    'adapter = "raw-body"' \
    'max_body_bytes = 67108864' \
    'auth_header = "Authorization"' \
    'auth_scheme = "Bearer"' \
    'auth_token_credential = "watch_audio"' \
    '[routes.destination]' \
    'type = "directory"' \
    "directory = \"$run_root/audio-inbox\"" \
    'filename_prefix = "audio"' \
    '[[routes]]' \
    'id = "pebble-index"' \
    'path = "/pebble"' \
    'label = "Pebble Index 01"' \
    'adapter = "pebble-index"' \
    'max_body_bytes = 262144' \
    'auth_header = "Authorization"' \
    'auth_scheme = "Bearer"' \
    'auth_token_credential = "pebble_index"' \
    '[routes.destination]' \
    'type = "slack"' \
    "channel_id = \"$dm_channel\"" \
    '[[routes.trigger_destinations]]' \
    'trigger = "single-click-hold"' \
    'webhook_version = "1"' \
    '[routes.trigger_destinations.destination]' \
    'type = "journal"' \
    "sink = \"$journal_sink\"" \
    '[[routes.trigger_destinations]]' \
    'trigger = "double-click-hold"' \
    'webhook_version = "1"' \
    '[routes.trigger_destinations.destination]' \
    'type = "slack"' \
    "channel_id = \"$dm_channel\"" \
    '[[routes.trigger_destinations]]' \
    'trigger = "test-event"' \
    'webhook_version = "1"' \
    '[routes.trigger_destinations.destination]' \
    'type = "slack"' \
    "channel_id = \"$dm_channel\"" >"$config_path"
  chmod 0600 "$config_path"
}

write_metadata() {
  local destination=$1 request_path=$2 status=$3 supervisor_pid=$4 supervisor_ticks=$5
  local candidate_pid=${6:-} candidate_ticks=${7:-} generation=${8:-0} exit_code=${9:-}
  local source=${10:-null} started_at=${11:-} updated_at=${12:-}
  local run_id lane owner requester label worktree run_root capture_ingress_port capture_queue_port expected_identity fixtures browser_profile
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
  capture_ingress_port=$((CAPTURE_INGRESS_PORT_BASE + lane))
  capture_queue_port=$((CAPTURE_QUEUE_PORT_BASE + lane))
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
    --arg capture_config "$run_root/state/capture-routes.toml" \
    --arg capture_log "$run_root/capture.log" \
    --arg capture_credentials "$run_root/state/capture-credentials" \
    --arg capture_journal "$run_root/journal-inbox" \
    --arg capture_audio "$run_root/audio-inbox" \
    --arg evidence_dir "$run_root/evidence" \
    --arg workspace_root "$run_root/workspace" \
    --arg candidate_log "$run_root/candidate.log" \
    --arg ready_file "$run_root/state/ready.json" \
    --arg capture_pid "${CAPTURE_INGRESS_PID:-}" \
    --arg capture_ticks "${CAPTURE_INGRESS_TICKS:-}" \
    --arg capture_active "${CAPTURE_ACTIVE:-false}" \
    --argjson capture_ingress_port "$capture_ingress_port" \
    --argjson capture_queue_port "$capture_queue_port" \
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
      paths:{config:$config_path,fixtures:$fixtures_path,browser_profile:$browser_profile,state:$state_dir,capture_state:$capture_state_dir,evidence:$evidence_dir,workspace:$workspace_root,candidate_log:$candidate_log,ready_file:$ready_file,capture_config:$capture_config,capture_log:$capture_log,capture_credentials:$capture_credentials,capture_journal:$capture_journal,capture_audio:$capture_audio},
      reserved_capture:{
        ingress_url:("http://127.0.0.1:" + ($capture_ingress_port | tostring)),
        ingress_port:$capture_ingress_port,
        queue_url:("http://127.0.0.1:" + ($capture_queue_port | tostring)),
        queue_port:$capture_queue_port,
        queue_token_file:($capture_credentials + "/capture_queue"),
        pebble_token_file:($capture_credentials + "/pebble_index"),
        journal_root:$capture_journal,
        process:(if $capture_pid == "" then null else {pid:($capture_pid | tonumber),start_ticks:$capture_ticks} end),
        active:($capture_active == "true")
      }
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
      | select(.browser.client_workspace_id | test("^E[A-Z0-9]+$"))
      | select(.browser.canonical_workspace_domain | test("^[a-z0-9-]+[.]slack[.]com$"))
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
    write_sandbox_capture_config "$run_root" "$lane" "$(printf '%s\n' "$fixtures" | jq -r .dm_channel_id)" "$worktree"
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
  local capture_exit=""
  CAPTURE_INGRESS_PID=""
  CAPTURE_INGRESS_TICKS=""
  CAPTURE_ACTIVE=false
  stop_capture_sibling() {
    test -n "$CAPTURE_INGRESS_PID" || return 0
    kill -TERM "$CAPTURE_INGRESS_PID" 2>/dev/null || true
    set +e
    wait "$CAPTURE_INGRESS_PID"
    capture_exit=$?
    set -e
    CAPTURE_INGRESS_PID=""
    CAPTURE_INGRESS_TICKS=""
    CAPTURE_ACTIVE=false
  }
  request_reload() {
    requested_action=reload
    if test -n "$candidate_pid"; then kill -TERM "$candidate_pid" 2>/dev/null || true
    else stop_capture_sibling
    fi
  }
  request_release() {
    requested_action=release
    if test -n "$candidate_pid"; then kill -TERM "$candidate_pid" 2>/dev/null || true
    else stop_capture_sibling
    fi
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
      export CONCIERGE_TEST_MODE=1
      export CONCIERGE_CAPTURE_STATE_DIR="$run_root/capture-state"
      export CONCIERGE_CAPTURE_CONFIG="$run_root/state/capture-routes.toml"
      export CREDENTIALS_DIRECTORY="$run_root/state/capture-credentials"
      exec {lock_fd}>&-
      exec setpriv --pdeathsig TERM "$CAPTURE_BUN_BIN" run src/capture-ingress.ts
    ) >>"$run_root/capture.log" 2>&1 &
    CAPTURE_INGRESS_PID=$!
    CAPTURE_INGRESS_TICKS=$(process_start_ticks "$CAPTURE_INGRESS_PID")
    updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    write_metadata "$owner_path" "$request_path" starting $$ "$supervisor_ticks" "" "" "$generation" "" "$source" "$started_at" "$updated_at"
    write_metadata "$run_path" "$request_path" starting $$ "$supervisor_ticks" "" "" "$generation" "" "$source" "$started_at" "$updated_at"

    local capture_ready_deadline=$((SECONDS + START_TIMEOUT_SECONDS))
    while true; do
      if ! kill -0 "$CAPTURE_INGRESS_PID" 2>/dev/null; then
        stop_capture_sibling
        updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        write_metadata "$run_path" "$request_path" failed_start $$ "$supervisor_ticks" "" "" "$generation" "$capture_exit" "$source" "$started_at" "$updated_at"
        remove_active_owner_if_current "$owner_path" "$run_id"
        return 1
      fi
      if CONCIERGE_CAPTURE_INGRESS_URL="http://127.0.0.1:$((CAPTURE_INGRESS_PORT_BASE + lane))" \
        CONCIERGE_CAPTURE_QUEUE_URL="http://127.0.0.1:$((CAPTURE_QUEUE_PORT_BASE + lane))" \
        CONCIERGE_CAPTURE_QUEUE_TOKEN_FILE="$run_root/state/capture-credentials/capture_queue" \
        CONCIERGE_STATE_DIR="$run_root/state" \
        "$CAPTURE_BUN_BIN" run "$worktree/bot/scripts/sandbox-capture-healthcheck.ts" \
          >>"$run_root/capture-healthcheck.log" 2>&1; then
        break
      fi
      if ((SECONDS > capture_ready_deadline)); then
        stop_capture_sibling
        updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        write_metadata "$run_path" "$request_path" failed_start $$ "$supervisor_ticks" "" "" "$generation" "$capture_exit" "$source" "$started_at" "$updated_at"
        remove_active_owner_if_current "$owner_path" "$run_id"
        return 1
      fi
      sleep 0.05
    done
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
      export CONCIERGE_STATE_DIR="$run_root/state"
      export CONCIERGE_CAPTURE_STATE_DIR="$run_root/capture-state"
      export CONCIERGE_CAPTURE_QUEUE_URL="http://127.0.0.1:$((CAPTURE_QUEUE_PORT_BASE + lane))"
      export CONCIERGE_CAPTURE_QUEUE_TOKEN_FILE="$run_root/state/capture-credentials/capture_queue"
      export CONCIERGE_CAPTURE_JOURNAL_ROOT="$run_root/journal-inbox"
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
      if ! kill -0 "$CAPTURE_INGRESS_PID" 2>/dev/null; then
        kill -TERM "$candidate_pid" 2>/dev/null || true
        wait_for_candidate_exit "$candidate_pid"
        candidate_exit=$CANDIDATE_EXIT_STATUS
        candidate_pid=""
        stop_capture_sibling
        updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        write_metadata "$run_path" "$request_path" failed_start $$ "$supervisor_ticks" "" "" "$generation" "$capture_exit" "$source" "$started_at" "$updated_at"
        remove_active_owner_if_current "$owner_path" "$run_id"
        return 1
      fi
      if ! kill -0 "$candidate_pid" 2>/dev/null; then
        wait_for_candidate_exit "$candidate_pid"
        candidate_exit=$CANDIDATE_EXIT_STATUS
        updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        if test "$requested_action" = reload; then
          candidate_pid=""
          stop_capture_sibling
          write_metadata "$owner_path" "$request_path" reloading $$ "$supervisor_ticks" "" "" "$generation" "$candidate_exit" "$source" "$started_at" "$updated_at"
          write_metadata "$run_path" "$request_path" reloading $$ "$supervisor_ticks" "" "" "$generation" "$candidate_exit" "$source" "$started_at" "$updated_at"
          continue 2
        fi
        if test "$requested_action" = release; then
          candidate_pid=""
          stop_capture_sibling
          write_metadata "$run_path" "$request_path" released $$ "$supervisor_ticks" "" "" "$generation" "$candidate_exit" "$source" "$started_at" "$updated_at"
          remove_active_owner_if_current "$owner_path" "$run_id"
          return 0
        fi
        candidate_pid=""
        stop_capture_sibling
        write_metadata "$run_path" "$request_path" failed_start $$ "$supervisor_ticks" "" "" "$generation" "$candidate_exit" "$source" "$started_at" "$updated_at"
        remove_active_owner_if_current "$owner_path" "$run_id"
        return 1
      fi
      if ((SECONDS > ready_deadline)); then
        kill -TERM "$candidate_pid" 2>/dev/null || true
        wait_for_candidate_exit "$candidate_pid"
        candidate_exit=$CANDIDATE_EXIT_STATUS
        updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        candidate_pid=""
        stop_capture_sibling
        write_metadata "$run_path" "$request_path" failed_start $$ "$supervisor_ticks" "" "" "$generation" "$candidate_exit" "$source" "$started_at" "$updated_at"
        remove_active_owner_if_current "$owner_path" "$run_id"
        return 1
      fi
      sleep 0.05
    done
    CAPTURE_ACTIVE=true
    updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    write_metadata "$owner_path" "$request_path" running $$ "$supervisor_ticks" "$candidate_pid" "$candidate_ticks" "$generation" "" "$source" "$started_at" "$updated_at"
    write_metadata "$run_path" "$request_path" running $$ "$supervisor_ticks" "$candidate_pid" "$candidate_ticks" "$generation" "" "$source" "$started_at" "$updated_at"

    local capture_failed=0
    while kill -0 "$candidate_pid" 2>/dev/null; do
      if ! kill -0 "$CAPTURE_INGRESS_PID" 2>/dev/null; then
        capture_failed=1
        kill -TERM "$candidate_pid" 2>/dev/null || true
        break
      fi
      sleep 0.05
    done
    wait_for_candidate_exit "$candidate_pid"
    candidate_exit=$CANDIDATE_EXIT_STATUS
    candidate_pid=""
    stop_capture_sibling
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

    if test "$capture_failed" = 1; then
      write_metadata "$run_path" "$request_path" capture_exited $$ "$supervisor_ticks" "" "" "$generation" "$capture_exit" "$source" "$started_at" "$updated_at"
      remove_active_owner_if_current "$owner_path" "$run_id"
      return 1
    fi

    write_metadata "$run_path" "$request_path" exited $$ "$supervisor_ticks" "" "" "$generation" "$candidate_exit" "$source" "$started_at" "$updated_at"
    remove_active_owner_if_current "$owner_path" "$run_id"
    return "$candidate_exit"
  done
}

require_commands
[[ "$CAPTURE_INGRESS_PORT_BASE" =~ ^[0-9]+$ ]] || fail_json 2 "CONCIERGE_SANDBOX_CAPTURE_PORT_BASE must be an integer"
[[ "$CAPTURE_QUEUE_PORT_BASE" =~ ^[0-9]+$ ]] || fail_json 2 "CONCIERGE_SANDBOX_CAPTURE_QUEUE_PORT_BASE must be an integer"
[[ "$OWNER_PUBLICATION_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] \
  || fail_json 2 "CONCIERGE_SANDBOX_OWNER_PUBLICATION_TIMEOUT_SECONDS must be a non-negative integer"
[[ "$WAIT_RECHECK_SECONDS" =~ ^[0-9]+([.][0-9]+)?$ ]] \
  || fail_json 2 "CONCIERGE_SANDBOX_WAIT_RECHECK_SECONDS must be a non-negative number"
test "$CAPTURE_INGRESS_PORT_BASE" -ge 1024 && test $((CAPTURE_INGRESS_PORT_BASE + LANE_COUNT)) -le 65535 \
  || fail_json 2 "sandbox capture ingress ports must remain between 1025 and 65535"
test "$CAPTURE_QUEUE_PORT_BASE" -ge 1024 && test $((CAPTURE_QUEUE_PORT_BASE + LANE_COUNT)) -le 65535 \
  || fail_json 2 "sandbox capture queue ports must remain between 1025 and 65535"
if test $((CAPTURE_INGRESS_PORT_BASE + 1)) -le $((CAPTURE_QUEUE_PORT_BASE + LANE_COUNT)) \
  && test $((CAPTURE_QUEUE_PORT_BASE + 1)) -le $((CAPTURE_INGRESS_PORT_BASE + LANE_COUNT)); then
  fail_json 2 "sandbox capture ingress and queue port ranges must not overlap"
fi
ensure_roots

case "$COMMAND" in
  claim) claim_lane "$@" ;;
  status) test "$#" -eq 1 || usage; status_lanes ;;
  reload) reload_lane "$@" ;;
  release) release_lane "$@" ;;
  _supervise) supervise_lane "$@" ;;
  *) usage ;;
esac
