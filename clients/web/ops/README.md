# Ops: the bots that run the testnet markets

TypeScript entry points on the web client's engine (ADR-031): `mm.ts` (market
maker), `trader.ts` (traffic generator), `check.ts` (watchdog), `soak.ts`,
`stress.ts`, `resources.ts`. Run locally with `npm run ops:<name>` from
`clients/web`, or in containers with `deploy/`.

The bots depend on two layers inside the web package: `src/client/` (RPC
transport, ledger-entry decoding, network constants, account reads, protocol
codecs) and `src/engine/` (key planning, padding, prepare, submit).

## Identities and secrets

A bot resolves its identity secret from `PB_SECRET_<NAME>` (dashes become
underscores, uppercased: `pb-mm` reads `PB_SECRET_PB_MM`) or, failing that,
from the stellar CLI keychain via `stellar keys secret <name>` (the config
dir is found by walking up from the working directory). Secrets stay in
memory; nothing is written to disk.

## Cloud deployment (Docker Compose)

`deploy/docker-compose.yml` runs three services on any Docker host: `mm`
(maker), `trader`, and `watchdog` (runs `check.ts` every 30
minutes; its stdout is the alert surface, so `docker compose logs -f
watchdog` and grep for `MM ALERT`). State and JSONL logs live on named
volumes (`pagebook-state`, `pagebook-logs`).

Bring-up on a fresh host:

1. `git clone` the repo; `cd clients/web/ops/deploy`.
2. `cp env.example env && chmod 600 env`; fill the two `PB_SECRET_*` values,
   extracted on the machine that has the keychain with
   `stellar keys secret pb-mm --config-dir .stellar` (repo root).
3. Validate first with scratch identities against the live contract (for
   example a 5-level maker on a funder identity topped up by `refill.ts`, as
   the ADR-036 smoke did). Pass = 30 minutes with no `footprint` /
   `trapped:unknown` / `resource_limit` outcomes and the watchdog printing
   `MM OK`. `docker-compose.scratch.yml` targeted the PBA/PBB scratch market
   on the retired `CDX3…U2RO` deployment and needs a scratch market on the
   live contract before it can be used again.
4. Cut over the production identities (state handoff below), then
   `docker compose up -d --build`. `CONTRACT` and `MARKET` come from the
   compose file's `x-market` block (XLM/USDC is market 0 on the live
   contract).

## Cutover and state handoff

The maker's state file is the source of truth for its live quotes. To move
the maker between hosts without unquoting the market:

1. On the old host: stop the maker WITHOUT `--cancel-on-exit` (SIGTERM; in
   compose, `docker compose stop mm`). Quotes stay live on the book; the
   state file is current at exit.
2. Copy the state into the new host's volume, keeping the
   `mm-<CONTRACT>-m<MARKET>.json` name:
   `docker compose cp <src> mm:/app/ops/state/mm-<CONTRACT>-m<MARKET>.json`
   (or `docker run --rm -v pagebook-state:/s -v $(pwd):/h alpine cp
   /h/mm-<CONTRACT>-m<MARKET>.json /s/` before first start).
3. Start the maker; its first cycle adopts the quotes and reconciles any
   fills from the gap. Fallback if adoption misbehaves: run once with
   `--cancel-all`, then start fresh (settle and requote).
4. Watchdog green twice, 30 minutes apart, completes the cutover.

Rollback is the same procedure in reverse; the state file schema is
identical across hosts (and was identical to the retired Python bot's, which
is how the original migration cut over).

## Operational notes

- The fly entrypoint launches each bot under `setsid` and its watchdog autofix
  signals the process group. Signalling only the `npx` wrapper lets the node
  process survive while the runner starts another: two makers then share one
  state file and quotes fall out of it (the 2026-09-09 duplicate-maker
  incident, ADR-037). The watchdog also waits five minutes after boot before
  its first check, since a fresh log has no loop line yet.
- The maker exits on SIGTERM leaving quotes live; `restart: unless-stopped`
  plus state resume makes container restarts safe. `--cancel-on-exit` is for
  deliberate unwinding only.
- Sized pad cover (existence-aware write-byte coverage, ADR-028) is the
  default for the maker; it roughly halves declared write bytes. If
  apply-time `resource_limit` outcomes appear (the quantified in-flight
  race), restart with `--pad-cover flat`. `prepare:resource_limit` means
  the requested band or batch is too wide; the flat fallback does not
  change that.
- The trader needs nothing persistent; the watchdog needs only the volumes.
- Feeds (Coinbase, Kraken, Bitstamp), Soroban RPC, and Horizon are the only outbound
  dependencies; all HTTPS.

## Host deployment (one supervisor container)

`deploy/docker-compose.host.yml` runs the Fly layout on any Docker host as a
single container: the supervisor in `deploy/fly-entrypoint.sh` starts the
maker, the trader, the daily keepalive and refill cranks and the hourly
watchdog, with `/data` on the external volume `pagebook-data`
(`/data/state/mm-<CONTRACT>-m<MARKET>.json`, `/data/logs/*.log`). The
contract, market, SAC ids and USDC issuer are the compose file's
`environment` block, the same values as `fly.toml`. ADR-047 records the move
from Fly and holds the step-by-step cutover.

Bring-up, from `clients/web/ops/deploy`:

1. `docker volume create pagebook-data`. The volume is external so `docker
   compose down -v` cannot delete the state file.
2. Secrets into `./env`, mode 600 (`umask 077`). A running Fly Machine hands
   them out with `fly machine exec <id> -a pagebook-bots "printenv
   PB_SECRET_PB_MM"` (likewise `PB_SECRET_PB_TRADER` and
   `PB_SECRET_PB_KEEPER`); the stellar CLI keychain is the other source.
   `.dockerignore` keeps the file out of the image.
3. `docker compose -f docker-compose.host.yml build`, then the read-only
   checks with the real env: `run --rm --no-deps bots sh -c 'npx tsx
   ops/keepalive.ts ... --dry-run'` and `run --rm --no-deps bots sh -c 'npx
   tsx ops/refill.ts --usdc-issuer $USDC_ISSUER --dry-run'`. Never start
   `mm.ts` on a host while another maker runs on the same identity
   (ADR-037).
4. Seed the volume with the maker's state file from the old host (handoff
   below), then `docker compose -f docker-compose.host.yml up -d`.
5. After boot, count bot process groups: each bot runs under `setsid`, so
   its `npx`, `tsx` and `node` processes share one pgid, and the listing
   must show exactly two. Run `check.ts` by hand at 5 and 35 minutes; the
   supervisor's own watchdog runs at 5 minutes and then hourly into
   `/data/logs/watchdog.log`.

   ```bash
   docker compose -f docker-compose.host.yml exec bots bash -c 'for d in /proc/[0-9]*; do c=$(tr "\0" " " < $d/cmdline 2>/dev/null); case "$c" in *"/proc/"*) ;; *ops/mm.ts*|*ops/trader.ts*) echo "pgid $(sed "s/.*) //" $d/stat | awk "{print \$3}") $c";; esac; done | sort'
   ```

   (The pgid is read after the `)` that closes the command name: `npx` sets
   a process title with spaces, which breaks a plain field count on
   `/proc/<pid>/stat`. The first case arm skips the listing shell itself.)

Stopping. `docker compose -f docker-compose.host.yml stop` sends SIGTERM to
the supervisor, which signals both bot process groups and then waits up to
170 s for them to exit (the maker at its cycle boundary with its state
saved, the trader after settling its rests) before it lets the container go
down; `stop_grace_period` is 180 s. Rebuilds (`up -d --build`), `dockerd`
restarts and host reboots take the same path, so `restart: unless-stopped`
plus state resume keeps them safe.

State handoff to or from another host: stop the maker without
`--cancel-on-exit`, copy `mm-<CONTRACT>-m<MARKET>.json` into the other
host's state directory, start, and confirm the first `loop` line adopts the
quotes. Into the volume before a first start:

```bash
docker run --rm -v pagebook-data:/data -v "$PWD":/h alpine sh -c 'mkdir -p /data/state /data/logs && cp /h/mm-<CONTRACT>-m<MARKET>.json /data/state/'
```

Out of it, the same command with the two `cp` arguments reversed. A daily
crontab entry that copies `/data/state/*.json` out this way is the backup;
the nonce-range scan in the redeploy skill is the last-resort recovery when
a state file is lost.

## Fly deployment (retired 2026-09-23)

The bots moved to a Docker host on 2026-09-23 (ADR-047) and machine
`080d229a790448` of app `pagebook-bots` was destroyed the same evening. What
follows describes that deployment as it ran; a return to Fly would start
from `fly deploy` again.

`clients/web/fly.toml` runs the maker, trader, and watchdog on one Fly Machine
in `iad`; its `[env]` block carries `CONTRACT`, `MARKET` (0), both SAC ids and
the USDC issuer, which `deploy/fly-entrypoint.sh` passes to every bot. The
maker's state file on the volume is `/data/state/mm-<CONTRACT>-m<MARKET>.json`,
so a redeploy to a new contract or market starts from an empty book rather
than adopting the previous book's quote list; the old file stays on the
volume as history. The app has no public service. A 1 GB volume mounted at `/data`
holds the maker state files, the bot logs, and the hourly watchdog log across restarts and
deploys. The watchdog runs once an hour. If it finds a stale bot or a hard
runtime error, it restarts that bot through the supervisor. Price-move and
low-reserve alerts remain visible in the watchdog log for operator follow-up.

From `clients/web`:

1. Sign in with `fly auth login`.
2. Create the app without starting a Machine:
   `fly apps create pagebook-bots`.
3. Set `PB_SECRET_PB_MM` and `PB_SECRET_PB_TRADER` with `fly secrets set`.
4. Deploy with `fly deploy`.
5. Confirm the Machine and all three bots with `fly status` and `fly logs`.

Fly sends `SIGTERM` and waits up to three minutes. The supervisor forwards the
signal to both bots. The maker saves its current state and leaves its quotes
live; the trader settles its temporary resting orders before exiting.
