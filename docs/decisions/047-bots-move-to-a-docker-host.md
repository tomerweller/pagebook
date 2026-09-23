# 047: The bots move from Fly to a Docker host

Date: 2026-09-23. This is the plan; the cutover record is appended when the
move lands, in the ADR-044 shape.

## Decision

The maker, trader, keepalive crank, refill crank and watchdog move from the
Fly Machine `pagebook-bots` (one `shared-cpu-1x` in `iad`, ADR-036 to
ADR-044) to `user-dev-050a`, an Ubuntu 22.04 AWS dev host. They run there as
one Docker container built from the existing `clients/web/Dockerfile`, under
the existing supervisor (`ops/deploy/fly-entrypoint.sh`), with `/data` on a
named volume. The production identities stay the same (`pb-mm-fly`,
`GDBX…DOBH`; `pb-trader-fly`, `GBTQ…BRY6`), so the refill floors, the
outside-in health check and the published client need no change. The Fly
app stops at cutover, stays as the rollback target for a week, and is then
destroyed.

Two choices inside that decision:

One supervisor container rather than the three-service compose file. The
compose file in `ops/deploy/` predates the keepalive and refill cranks and
the autofix watchdog; the supervisor is what has run production since
ADR-036, and its state path `/data/state/mm-<CONTRACT>-m<MARKET>.json` is the
path on the Fly volume, so the state handoff is a file copy with no rename.

Docker rather than Node under systemd. The host has no Node, no stellar CLI
and no sudo, and the user's session does not linger, so a systemd user
service would die with the login. Docker 29 with Compose v5 is installed and
enabled at boot, the user is in the `docker` group, and `restart:
unless-stopped` survives a reboot without root.

## The host, as measured on 2026-09-23

| What | Value |
|---|---|
| Host | `user-dev-050a`, Ubuntu 22.04.5, kernel 6.8 (AWS), 32 cores, 61 GB RAM, up 197 days |
| Disk | 97 GB root, 17 GB free (83% used; Docker images already hold 8 GB, 1.3 GB reclaimable) |
| Docker | 29.2.1, Compose v5.1.0, overlayfs, cgroup v2, `docker.service` enabled, live-restore off |
| User | `tomer`, in `docker`; no passwordless sudo; no Node, npm, stellar or fly on the PATH; python3 3.10 |
| Egress | HTTPS to Soroban RPC, Horizon, Coinbase, Kraken, Bitstamp, friendbot, npm, Docker Hub, GitHub and fly.io all answered; no proxy; egress IP `13.217.88.18`; clock synced, UTC |
| Fleet software | CrowdStrike, Humio, Grafana Alloy, Tailscale (SDF-managed box) |

The repo's outside-in check, run from this host against the live venue,
read healthy at ledger 4,835,248: 4,194 contract events over the last ~720
ledgers (2,000 `rested`, 2,000 `settled`, 131 `top_changed`, 45 `filled`,
18 `swept`), book 0.20285 / 0.20299 (7 bps spread, mid 2 bps over spot),
maker 38,149 XLM and 95,418 USDC, trader 19,220 USDC and 196,393 XLM, `FLAGS:
none`. That output is the baseline the post-cutover check is compared to.

## Constraints the procedure is built around

Two makers must never run on `pb-mm-fly` at the same time. Two makers
sharing one state file overwrite each other's quote lists and strand orders
(the ADR-037 incident). Phase 2 stops the Fly maker and confirms the stop
before phase 3 starts the host maker, and no smoke run starts a maker on the
host while Fly is live.

The state file is the maker's only record of its nonces. `mm.ts
--cancel-all` settles from it; without it the recovery is the nonce-range
scan in `.claude/skills/redeploy-testnet/scripts/scan-orders.mts`. Phase 1
copies it out before any other step runs.

The supervisor's shutdown is a hard exit. Its `shutdown` waits on the runner
loops, which die on SIGTERM at once, so the machine exits seconds after the
signal while the bots are still mid-cycle (ADR-044 saw a maker batch land two
seconds after the signal and a trader rest left on the book). For a
wind-down that was fine, since everything was settled afterwards from a
rebuilt state. For a host move the maker has to exit at a cycle boundary so
the state file is final, and the trader has to settle its rests (its `run`
does so after the loop). The cutover therefore freezes the supervisor before
signalling the bots, and the host deployment ships a fixed `shutdown` so
later stops are graceful without the trick.

## Repo changes on this branch, before the cutover

1. `clients/web/ops/deploy/docker-compose.host.yml`: one service, `bots`,
   built from `clients/web/Dockerfile`, the `[env]` block of `fly.toml` as
   `environment`, the secrets from `./env`, the volume `pagebook-data` at
   `/data`, `init: true`, `restart: unless-stopped`, `stop_grace_period:
   180s` (Fly's `kill_timeout`), json-file logging capped at 50 MB times 5.
   The volume is declared `external`, so `docker compose down -v` cannot
   delete the state. The existing three-service file stays as the
   per-process variant.

   ```yaml
   services:
     bots:
       build:
         context: ../..
         dockerfile: Dockerfile
       env_file: ./env
       environment:
         CONTRACT: CAYPAQDKNWMHRATKU5DQ327VDHVRSIVK7UGVWT2A5SUZCUFTLUHXH2JA
         MARKET: "0"
         BASE_SAC: CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
         QUOTE_SAC: CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
         USDC_ISSUER: GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
       volumes:
         - pagebook-data:/data
       init: true
       restart: unless-stopped
       stop_grace_period: 180s
       logging:
         driver: json-file
         options: { max-size: "50m", max-file: "5" }
   volumes:
     pagebook-data:
       external: true
   ```

2. `fly-entrypoint.sh`: `shutdown` signals the bot process groups as today,
   then polls `/proc` (the image has no `ps`) until both groups are gone or
   170 s have passed, and only then kills the runner loops and exits. The
   file keeps its name; the Dockerfile `CMD` and the redeploy skill refer to
   it.

   ```bash
   group_alive() {
     local d
     for d in /proc/[0-9]*; do
       [[ "$(sed 's/.*) //' "$d/stat" 2>/dev/null | awk '{print $3}')" == "$1" ]] && return 0
     done
     return 1
   }
   # in shutdown(), after the kill -TERM loop over the pid files:
   local waited=0 alive
   while (( waited < 170 )); do
     alive=0
     for child in "${groups[@]}"; do group_alive "$child" && alive=1; done
     (( alive )) || break
     sleep 1; waited=$((waited + 1))
   done
   ```

3. `env.example` gains the optional `PB_SECRET_PB_KEEPER` line, and
   `clients/web/.dockerignore` excludes `ops/deploy/env` and
   `ops/deploy/env.*`. The Dockerfile copies the whole `ops` tree, so
   without that rule a filled secrets file would be baked into an image
   layer; the same held for the existing three-service compose file.

4. `ops/README.md` gains a "Host deployment" section (bring-up, the freeze
   stop, state handoff, rollback, backups) and marks the Fly section as
   retired once the cutover lands. `tools/health/README.md` and the comments
   in `refill.ts` that say "fly machine" get reworded; the `FLY_MAKER` and
   `FLY_TRADER` constant names stay, since the health check greps them.

5. Follow-up PR after the cutover: the redeploy skill's step 5 changes from
   `fly deploy` to a rebuild on the host, and its wind-down step records the
   freeze technique.

Checks for the branch: `npx vitest run` in `clients/web` (in CI or in the
Node container from phase 3, since the host has no Node; the shell change
touches no TypeScript), `docker compose -f docker-compose.host.yml config`,
and the stop drill in phase 4, which is the test of the new `shutdown`.

## Procedure

Wall clock: about an hour of preparation on the host, fifteen minutes of
hands-on cutover, then a 35 to 60 minute acceptance window. The only step
that needs the Mac is reading the two secrets out of the keychain.

### Phase 0: prepare the host (production untouched)

1. A checkout that stays on `main`: `git clone
   https://github.com/tomerweller/pagebook.git ~/code/pagebook-ops`. The
   working checkout at `~/code/pagebook` hosts worktrees and switches
   branches; the ops clone does not. Until this branch merges, the ops clone
   checks out the branch.

2. flyctl, without sudo: `curl -L https://fly.io/install.sh | sh` installs to
   `~/.fly/bin`. Sign in with `fly auth login` (it prints a URL to open) or
   export a token minted on the Mac with `fly auth token`. Confirm with `fly
   status -a pagebook-bots` and note the machine id. `fly secrets list -a
   pagebook-bots` shows whether `PB_SECRET_PB_KEEPER` is set; the entrypoint
   runs the keepalive as `pb-keeper` when it is, `pb-mm` otherwise.

3. Secrets, pulled from the running Fly Machine. Fly stores app secrets
   write-only (`fly secrets list` shows names and digests), but the Machine
   sees them as environment variables, so a command run inside it can read
   them out. Write them straight into the env file rather than through the
   terminal, so no value lands in scrollback or shell history:

   ```bash
   cd ~/code/pagebook-ops/clients/web/ops/deploy && umask 077 && : > env && for n in PB_SECRET_PB_MM PB_SECRET_PB_TRADER PB_SECRET_PB_KEEPER; do v=$(fly machine exec <id> -a pagebook-bots "printenv $n" 2>/dev/null | tr -d '\r\n'); [ -n "$v" ] && printf '%s=%s\n' "$n" "$v" >> env; done; grep -cE '^PB_SECRET_PB_[A-Z]+=S[A-Z2-7]{55}$' env
   ```

   The count must be 2, or 3 when Fly holds a keeper secret. `fly machine
   exec` goes over the Machines API (HTTPS), so it works where the WireGuard
   tunnel behind `fly ssh console` and `fly sftp` does not; if those two are
   needed later and UDP is blocked on this network, `fly wireguard
   websockets enable` moves the tunnel onto TCP 443. The same `exec` form
   also reads the state file: `fly machine exec <id> -a pagebook-bots "cat
   /data/state/mm-<CONTRACT>-m0.json" > mm-final.json` is an alternative to
   `fly sftp get` in phases 1 and 2. Fallback if the Machine is not running:
   `stellar keys secret pb-mm-fly --config-dir
   /Users/tomer/dev/pagebook/.stellar` on the Mac (and `pb-trader-fly`),
   typed into the file with an editor. The path is gitignored; mode 600
   leaves it readable by the user and by root.

4. Build and dry-run. From `clients/web/ops/deploy`: `docker volume create
   pagebook-data`, then `docker compose -f docker-compose.host.yml build`
   (pulls `node:22-slim`, runs `npm ci`). Then two read-only runs inside the
   image with the real secrets, which prove identity loading, RPC, Horizon
   and the key sweep from this host:

   ```bash
   docker compose -f docker-compose.host.yml run --rm bots sh -c 'npx tsx ops/keepalive.ts --contract $CONTRACT --market $MARKET --identity pb-mm --base-sac $BASE_SAC --quote-sac $QUOTE_SAC --dry-run --log /tmp/keepalive-dry.log'
   ```

   ```bash
   docker compose -f docker-compose.host.yml run --rm bots sh -c 'npx tsx ops/refill.ts --usdc-issuer $USDC_ISSUER --dry-run --log /tmp/refill-dry.log'
   ```

   Pass: both print their summary line without an error; the keepalive plan
   is empty or near empty (Fly ran it within the last day) and the refill
   reads both balances above their floors. Do not run `mm.ts` or `trader.ts`
   on this host in this phase: with Fly live that is a second maker.

5. Baseline: `python3 tools/health/pagebook-health.py` from the ops clone;
   keep the output next to the one in this document.

### Phase 1: insurance copy (production untouched)

```bash
fly sftp get /data/state/mm-CAYPAQDKNWMHRATKU5DQ327VDHVRSIVK7UGVWT2A5SUZCUFTLUHXH2JA-m0.json ./mm-pre.json -a pagebook-bots
```

Also read the watchdog tail and the state directory for the record: `fly ssh
console -a pagebook-bots -C "sh -c 'tail -c 1500 /data/logs/watchdog.log; ls
-la /data/state'"`. The copy is not final, since the maker keeps replacing,
but together with the nonce scan it makes every live order recoverable
whatever the next phase does.

### Phase 2: graceful stop on Fly (quotes stay live)

The order matters: freeze the supervisor first, so it cannot tear the machine
down while the bots finish. An interactive `fly ssh console -a pagebook-bots`
is the easiest way to run these; the machine's shell is dash, so the group
kill goes through `bash -c`.

1. Find the supervisor pid and the bot process groups (no `ps` in the
   image). The runner and watchdog loops are forked copies of the supervisor
   and share its command line, so the listing prints the parent pid too: the
   supervisor is the one whose parent is not itself in the list (normally
   pid 1); the others are its children.

   ```sh
   for d in /proc/[0-9]*; do c=$(tr '\0' ' ' < $d/cmdline 2>/dev/null); case "$c" in *fly-entrypoint*) echo "pid ${d#/proc/} ppid $(awk '{print $4}' $d/stat) $c";; esac; done
   cat /data/state/mm.pid /data/state/trader.pid
   ```

   Read the pid files now; the runner loops delete them as soon as their
   bot exits.

2. Freeze, set the stop file, signal the bots:

   ```sh
   kill -STOP <supervisor pid>
   touch /data/state/stopping
   bash -c 'kill -TERM -- -<mm pid> -<trader pid>'
   ```

   The `npx` wrappers die at once and the runner loops exit because the stop
   file is set; the frozen supervisor cannot react; the two `node` processes
   finish their cycle. The maker exits at its next loop boundary (30 s
   interval plus in-flight submits); the trader wakes from a wait of up to
   75 s, then settles each resting order. Allow three minutes.

3. Confirm both are gone and exited cleanly. Repeat the first line until it
   prints nothing:

   ```sh
   for d in /proc/[0-9]*; do c=$(tr '\0' ' ' < $d/cmdline 2>/dev/null); case "$c" in *ops/mm.ts*|*ops/trader.ts*) echo "${d#/proc/} $c";; esac; done
   tail -c 300 /data/logs/mm.log; echo; tail -c 600 /data/logs/trader.log
   ```

   Both logs must end with `"action":"shutdown","outcome":"done"`, and the
   trader's tail shows its `settle` lines.

4. Take the final state (the machine is still running; the ssh service is
   independent of the entrypoint), and the logs for continuity of the
   watchdog's hourly window:

   ```bash
   fly sftp get /data/state/mm-CAYPAQDKNWMHRATKU5DQ327VDHVRSIVK7UGVWT2A5SUZCUFTLUHXH2JA-m0.json ./mm-final.json -a pagebook-bots
   ```

   Compare with `mm-pre.json`: 40 quotes, `next_nonce` a handful past the
   copy. Then `fly sftp get` `mm.log`, `trader.log`, `watchdog.log`,
   `keepalive.log` and `refill.log` from `/data/logs`.

5. Let the machine exit: `kill -CONT <supervisor pid>` in the console. Its
   `wait -n` returns for the finished runner, `shutdown` finds nothing left
   to signal, and the machine exits and stays stopped, as it did in the
   ADR-036, 037 and 044 wind-downs. Confirm `stopped` in `fly status`. If
   the machine comes back up instead, the entrypoint clears the stop file
   and the bots resume on Fly, which is harmless as long as phase 3 has not
   started: run `fly machine stop <id>` and repeat this phase.

Gate for phase 3: `fly status` says `stopped`, `mm-final.json` is on the
host, and both logs ended with `shutdown done`.

Fallback if the freeze does not behave (for instance `kill -STOP` refused):
the redeploy skill's hard stop (stop file, group kill, the machine exits in
seconds), then the state read under the `sleep 7200` command override
(`fly machine update <id> -a pagebook-bots --command "sleep 7200" --yes`,
`fly machine start`, `fly sftp get`, `fly machine stop`). The nonce scan in
phase 3 then catches what the state file missed, which in ADR-044 was one
trader rest.

### Phase 3: start on the host

1. Seed the volume with the final state and, if copied, the logs:

   ```bash
   docker run --rm -v pagebook-data:/data -v "$PWD":/h alpine sh -c 'mkdir -p /data/state /data/logs && cp /h/mm-final.json /data/state/mm-CAYPAQDKNWMHRATKU5DQ327VDHVRSIVK7UGVWT2A5SUZCUFTLUHXH2JA-m0.json && cp /h/*.log /data/logs/ 2>/dev/null || true'
   ```

2. `docker compose -f docker-compose.host.yml up -d` from
   `clients/web/ops/deploy` in the ops clone.

3. Within two minutes, count bot process groups. Each bot starts under
   `setsid`, so its `npx`, `tsx` and `node` processes share one process
   group id; a duplicate bot (the ADR-037 incident) shows up as a third
   group. The listing must show exactly two distinct `pgid` values, one for
   `ops/mm.ts` and one for `ops/trader.ts`:

   ```bash
   docker compose -f docker-compose.host.yml exec bots bash -c 'for d in /proc/[0-9]*; do c=$(tr "\0" " " < $d/cmdline 2>/dev/null); case "$c" in *ops/mm.ts*|*ops/trader.ts*) echo "pgid $(awk "{print \$5}" $d/stat) $c";; esac; done | sort'
   ```

4. Watch adoption: `docker compose -f docker-compose.host.yml exec bots tail
   -f /data/logs/mm.log`. The first `loop` line carries `live` 40 and the
   fills total from Fly; no `OrderExists`, no `footprint`. The refill and
   keepalive logs show a run each (both ran on Fly within the day, so
   "nothing due" is the expected result). The trader takes within a few
   minutes.

5. Run the watchdog by hand at 5 and 35 minutes (the supervisor's own first
   run is at 5 minutes and then hourly, into `/data/logs/watchdog.log`):

   ```bash
   docker compose -f docker-compose.host.yml exec bots sh -c 'npx tsx ops/check.ts --contract $CONTRACT --market $MARKET --identity pb-mm --log /data/logs/mm.log --state /data/state/mm-$CONTRACT-m$MARKET.json --trader-log /data/logs/trader.log'
   ```

6. Nonce scan, to prove nothing was left behind by the Fly stop. The host
   has no Node, so repo scripts run in a throwaway container over the ops
   clone:

   ```bash
   docker run --rm -v ~/code/pagebook-ops:/repo -w /repo/clients/web node:22-slim sh -c 'npm ci --no-audit --no-fund >/dev/null && npx tsx ../../.claude/skills/redeploy-testnet/scripts/scan-orders.mts CAYPAQDKNWMHRATKU5DQ327VDHVRSIVK7UGVWT2A5SUZCUFTLUHXH2JA GDBXA45UBW2O3UH2RJOCOBXRGEMIP5745RQRINZZ2WHKECHHKKUWDOBH <base> <base+4000> --market 0'
   ```

   The maker's base is `next_nonce` from `mm-final.json` rounded down to a
   thousand; the hits must be exactly the 40 nonces in the state file. The
   trader's base is its last Fly boot second, read from any of its recent
   transactions on Horizon; the scan must find no live rest. A straggler is
   settled the way the skill's step 4.5 describes.

7. Outside-in: `python3 tools/health/pagebook-health.py` reads `FLAGS: none`
   with `rested` and `top_changed` events still flowing, now from the host
   maker, and the published client shows the ladder.

Acceptance is the ADR-031 criterion: `MM OK` twice, 30 minutes apart, with
no `footprint`, `trapped:unknown` or `resource_limit` outcome on either bot,
plus both nonce scans clean.

### Phase 4: harden on the host (same day)

Stop drill. `docker compose -f docker-compose.host.yml stop`, then check
that `mm.log` ends with `shutdown done` and the trader settled its rests
before the container exited; `up -d` again and confirm the maker adopts the
same 40 quotes. This is the test of the new `shutdown` and of the path every
reboot, `dockerd` restart and image rebuild will take.

State backup. The user's crontab works on this host. A daily entry copies
`/data/state/*.json` and the watchdog log out of the volume to
`~/pagebook-backups/<date>/` through a throwaway `alpine` container. An
off-host copy needs credentials the `aws` CLI here may not have; without
one, the nonce scan stays the last-resort recovery, as it was on Fly, and
the Fly volume's 14 daily snapshots cover the first week.

Outside-in monitor. An hourly crontab entry runs `python3
tools/health/pagebook-health.py --json >> ~/pagebook-health.jsonl` from the
ops clone. Its `FLAGS` field is the alert surface; Fly had no paging either,
so this is a record rather than a replacement.

Reboot behaviour. `docker.service` is enabled and the policy is
`unless-stopped`, so a host reboot brings the container back without anyone
logging in. A `dockerd` restart kills the bots with SIGKILL (live-restore is
off); the state file is then as of the last cycle and resume reconciles.

Logs stay bounded: bot JSONL rotates at 64 MB with one generation
(`opslog.ts`), container stdout at 50 MB times 5, the watchdog log grows one
line an hour.

### Phase 5: decommission Fly (after seven clean days, with the operator's go-ahead)

`fly machine destroy <id> -a pagebook-bots`, `fly volumes destroy <vol> -a
pagebook-bots` (the snapshots go with it), `fly apps destroy pagebook-bots`
(the secrets go with the app). Then the README's Fly section becomes
history, the record below is filled in, and the redeploy skill gets its
follow-up.

## Rollback, any time before phase 5

1. On the host: `docker compose -f docker-compose.host.yml stop` (graceful
   with the fixed `shutdown`: the maker saves, the trader settles). Copy the
   state out:

   ```bash
   docker run --rm -v pagebook-data:/data -v "$PWD":/h alpine cp /data/state/mm-CAYPAQDKNWMHRATKU5DQ327VDHVRSIVK7UGVWT2A5SUZCUFTLUHXH2JA-m0.json /h/mm-back.json
   ```

2. On Fly: `fly machine update <id> -a pagebook-bots --command "sleep 7200"
   --yes`, `fly machine start <id>`, then `fly sftp shell -a pagebook-bots`
   and `put mm-back.json /data/state/mm-<CONTRACT>-m0.json`. Restore the
   command with `fly machine update <id> -a pagebook-bots --command
   "/bin/bash ops/deploy/fly-entrypoint.sh" --yes`; the machine restarts
   with the bots. The Fly secrets are still set. Count processes and run
   the watchdog as in phase 3.

## Risks and what covers each

A duplicate maker: the phase 2 gate (Fly confirmed stopped) before phase 3,
the process count after boot, and the supervisor's five-minute grace before
its first autofix.

State loss on the host, for example a re-image of the dev box: the daily
backup, the Fly snapshots for the first week, and the nonce scan.

The dev box is SDF-managed (CrowdStrike, Humio, Tailscale). A forced reboot
or a Docker upgrade restarts the stack under its policy; a decommission of
the host is the state-loss case above. This is not a production home, and
the README already labels the venue an experiment.

Disk at 83%: the image is about half a gigabyte and every log is capped, so
the stack adds under a gigabyte. Pruning the 1.3 GB of reclaimable images is
the operator's call.

Fixed egress IP: the feeds are polled once per 30 s cycle plus once per
watchdog run. Coinbase, Kraken and Bitstamp all answered from this IP today.

Secrets on disk: the `env` file is mode 600 in a gitignored path, readable
by the user and by root. Fly held them as app secrets. A Docker secret or a
prompt at `up` time is possible; the bots need the raw key in their
environment either way.

The freeze in phase 2 is new. `kill -STOP` on the supervisor and `kill
-CONT` afterwards have not been exercised on Fly; the fallback is the hard
stop the three earlier wind-downs used, plus the nonce scan.

## Cutover record

### Phase 0, 2026-09-23 22:00 to 22:05 UTC

- flyctl v0.4.107 installed to `~/.fly/bin` on `user-dev-050a` (no PATH
  change to the shell profile); signed in as `tomer@stellar.org` through the
  browser URL flow from the desktop app's terminal.
- Fly app `pagebook-bots`: one machine, `080d229a790448`, version 14, `iad`,
  `started`, image `deployment-01M26GH06QCMXGJQTMVYFYWTZY`, last updated
  2026-09-10T20:37:10Z (the ADR-044 cutover). Three secrets deployed:
  `PB_SECRET_PB_MM`, `PB_SECRET_PB_TRADER`, `PB_SECRET_PB_KEEPER`, so the
  keepalive runs as `pb-keeper`.
- Secrets pulled over `fly machine exec` into `clients/web/ops/deploy/env`
  (mode 600, three lines, values never displayed). Inside the image the keys
  derive to `GDBX…DOBH` (maker) and `GBTQ…BRY6` (trader), matching
  `refill.ts`; the keeper is `GBUTNZJWRRLWSVU5OHFCLLWEHTFRLM2ASL6BXFYQBXEREKSJEENCGGG4`.
- Image `pagebook-bots-bots:latest`, 562 MB, built from this worktree at
  `89125f7` plus the branch changes. The image has no `ops/deploy/env`, has
  the new `shutdown`, and has `bash`, `sed`, `awk` (mawk) and `setsid`. A
  simulation of the shutdown wait (a `setsid` group whose wrapper dies on
  SIGTERM while the child finishes 4 s later) passed on the host and inside
  the image.
- Volume `pagebook-data` created 22:01:31Z, empty. Compose config validates
  (`stop_grace_period` 3m0s, volume external).
- Keepalive dry run as `pb-keeper`: mid 20,251, latest ledger 4,835,492,
  1,619 keys swept, 0 restores, 5 extends due (asks 20,561 to 20,601 with
  `liveUntil` 4,881,051), instance skipped. Refill dry run: maker 35,288 XLM
  (floor 30,000), trader 18,599 USDC (floor 5,000), nothing to do.
- Baseline from the outside-in check at ledger 4,835,471: 3,692 events over
  ~720 ledgers, book 0.20242 / 0.20243, mid 6 bps over spot 0.20231, maker
  36,398 XLM and 95,787 USDC, trader 18,864 USDC and 198,132 XLM, `FLAGS:
  none`.
- Not done: the ops clone at `~/code/pagebook-ops`, which waits for this
  branch to be on GitHub; phase 0 ran from the worktree, and the env file
  and image move with a rebuild (the volume is independent of the checkout).

Still to append: Fly stop time and the `shutdown done` tails;
`mm-final.json` quote count and `next_nonce` against the insurance copy; the
first host `loop` line; the two `MM OK` lines; both nonce scans; the
outside-in check after cutover; the stop drill; the Fly destroy date.
