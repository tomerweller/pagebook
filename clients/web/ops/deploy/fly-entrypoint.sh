#!/usr/bin/env bash
set -euo pipefail

state_dir=/data/state
log_dir=/data/logs
mkdir -p "$state_dir" "$log_dir"

mm_pid_file="$state_dir/mm.pid"
trader_pid_file="$state_dir/trader.pid"
watchdog_log="$log_dir/watchdog.log"
stop_file="$state_dir/stopping"
# Stale from a previous boot or crash: pid files may name recycled pids, and a
# leftover stop file would prevent the runners from starting.
rm -f "$mm_pid_file" "$trader_pid_file" "$stop_file"

contract=${CONTRACT:?CONTRACT is required}
market=${MARKET:-0}
base_sac=${BASE_SAC:?BASE_SAC is required}
# The maker's quote list is only meaningful on the contract and market that
# hold those orders, so the state file is keyed by both: a redeploy to a new
# address or market starts from an empty book instead of adopting the old
# one's nonces (ADR-036). Migrate the contract-only file once for market 0.
mm_state="$state_dir/mm-$contract-m$market.json"
if [[ ! -f "$mm_state" && "$market" == "0" && -f "$state_dir/mm-$contract.json" ]]; then
  mv "$state_dir/mm-$contract.json" "$mm_state"
fi
quote_sac=${QUOTE_SAC:?QUOTE_SAC is required}
usdc_issuer=${USDC_ISSUER:?USDC_ISSUER is required}

run_mm() {
  while [[ ! -f "$stop_file" ]]; do
    setsid npx tsx ops/mm.ts \
      --contract "$contract" --market "$market" --identity pb-mm \
      --base-sac "$base_sac" --quote-sac "$quote_sac" --usdc-issuer "$usdc_issuer" \
      --levels 20 --base-lots 25 --step-lots 12 --interval 30 --pad-v2 \
      --state "$mm_state" --log "$log_dir/mm.log" &
    child=$!
    printf '%s\n' "$child" > "$mm_pid_file"
    wait "$child" || true
    rm -f "$mm_pid_file"
    [[ ! -f "$stop_file" ]] || break
    sleep 5
  done
}

run_trader() {
  while [[ ! -f "$stop_file" ]]; do
    setsid npx tsx ops/trader.ts \
      --contract "$contract" --market "$market" --identity pb-trader \
      --base-sac "$base_sac" --quote-sac "$quote_sac" --usdc-issuer "$usdc_issuer" \
      --log "$log_dir/trader.log" &
    child=$!
    printf '%s\n' "$child" > "$trader_pid_file"
    wait "$child" || true
    rm -f "$trader_pid_file"
    [[ ! -f "$stop_file" ]] || break
    sleep 5
  done
}

run_keepalive() {
  # A dedicated identity avoids sequence-number races with the maker; fall
  # back to pb-mm (with the keepalive's own bad_seq retry) when unset.
  local keeper_identity="pb-mm"
  if [[ -n "${PB_SECRET_PB_KEEPER:-}" ]]; then keeper_identity="pb-keeper"; fi
  while [[ ! -f "$stop_file" ]]; do
    npx tsx ops/keepalive.ts \
      --contract "$contract" --market "$market" --identity "$keeper_identity" \
      --base-sac "$base_sac" --quote-sac "$quote_sac" \
      --log "$log_dir/keepalive.log" || true
    [[ ! -f "$stop_file" ]] || break
    sleep 86400
  done
}

run_refill() {
  # Testnet-only friendbot top-up (ADR-034). Signs only with locally generated
  # throwaway keys, so it needs no bot identity or secret.
  while [[ ! -f "$stop_file" ]]; do
    npx tsx ops/refill.ts \
      --usdc-issuer "$usdc_issuer" \
      --log "$log_dir/refill.log" || true
    [[ ! -f "$stop_file" ]] || break
    sleep 86400
  done
}

run_mm &
mm_pid=$!
run_trader &
trader_pid=$!
run_keepalive &
keepalive_pid=$!
run_refill &
refill_pid=$!

restart_child() {
  local pid_file="$1"
  local label="$2"
  local child
  child=$(cat "$pid_file" 2>/dev/null || true)
  if [[ "$child" =~ ^[0-9]+$ ]]; then
    printf '%s autofix: restarting %s pid %s\n' "$(date -u +%FT%TZ)" "$label" "$child" >> "$watchdog_log"
    # The bots run under setsid, so the pid is a process-group leader: signal
    # the group, or the npx wrapper dies, the runner restarts the bot, and the
    # node process it wrapped lives on as a second instance sharing the state
    # file (the 2026-09-09 duplicate-maker incident, ADR-037).
    kill -TERM -- "-$child" 2>/dev/null || kill -TERM "$child" 2>/dev/null || true
  else
    printf '%s autofix: no %s child pid found\n' "$(date -u +%FT%TZ)" "$label" >> "$watchdog_log"
  fi
}

watchdog() {
  # The bots need a few cycles before their logs carry a loop line; an autofix
  # on a fresh boot would restart healthy processes.
  sleep 300
  while true; do
    set +e
    output=$(npx tsx ops/check.ts \
      --contract "$contract" --market "$market" --identity pb-mm \
      --log "$log_dir/mm.log" --state "$mm_state" \
      --trader-log "$log_dir/trader.log" 2>&1)
    status=$?
    set -e
    printf '%s\n' "$output" | tee -a "$watchdog_log"
    if ((status != 0)); then
      case "$output" in
        *"bot stale"*|*"no log"*|*"no loop line"*|*"trader stale"*)
          # Process-health signals: a restart can help.
          restart_child "$mm_pid_file" "maker"
          restart_child "$trader_pid_file" "trader"
          ;;
        *)
          # Bad outcomes, geometry, reserve: chain-side or operator matters.
          # Restarting a process cannot repair on-chain state (the 2026-08-26
          # archived-entry incident looped here); log and leave it visible.
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
  # The runner loops are separate processes; a shell variable cannot reach
  # them. The stop file can.
  touch "$stop_file"
  trap - SIGINT SIGTERM
  for pid_file in "$mm_pid_file" "$trader_pid_file"; do
    child=$(cat "$pid_file" 2>/dev/null || true)
    if [[ "$child" =~ ^[0-9]+$ ]]; then
      kill -TERM -- "-$child" 2>/dev/null || kill -TERM "$child" 2>/dev/null || true
    fi
  done
  kill -TERM "$mm_pid" "$trader_pid" "$watchdog_pid" "$keepalive_pid" "$refill_pid" 2>/dev/null || true
  wait "$mm_pid" 2>/dev/null || true
  wait "$trader_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
  wait "$keepalive_pid" 2>/dev/null || true
  wait "$refill_pid" 2>/dev/null || true
}

trap shutdown SIGINT SIGTERM

set +e
wait -n "$mm_pid" "$trader_pid" "$watchdog_pid" "$keepalive_pid" "$refill_pid"
status=$?
set -e

shutdown
exit "$status"
