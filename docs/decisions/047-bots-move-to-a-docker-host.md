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

5. Let the machine exit: `kill -CONT <supervisor pid>` in the console, or
   over exec as `fly machine exec <id> -a pagebook-bots "sh -c 'kill -CONT
   <pid>'"` (exec runs a bare argv, and `kill` is a shell builtin in this
   image). Its `wait -n` returns for the finished runner, `shutdown` finds
   nothing left to signal, and the machine exits and stays stopped, as it
   did in the ADR-036, 037 and 044 wind-downs. Confirm `stopped` in `fly status`. If
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
   docker compose -f docker-compose.host.yml exec bots bash -c 'for d in /proc/[0-9]*; do c=$(tr "\0" " " < $d/cmdline 2>/dev/null); case "$c" in *"/proc/"*) ;; *ops/mm.ts*|*ops/trader.ts*) echo "pgid $(sed "s/.*) //" $d/stat | awk "{print \$3}") $c";; esac; done | sort'
   ```

   The pgid is read after the `)` that closes the command name, because
   `npx` sets a process title with spaces in it and a plain field count on
   `/proc/<pid>/stat` misreads those rows. The first case arm skips the
   listing shell itself, whose command line contains the patterns.

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

   Bot nonces are `boot_seconds * 1000 + k`, and the maker's counter
   persists in its state file, so both identities' bases are the Fly
   machine's last start second (the `start` event's timestamp, here
   1,789,072,630). Scan from there to just past the maker's current
   `next_nonce`; the redeploy skill's shortcut of rounding `next_nonce` down
   to a thousand only works while the counter is still near its base, and
   after thirteen days it was 22,884 past it with the live quotes far below.
   The maker hits must be exactly the nonces in the current state file; the
   trader scan must find no live rest. A straggler is settled the way the
   skill's step 4.5 describes.

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

### Phase 1, 2026-09-23 22:07 UTC

- Branch committed as `d7e8ffc` (compose file, supervisor shutdown wait,
  dockerignore, env.example, README section, this ADR).
- Fly machine `080d229a790448` still `started`. The volume's state directory
  holds the live file `mm-CAYP…H2JA-m0.json` (3,442 B, written 22:07) beside
  the retired contracts' files (`mm-CAMH…56F4-m0.json`, `mm-CB6I…DAZB.json`,
  `mm.json`) and two August rebuild and cancel copies, all kept as history.
- The watchdog's last three hourly lines are `MM OK` with 40 live quotes,
  0 bad outcomes on either bot, maker XLM between 34,009 and 36,629; the
  maker log's last line was a `replace` that landed (`b69c97…2f4b`).
- Insurance copy over `fly machine exec` to
  `~/pagebook-migration/mm-pre-20260923T220746Z.json` (also `mm-pre.json`),
  3,442 B, same size as on the volume: 40 quotes (20 bids, 20 asks),
  `next_nonce` 1,789,072,652,878, 16,316 fills, 387,254 lots, `inv0` 59,782
  XLM and 72,837 USDC (the ADR-044 cutover balances).

### Phase 2, 2026-09-23 22:18 to 22:25 UTC

- Discovery over `fly machine exec` (a base64-encoded script run through
  `sh -c`): supervisor pid 643 with parent pid 1 (`/fly/init`), five runner
  and watchdog subshells, maker group 657 and trader group 658 (each the
  `npx` wrapper, `sh -c tsx`, the `tsx` node and the bot's node process),
  pid files matching, machine up 13 days.
- 22:18:11Z: SIGSTOP to 643 (state `T` confirmed), stop file set, SIGTERM to
  groups 657 and 658 from bash. The trader logged `shutdown done` at
  22:18:25Z with `resting` 0 (its last three takes had landed; 21,031 takes
  and 2,544 rests, all settled, over the Fly deployment). The maker finished
  loop 31,157 (`live` 40, `replaced` 40, mid 0.20303, 37,007 XLM and 95,637
  USDC) and logged `shutdown done` at 22:18:54Z; the state file was written
  in the same second. All bot processes were gone 18 s after the signal.
  The two bot runner loops exited on the stop file; 643 stayed frozen.
- Final state pulled with `exec cat` to `~/pagebook-migration/mm-final.json`
  (3,450 B, valid JSON): 40 quotes, 20 per side, best 20,300 / 20,328,
  `next_nonce` 1,789,072,652,884 (6 past the insurance copy), 16,331 fills,
  387,678 lots. All 40 nonces are the insurance copy's; every tick had
  changed, so the copy taken eleven minutes earlier would have been stale.
  Also copied: `watchdog.log` (2,329 lines since 2026-08-25: 382 `MM OK`,
  258 `MM ALERT`, 321 autofix lines). The 40 MB maker log and 18 MB trader
  log stayed on the volume; the keepalive had run at 20:43Z (980 extends)
  and the refill at 20:39Z (nothing due).
- The SIGCONT did not land: `fly machine exec` runs its argument as a bare
  argv with no shell, and `kill` is a shell builtin in this image, so
  `exec "kill -CONT 643"` failed with "No such file or directory". The
  procedure is `exec "sh -c 'kill -CONT <pid>'"`. `fly machine stop` at
  22:22:06Z then delivered SIGTERM to the frozen supervisor, which could not
  act on it, and Fly's 180 s kill timeout ended the machine at 22:25:12Z
  (event `crash`, exit -1). Nothing was running but the frozen shell and
  the sleeping cranks, so the hard end changed no state. Machine
  `080d229a790448` is `stopped`; volume and secrets intact.
- Host volume seeded at 22:25Z with `mm-final.json` as
  `/data/state/mm-CAYP…H2JA-m0.json` and the Fly watchdog log as
  `/data/logs/watchdog.log`.

### Phase 3, 2026-09-23 22:25 UTC onward

- 22:25:49Z: `docker compose -f docker-compose.host.yml up -d` from the
  worktree; container `pagebook-bots-bots-1`, image `pagebook-bots-bots`.
  Two bot process groups (14 maker, 16 trader), each the `npx` wrapper,
  `sh -c tsx`, the `tsx` node and the bot's node process. The refill crank
  ran at boot (37,887 XLM, 19,167 USDC, nothing due) and the keepalive as
  `pb-keeper` extended the 5 levels the dry run had flagged.
- First host `loop` line at 22:26:57Z, 68 s after start: loop 0, `live` 40,
  20 per side, `replaced` 40, `placed` 0, `fills_total` 16,331 and
  `volume_lots` 387,678 carried from Fly, mid 0.20245. In its first two
  minutes the maker landed 10 `replace` and 3 `replace_batch`, with 8
  post-only `Crossed` rejections at simulation (free) and no bad outcome.
  The trader rested one order 3 s after start and took 2 lots at 22:26:53Z.
- Nonce scans from the checkout in a `node:22-slim` container: the maker's
  full Fly range [1,789,072,630,000, 1,789,072,654,000) holds exactly 40
  live orders (nonces 1,789,072,642,001 to ...042), the same set as the
  host's current state file, so nothing was stranded and nothing adopted
  was stale. The trader's range [1,789,072,630,000, 1,789,072,655,000)
  holds zero live orders. A first maker scan over `next_nonce` rounded
  down, the redeploy skill's shortcut, found nothing because the quotes'
  nonces sit 10,000 below the counter; the procedure text above is
  corrected.
- First acceptance check, `check.ts` by hand at 22:28:48Z: `MM OK`, 40
  live, own quotes 20,233 / 20,251 against book 20,245 / 20,247, last hour
  21 ok, 8 simulation-rejected, 0 apply-rejected, 2 heals, 0 bad; trader 2
  takes for 61 lots, 2 rests, 0 bad. One note: touch within the 15 bps
  through-mid tolerance.

- The supervisor's own first watchdog run, five minutes after boot at
  22:30:49Z: `MM OK`, 40 live, last hour 31 ok, 8 simulation-rejected, 0
  apply-rejected, 5 heals, 0 bad; trader 4 takes for 61 lots, 2 rests, 0
  bad. It lands in `/data/logs/watchdog.log` after the 2,329 Fly lines and
  on the container's stdout.

### Phase 4, 2026-09-23 22:32 UTC onward

- Ops clone at `~/code/pagebook-ops`, cloned from the local repository on
  this branch at `d7e8ffc` with `origin` pointed at GitHub; the env file
  installed there with mode 600; compose config validates. The deployment
  moves to it at the stop drill below, and it switches to `main` once the
  branch merges.
- Backup: `~/.local/bin/pagebook-backup-state.sh` copies the state files and
  the last 200 watchdog lines out of the volume into
  `~/pagebook-backups/<date>/` through an `alpine` container running as the
  user, keeps 30 days, and runs daily at 03:23 UTC from the user's crontab.
  Trial run at 22:32:44Z: 2 files.
- Health: `~/.local/bin/pagebook-health-cron.sh` runs the outside-in check
  from the ops clone and appends one compacted JSON line to
  `~/pagebook-health.jsonl`, hourly at :07 from the crontab. The script
  pretty-prints its `--json`, so the wrapper pipes it through `jq -c`. Trial
  at 22:33Z: `flags` empty, newest event 0.4 min old (the host bots), book
  20,232 / 20,235, maker 36,567 XLM.
- Off-host copies: none. The `aws` CLI here has no credentials for it; the
  Fly volume's snapshots cover the first week and the nonce scan is the
  last resort after that.

### Acceptance and stop drill, 2026-09-23 22:48 to 22:50 UTC

- Second `check.ts` by hand at 22:48:53Z, twenty minutes after the first
  (the operator waived the remaining ten, as ADR-031's cutover shortened
  its window): `MM OK`, 40 live, own quotes 20,228 / 20,246 against book
  20,228 / 20,244, last hour 122 ok, 27 simulation-rejected, 0
  apply-rejected, 19 heals, 0 bad; trader 25 takes for 517 lots, 5 rests,
  4 settles, 0 bad. No `footprint`, `trapped:unknown`, `resource_limit`,
  `Unfilled` or archived-entry outcome in either log since boot. Outside-in
  check at ledger 4,836,029: 3,015 events in the window, newest 6 s old,
  book 0.20228 / 0.20244 (8 bps, mid 1 bps under spot), maker 34,676 XLM
  and 96,133 USDC, trader 18,514 USDC, `FLAGS: none`.
- Stop drill at 22:49:05Z from the worktree: `docker compose stop` returned
  after 18 s. The maker finished loop 41 and logged `shutdown done` at
  22:49:18Z with the state file written at 22:48:58Z (40 quotes); the trader
  settled its one resting order (`0426dd…57d1`) and logged `shutdown done`
  at 22:49:22Z. The supervisor exited 143 after its shutdown wait, so the
  container stopped only once both bots were gone. This is the graceful
  path the Fly supervisor did not have.
- 22:49:24Z: `up -d --build` from `~/code/pagebook-ops` rebuilt the image
  (cache hits) and recreated the container in 1 s; the compose project now
  points at the ops clone's file. First loop line 35 s later: `live` 40,
  `replaced` 40, fills 16,352 carried over; two process groups; 5
  `replace_batch` landed in the first half minute; all 40 pre-stop nonces
  adopted.

### Phase 5, 2026-09-23 22:56 UTC

The operator waived the seven-day rollback window the same evening, after
the two clean checks and the drill. `fly machine destroy 080d229a790448
--force` removed the stopped machine at 22:56:05Z. The volume
`vol_r682qpoe0xglm3n4` (`pagebook_data`, 1 GB, created 2026-08-25) and the
app `pagebook-bots` with its three secrets were left for the operator to
remove by hand, since the agent's tooling refused those two destroys:

```bash
fly volumes destroy vol_r682qpoe0xglm3n4 -a pagebook-bots -y
```

```bash
fly apps destroy pagebook-bots -y
```

The volume still holds the Fly era's `mm.log` (40 MB), `trader.log` (18 MB)
and `keepalive.log` (4 MB), which were not archived; the state files, the
watchdog log and every number the ADR-033 to ADR-044 records quote are
already in the repository or in `~/pagebook-migration/` on the host. With
the machine gone there is no rollback to Fly; the rollback section above
would need a fresh `fly deploy` first.

The move is complete.
