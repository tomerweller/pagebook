# Prior art: high-performance on-chain CLOBs

*Survey compiled August 2026. Solana gets the most attention because its transaction
account list is the closest analogue to Soroban's footprint: every account touched must
be declared before execution, write locks serialize conflicting transactions, and
accounts-per-transaction is a scarce, router-visible resource.*

## Solana: four generations

### Serum v3 (2020) — slabs + event queue + crank

Each book side is a crit-bit tree packed into a large pre-allocated "slab" account.
Settlement is asynchronous: matching appends fills to an **event queue** account, and a
permissionless **crank** later replays events against per-trader OpenOrders accounts.
The crank exists because settling makers inline would require their accounts in the
taker's transaction — exactly the account-list blowup problem. Lessons: the crank became
the system's real cost center (keeper infra, latency, most of the compute), and
per-trader OpenOrders accounts added rent and account-count overhead everywhere.

### Phoenix (2023) — crankless, seats, one market account

The whole market — both book sides plus a ledger of per-maker claimable balances
("**seats**") — lives in one large pre-allocated account. Matching writes only that
account: maker proceeds accrue to seat balances; makers withdraw separately; takers
settle atomically against market vaults. Orders are stored compressed in fixed
structures. Costs: large upfront rent for max capacity, a fixed seat limit, and one
write-lock over the whole market (all ops on a market serialize). Phoenix proved
cranklessness: **matching must never touch maker token accounts.**

### OpenBook v2 (2023–24) — community Serum successor

Retains an event heap (crank-ish path) plus OpenOrders accounts; supports oracle-pegged
orders. Requires ~16 accounts for a standard swap vs Phoenix's 8 — and the ecosystem
treats accounts-per-swap as a first-class venue ranking metric for routers (Jupiter).
Lesson: **integration cost is measured in accounts touched, not just compute.**

### Manifest (2024) — hypertree, expandable accounts, global orders

The most instructive for Soroban. Key ideas from the whitepaper ("The Orderbook
Manifesto", CKS Systems):

- **Hypertree**: all node-based structures (bids RB-tree, asks RB-tree, claimed-seats
  RB-tree, free-list) share one address space of uniform **80-byte nodes** inside a
  single account. Any node slot can serve any structure, so one allocation pool serves
  the whole market.
- **Expandable accounts**: the market account grows by `realloc` as orders arrive
  instead of pre-allocating for peak — ~500x cheaper market creation than Phoenix-style
  pre-allocation; traders effectively pay rent for the space they use.
- **Global orders**: a trader deposits once into a global account and quotes across many
  markets; on fill, funds move just-in-time. Capital efficiency scales with market
  count; the cost is extra accounts in the fill path and a race (maker may have moved
  funds) handled by skipping the order.
- Benchmarks (their numbers): 7 accounts per swap (vs 8 Phoenix, 16 OpenBook v2);
  ~45% less compute per order than Phoenix; fee-less core.
- Explicit design constraints that read like a Soroban requirements doc: accounts must
  be known before transaction construction; minimize accounts for router compatibility;
  allow reads without write-locks (their wrapper isolates read paths); use rent economics
  as anti-spam.

## Sui: DeepBook v3

Book sides live in a `BigVector` — an on-chain B+ tree — inside a shared `Pool` object;
`BalanceManager` objects hold user funds with **settled/owed** balance accounting: every
user action nets out what the pool owes them / they owe the pool, and the vault moves
tokens at the edges. Order ids are composite (price, sequence) for price-time priority.
Writes to shared objects go through consensus and serialize per object — the same
"one lock per market" shape as Phoenix, enforced by the runtime. Lesson: the
**book + internal balance ledger + vault** decomposition recurs on every runtime.

## Aptos: Econia

Built an "AVL queue" — a hybrid AVL tree + doubly-linked FIFO — over Move table items,
with per-user "market accounts" for deferred settlement. Fine-grained global storage per
tree node under per-item storage metering made operations storage-op heavy; the protocol
wound down in 2024–25. Cautionary lesson for Soroban, whose per-entry framing overhead
(~100–200 bytes) and per-entry footprint slots similarly punish node-per-item trees.

## Appchains and batch designs (contrast class)

dYdX v4, Hyperliquid, and Injective run the book in validator memory / protocol code —
matching leaves the VM entirely. That is the right answer for raw throughput and the
wrong one for contract composability. Stellar already occupies this niche twice over:
the **classic native DEX** (on-ledger offers matched by core) and **SPEEDEX** (SDF
research: per-ledger batch auctions clearing at a uniform price, designed for
parallelism and order-independence). A Soroban CLOB exists for what those can't do:
composability with contracts (vaults, strategies, RWA permissioning, routers). A
SPEEDEX-flavored *batch auction market type* is a natural sibling to PageBook for hot
markets — collect orders, clear once per ledger — trading latency for zero contention.

## Convergent lessons

1. **Stable, coarse addressing.** Book state lives at addresses that are pure functions
   of (market, side, price/page) — never content-derived. This is what makes declared
   account-lists/footprints workable, and — critically for Soroban — *paddable*.
2. **Matching writes O(price levels crossed), never O(makers).** Internal claim/balance
   ledgers (seats, settled/owed, deferred claims) keep maker settlement out of the
   taker's write set. Event-queue + crank is the failure mode; crankless atomic
   settlement won.
3. **Small fixed-size packed order records** inside larger containers; grow by
   paging/realloc (Manifest) rather than pre-allocating for peak (Phoenix).
4. **Entries/accounts touched per operation is the router-facing cost metric.**
5. **Price-time priority via composite (tick, seq) keys**, with per-market tick/lot
   quantization. Nobody carries full-range logarithmic ticks + rounding-correction
   machinery on chain (that's a Deepstate specialty enabled by EVM's free-form slots —
   see `02-deepstate-evaluation.md`).

## Sources

- Manifest: The Orderbook Manifesto — https://www.manifest.trade/assets/The_Orderbook_Manifesto.pdf
- Manifest repo — https://github.com/CKS-Systems/manifest
- Introducing Phoenix (Ellipsis Labs) — https://mirror.xyz/0x9Daf73caA5669D114A920a12770328Fcd9600af5/HXR15M7e1Zx2gZpxuMHo5pv7oggvssreS-fFpvJ97W4
- Phoenix v1 repo — https://github.com/Ellipsis-Labs/phoenix-v1 ; crankless-design podcast — https://solanacompass.com/learn/Validated/level-up-go-crankless-w-jarry-xiao-ellipsis-labs
- DeepBook v3 design — https://docs.sui.io/standards/deepbookv3/design
- Econia AVL queue module docs — https://github.com/econia-labs/econia/blob/main/src/move/econia/doc/avl_queue.md
- SPEEDEX — https://www.usenix.org/conference/nsdi23/presentation/ramseyer (SDF research)
