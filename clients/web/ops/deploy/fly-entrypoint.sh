#!/usr/bin/env bash
set -euo pipefail

state_dir=/data/state
log_dir=/data/logs
mkdir -p "$state_dir" "$log_dir"

mm_pid_file="$state_dir/mm.pid"
trader_pid_file="$state_dir/trader.pid"
watchdog_log="$log_dir/watchdog.log"
stopping=0

contract=${CONTRACT:?CONTRACT is required}
base_sac=${BASE_SAC:?BASE_SAC is required}
quote_sac=${QUOTE_SAC:?QUOTE_SAC is required}
usdc_issuer=${USDC_ISSUER:?USDC_ISSUER is required}

run_mm() {
  while ((stopping == 0)); do
    npx tsx ops/mm.ts \
      --contract "$contract" --market 1 --identity pb-mm \
      --base-sac "$base_sac" --quote-sac "$quote_sac" --usdc-issuer "$usdc_issuer" \
      --levels 20 --base-lots 25 --step-lots 12 --interval 30 --pad-v2 \
      --state "$state_dir/mm.json" --log "$log_dir/mm.log" &
    child=$!
    printf '%s\n' "$child" > "$mm_pid_file"
    wait "$child" || true
    rm -f "$mm_pid_file"
    ((stopping == 0)) || break
    sleep 5
  done
}

run_trader() {
  while ((stopping == 0)); do
    npx tsx ops/trader.ts \
      --contract "$contract" --market 1 --identity pb-trader \
      --base-sac "$base_sac" --quote-sac "$quote_sac" --usdc-issuer "$usdc_issuer" \
      --log "$log_dir/trader.log" &
    child=$!
    printf '%s\n' "$child" > "$trader_pid_file"
    wait "$child" || true
    rm -f "$trader_pid_file"
    ((stopping == 0)) || break
    sleep 5
  done
}

run_mm &
mm_pid=$!
run_trader &
trader_pid=$!

restart_child() {
  local pid_file="$1"
  local label="$2"
  local child
  child=$(cat "$pid_file" 2>/dev/null || true)
  if [[ "$child" =~ ^[0-9]+$ ]]; then
    printf '%s autofix: restarting %s pid %s\n' "$(date -u +%FT%TZ)" "$label" "$child" >> "$watchdog_log"
    kill -TERM "$child" 2>/dev/null || true
  else
    printf '%s autofix: no %s child pid found\n' "$(date -u +%FT%TZ)" "$label" >> "$watchdog_log"
  fi
}

watchdog() {
  while true; do
    set +e
    output=$(npx tsx ops/check.ts \
      --contract "$contract" --market 1 --identity pb-mm \
      --log "$log_dir/mm.log" --state "$state_dir/mm.json" \
      --trader-log "$log_dir/trader.log" 2>&1)
    status=$?
    set -e
    printf '%s\n' "$output" | tee -a "$watchdog_log"
    if ((status != 0)); then
      case "$output" in
        *"bot stale"*|*"no log"*|*"no loop line"*|*"bad outcomes"*|*"trader stale"*|*"trader bad outcomes"*)
          restart_child "$mm_pid_file" "maker"
          restart_child "$trader_pid_file" "trader"
          ;;
        *)
          printf '%s autofix: alert requires observation, no process restart\n' "$(date -u +%FT%TZ)" >> "$watchdog_log"
          ;;
      esac
    fi
    sleep 3600
  done
}
watchdog &
watchdog_pid=$!

shutdown() {
  stopping=1
  trap - SIGINT SIGTERM
  for pid_file in "$mm_pid_file" "$trader_pid_file"; do
    child=$(cat "$pid_file" 2>/dev/null || true)
    if [[ "$child" =~ ^[0-9]+$ ]]; then kill -TERM "$child" 2>/dev/null || true; fi
  done
  kill -TERM "$mm_pid" "$trader_pid" "$watchdog_pid" 2>/dev/null || true
  wait "$mm_pid" 2>/dev/null || true
  wait "$trader_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
}

trap shutdown SIGINT SIGTERM

set +e
wait -n "$mm_pid" "$trader_pid" "$watchdog_pid"
status=$?
set -e

shutdown
exit "$status"
