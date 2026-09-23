---
name: redeploy-testnet
description: Redeploy the PageBook contract to Stellar testnet and cut the bots and web client over to it, end to end (build, upload, deploy, create market 0, 30-minute smoke on scratch identities, wind down the old deployment, edit the five config locations, rebuild the bots container on the ops host, acceptance, ADR cutover record, PR). Use this whenever a merged change alters a storage entry layout or the contract interface (ADR-023 says there is no upgrade path, so any `Market`, `Level`, `Order` or entry-point change means a fresh deployment), whenever the user says "redeploy", "cut over", "new testnet contract", "the client can't parse the live Market entry", or asks to fill in an ADR's "Cutover record" section. Also use it for partial runs (only the smoke, only the wind-down, only collecting fees from a retired contract).
---

# Redeploy PageBook on testnet

You are the operator. The contract is immutable once deployed (ADR-023), so a layout or
interface change is always a new address, a new market 0, and a cutover of everything
that carries the contract id. The procedure below is the one ADR-036, ADR-037 and
ADR-044 followed; their "Cutover record" sections are the reference output. Read the
newest of them first so the record you write matches in shape.

The whole run takes about two hours of wall clock, most of it waiting on two 30-minute
acceptance windows. Everything is testnet; still, treat `pagebook-builder-2` as a
production key and the bots container on the ops host as production. Steps 1 to 4 run
where the keychain and the stellar CLI are (the Mac); the bot stop in step 4 and the
restart in step 5 run on the ops host, over ssh, with Docker (ADR-047).

## Stop-and-ask boundaries

Do these only with the user's explicit go-ahead in chat, given for this run:

- Stopping the bots container on the ops host (it halts the live maker and trader).
- Spending from `pagebook-builder-2` for anything except upload, deploy,
  `create_market` and `collect_fees`. Adding a USDC trustline to it counts.
- Merging the PR.

Everything else (deploying, creating the market, running the smoke on the funder
identities, editing config files, opening the PR) follows from the request. If the smoke
fails acceptance, stop, leave the old deployment running, and report with the logs.

## Fixed facts

| What | Value |
|---|---|
| Admin and fee recipient | `pagebook-builder-2`, `GB2JQQZB4K2R6UTQYN7OQHZQ72LGAQ3UQOVQ6ZEE42U5D64LJDST5SLK` |
| Bots | `pb-mm-fly` (maker), `pb-trader-fly` (trader) |
| Smoke identities | `pb-fly-funder-1` (maker), `pb-fly-funder-2` (trader) |
| Keychain | `/Users/tomer/dev/pagebook/.stellar` (git-ignored, main checkout only) |
| Base SAC (native XLM) | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| Quote SAC (USDC) | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| USDC issuer | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
| Market 0 geometry (ADR-026) | lot 100,000,000, tick 1,000, band [1, 4,194,304), fee 5 bps, 1 to 1,000,000 lots, `level_cap` default 64 |
| Bots host | `user-dev-050a`, container `pagebook-bots-bots-1` from `~/code/pagebook-ops/clients/web/ops/deploy/docker-compose.host.yml`, volume `pagebook-data` at `/data`, secrets in the gitignored `env` beside the compose file |
| Acceptance (ADR-031) | watchdog `MM OK` twice, 30 minutes apart, no `footprint` / `trapped:unknown` / `resource_limit` outcome on either bot |

Every `stellar` command takes `--config-dir /Users/tomer/dev/pagebook/.stellar` with the
absolute path. A relative `.stellar` does not resolve from a worktree, and the CLI's
"local config ... is no longer read, run `stellar config migrate`" warning is noise as long
as `--config-dir` is explicit; do not run the migration. The ops scripts find the keychain
by walking up from the working directory, which reaches the main checkout from any
worktree under `.claude/worktrees/`, but pass `--config-dir` to them too.

## Procedure

### 1. Build and test from `main`

Confirm the checkout is at or after the merge commit and clean. `make build` then
`make test`; also `npx vitest run` in `clients/web`. Record the wasm size and its sha256
(`shasum -a 256 target/wasm32v1-none/release/pagebook.wasm`; the network's wasm hash is the
same sha256). Note the test counts for the record.

### 2. Upload, deploy, create market 0

Upload and deploy as two commands so the record gets two tx ids, as the earlier ADRs did:

```bash
stellar contract upload --wasm target/wasm32v1-none/release/pagebook.wasm --source pagebook-builder-2 --network testnet --config-dir /Users/tomer/dev/pagebook/.stellar
```

```bash
stellar contract deploy --wasm-hash <hash> --source pagebook-builder-2 --network testnet --config-dir /Users/tomer/dev/pagebook/.stellar --alias pagebook-v<N> -- --admin GB2JQQZB4K2R6UTQYN7OQHZQ72LGAQ3UQOVQ6ZEE42U5D64LJDST5SLK --fee_recipient GB2JQQZB4K2R6UTQYN7OQHZQ72LGAQ3UQOVQ6ZEE42U5D64LJDST5SLK
```

The CLI prints "Signing transaction: <hash>" for each; that is the tx id. Then
`create_market` with the geometry above (`--base`, `--quote`, `--lot_size`, `--tick_size`,
`--tick_min 1`, `--tick_max 4194304`, `--taker_fee_bps 5`, `--min_order_lots 1`,
`--max_order_lots 1000000`). It returns `0`.

Verify two ways. The `level` view (`-- level --market 0 --is_bid true --tick 20000`)
reads `depth` 0 on an empty tick. The contract has no `market` view and
`stellar contract read` without a key returns only the instance, so decode `Market(0)`
with the bundled script, from `clients/web`:

```bash
npx tsx ../../.claude/skills/redeploy-testnet/scripts/read-market.mts <new-contract> <old-contract>
```

Confirm the geometry, `level_cap`, and that any field the change removed is absent on the
new contract and present on the old one. Note both entry sizes for the record.

### 3. Smoke run on the funder identities (30 minutes)

Never point production identities at an unproven contract. Refill the smoke identities
first (the flags take addresses, and default to the production bots, so pass both):

```bash
npx tsx ops/refill.ts --maker <pb-fly-funder-1 address> --trader <pb-fly-funder-2 address> --usdc-issuer GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --log <scratch>/refill-smoke.log
```

Then start the 5-level maker and the trader, both detached. A Bash tool background
command is bounded by the tool's timeout (ten minutes at most) and macOS has no `setsid`,
so use `nohup ... & disown` from a foreground command and keep the pids. A maker killed
mid-cycle leaves quotes its state file never recorded:

```bash
nohup npx tsx ops/mm.ts --contract <new> --market 0 --identity pb-fly-funder-1 --config-dir /Users/tomer/dev/pagebook/.stellar --base-sac <base> --quote-sac <quote> --usdc-issuer <issuer> --levels 5 --base-lots 2 --step-lots 1 --interval 30 --state <scratch>/mm-smoke.json --log <scratch>/mm-smoke.log >> <scratch>/mm-smoke.out 2>&1 & disown
```

```bash
nohup npx tsx ops/trader.ts --contract <new> --market 0 --identity pb-fly-funder-2 --config-dir /Users/tomer/dev/pagebook/.stellar --base-sac <base> --quote-sac <quote> --usdc-issuer <issuer> --log <scratch>/trader-smoke.log >> <scratch>/trader-smoke.out 2>&1 & disown
```

Pad v2 (`--pad-cover sized`) is the default for both. Keep state and logs in the session
scratchpad, never in the repo. Watch the window with a Monitor that greps both logs for
`footprint|trapped:unknown|resource_limit` and checks the pids are alive; do not poll by
hand. Meanwhile load the dev client (`npm run dev` through the browser preview, URL
`/?contract=<new>&market=0`) and confirm the book renders with no console errors.

At the end run the watchdog against the smoke files:

```bash
npx tsx ops/check.ts --contract <new> --market 0 --identity pb-fly-funder-1 --config-dir /Users/tomer/dev/pagebook/.stellar --log <scratch>/mm-smoke.log --state <scratch>/mm-smoke.json --trader-log <scratch>/trader-smoke.log
```

Pass means `MM OK` and zero bad outcomes on both sides. Tally the log lines by
`(action, outcome)` for the record (ok, `sim:typed:Crossed` is a free post-only rejection,
apply-rejected, bad, heals, fills, lots; trader takes, rests, settles). Then SIGTERM the
trader (it settles its rests), SIGTERM the maker, and unquote it with the same `mm.ts`
command plus `--cancel-all`. Check the `level` view at its recorded bids and asks reads
`open_lots` 0.

### 4. Wind down the old deployment (ask first)

Before asking, preview what the old vault holds, without sending:

```bash
stellar contract invoke --id <old> --source pagebook-builder-2 --network testnet --config-dir /Users/tomer/dev/pagebook/.stellar --send=no -- collect_fees --market 0 --token <token>
```

The base leg returns the XLM fee amount in stroops. The USDC leg fails with
`Error(Contract, #13)` from the SAC when the fee recipient has no USDC trustline, which is
the case for `pagebook-builder-2` today. Collecting USDC needs either a trustline on the
admin (a `change_trust` from `pagebook-builder-2`, which is spend outside the allowed
set) or `set_fee_recipient` to an account that has one. Put the choice to the user with
the amounts; the default is to collect the XLM and leave the USDC, saying so in the ADR.

With the go-ahead, in this order:

1. Read the container's current state for the record, on the host:
   `docker exec pagebook-bots-bots-1 sh -c 'tail -c 1500 /data/logs/watchdog.log; ls -la /data/state'`.
2. Stop the container: `docker compose -f docker-compose.host.yml stop` from the deploy
   directory of the ops clone. The supervisor's `shutdown` signals both bot process
   groups and waits up to 170 s for them to exit, so the maker finishes its cycle with
   its state saved and the trader settles its rests before the container goes down
   (18 s in the ADR-047 drill). Confirm both logs end with `shutdown done`; the volume
   is readable through a throwaway container while the bots are stopped:
   `docker run --rm -v pagebook-data:/data:ro alpine sh -c 'tail -c 300 /data/logs/mm.log; echo; tail -c 300 /data/logs/trader.log'`.
   The chain is still the truth, which is why step 5 exists.
3. Copy the state file out the same way:
   `docker run --rm -v pagebook-data:/data:ro alpine cat /data/state/mm-<old>-m0.json > <scratch>/mm-old.json`.
4. Settle the old quotes so escrow returns to `pb-mm-fly`:
   `npx tsx ops/mm.ts --contract <old> --market 0 --identity pb-mm-fly --config-dir ... --base-sac ... --quote-sac ... --usdc-issuer ... --state <scratch>/mm-old.json --log <scratch>/mm-old-cancel.log --cancel-all`.
   The `main` client reads `Market` fields by name, so it usually still parses the old
   entry; confirm with the read-market script before relying on it, and if the layout
   change broke parsing or the pads, run the cancel from a worktree at the old ADR's
   commit. Record the first and last tx and the `level` view at the recorded bests.
5. Scan for orders the state file lost. Two makers or two traders running at once (the
   ADR-037 duplicate-bot incident) leave orders no state file knows about, and a hard
   kill mid-cycle does too (ADR-044: one trader rest). `Order` entries exist only
   while an order is live, and bot nonces are `boot_seconds * 1000 + k`, so a range of
   keys through batched `getLedgerEntries` covers an identity:

   ```bash
   npx tsx ../../.claude/skills/redeploy-testnet/scripts/scan-orders.mts <old> <G-owner> <base> <to> [--state <scratch>/rebuilt.json]
   ```

   Both bases are the container's last start second (`docker inspect -f
   '{{.State.StartedAt}}' pagebook-bots-bots-1`, times 1,000); the maker's counter
   persists in its state file, so scan up to just past its `next_nonce`, and do not
   shortcut with `next_nonce` rounded down: after weeks the live quotes sit thousands
   of nonces below the counter (ADR-047 found 40 orders at 1,789,072,642,0xx under a
   counter of ...652,884). If the trader's start second is in doubt, any trader
   transaction on Horizon (`/transactions/<hash>/operations`) carries the nonce as a
   `U64` in the `place` parameters. Settle stragglers: a maker's via `--cancel-all` over the `--state` file the
   scan writes, a trader's with
   `stellar contract invoke --id <old> --source pb-trader-fly ... -- settle --market 0 --owner <G> --nonce <n>`.
   Rescan until both read zero, and compare `pb-mm-fly` / `pb-trader-fly` balances
   before and after so the escrow return is on the record.
6. `collect_fees` on the old contract for the tokens the user approved. Record amounts.

### 5. Cut over

Five places carry the contract id. Edit all of them; a `grep -rn <old-id>` outside
`docs/decisions/` afterwards should find only the README's list of earlier deployments:

- `clients/web/ops/deploy/docker-compose.host.yml` (`CONTRACT` in `environment`; the
  outside-in health check reads the id and market from here too)
- `clients/web/ops/deploy/docker-compose.yml` (`CONTRACT` in `x-market`)
- `clients/web/src/main.ts` (`DEFAULT_CONTRACT`)
- `README.md` "Testnet deployment": the current contract and its ADR; move the old id
  into the earlier-deployments sentence with its ADR
- `clients/web/README.md`: the `contract` default in the URL-parameter table, as
  `CXXX…XXXX` (first four, ellipsis, last four)

`docs/09-resource-utilization.md` quotes per-transaction samples from a retired
deployment under a header note; a fresh `ops/resources.ts` sample needs hours of
production traffic in every category, so it stays the follow-up unless the user asks for
it. Do not edit the explainer pages unless they name the contract; if you must, they go
through the `humanizer` skill.

Push the branch, then on the ops host bring the clone onto it and rebuild:

```bash
cd ~/code/pagebook-ops && git fetch origin && git checkout <branch> && cd clients/web/ops/deploy && docker compose -f docker-compose.host.yml up -d --build
```

The container is stopped from step 4, so `up` builds the image from the branch (a
minute; cached layers) and starts it with the new `CONTRACT`. The maker's state file is
keyed by contract, so it starts from a fresh `/data/state/mm-<new>-m0.json`; the old
file stays on the volume as history. Within two minutes check that exactly two bot
process groups exist (the listing in `ops/README.md`, one pgid for `ops/mm.ts` and one
for `ops/trader.ts`), that `refill.log` and `keepalive.log` show a run, and that the
trader is taking. Acceptance is two `MM OK` lines 30 minutes apart in
`/data/logs/watchdog.log`; the supervisor's watchdog first runs five minutes after boot
and then hourly, so run `check.ts` yourself at the 30-minute marks:

```bash
docker exec pagebook-bots-bots-1 sh -c 'npx tsx ops/check.ts --contract $CONTRACT --market $MARKET --identity pb-mm --log /data/logs/mm.log --state /data/state/mm-$CONTRACT-m$MARKET.json --trader-log /data/logs/trader.log'
```

After the PR merges, put the ops clone back on `main` (`git checkout main && git pull`);
no rebuild is needed when the merge changes nothing under `clients/web`.

### 6. Record and PR

Fill the ADR's "Cutover record" in the ADR-037 shape: a bullet list (date and
identities; wasm hash, size, source commit, test counts, upload and deploy tx; contract
id; market 0 tx and geometry with the entry check), then `### Smoke run`, `### Wind-down
and cutover` subsections with the tallies, tx ids, balances and the image id
(`docker inspect -f '{{.Image}}' pagebook-bots-bots-1`). Short
tx ids as `abcdef…1234`. Factual, short, no em dashes, no history of the run's own
mistakes unless they changed the procedure (then a subsection, as ADR-037's incident did).

Before committing, `git status` and make sure nothing from `.stellar/`, `target/`, the
scratchpad, `.claude/launch.json` or bot state files is staged. Commit the config, README,
ADR and skill changes on a branch, push, open a PR against `main` with a title under 70
characters and a body that says what was deployed and links the contract on
`https://stellar.expert/explorer/testnet/contract/<id>`. Wait for CI. Ask before merging.

## Things that bit earlier runs

- Two makers sharing a state file overwrite each other's quote lists and strand orders
  (ADR-037). The supervisor uses `setsid`, a five-minute watchdog grace period, and a
  shutdown that waits for the bots (ADR-047), but still count process groups after
  every boot. Never start a second maker on the production identity anywhere, a smoke
  run included, while the container runs.
- The Bash tool's background mode is not a process supervisor. Its commands are bounded
  by the tool timeout, so a bot started there can die mid-cycle. Detach with `nohup` and
  `disown` instead, and confirm exactly one maker and one trader with
  `ps -axo pid,ppid,command | grep -E "ops/(mm|trader)\.ts"`.
- `stellar contract read --id X --durability persistent` with no key prints only the
  instance entry; contract data needs the exact key, hence the read-market script.
- `stellar contract invoke ... --send=no` simulates and prints the return value without
  spending; use it to preview `collect_fees` and any other admin call.
- The refill crank's floors (maker 30,000 XLM, trader 5,000 USDC) are tuned for the
  production ladder; on a funder identity it will merge four friendbot accounts the first
  time. That is expected and cheap.
- `docker exec` runs a bare argv: pipelines and shell builtins (`kill`) need `sh -c`,
  and group kills need `bash -c` because dash's `kill` rejects `-- -<pgid>`. There is
  no `ps` in the image; walk `/proc/*/cmdline`, and read the pgid from
  `/proc/<pid>/stat` after the `)` that closes the command name, because `npx` sets a
  process title with spaces and a plain field count misreads those rows.
- `mm.ts --cancel-all` reports `settle other / fetch failed` on an RPC hiccup and keeps
  the quote in the state file; rerun it. `sim:typed:UnknownOrder` on the rerun means the
  first attempt had landed.
- zsh treats a bare `=====` as a command path. Quote separators in shell one-liners.
- `.claude/launch.json` is tracked. If you point it at your worktree for the dev
  preview, `git checkout -- .claude/launch.json` before committing.
