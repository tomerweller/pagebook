//! PageBook client helper (05 M5): key computation and the padding protocol of
//! architecture §14. Pure functions over the contract's `quote_place` output;
//! the SDK that wraps this resolves `ClientKey`s to ledger keys, adds archived
//! flags from RPC (`getLedgerEntries`), and assembles the footprint.

use pagebook_types::{page, word_of, MarketId};

/// A PageBook (or vault) ledger key, addressed the way the contract keys it.
/// Addresses are the 32-byte contract/account id; the SDK turns them into
/// `Address`es. `VaultBalance(token)` is the SAC balance entry of the PageBook
/// contract inside `token` (architecture §6): not a PageBook key, but part of
/// every settling footprint.
#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub enum ClientKey {
    Config,
    Market(u32),
    Level(u32, bool, u32),
    LevelPage(u32, bool, u32, u32),
    Order(u32, [u8; 32], u64),
    FeeAccrual(u32, [u8; 32]),
    BestTick(u32, bool),
    TickSummary(u32, bool),
    TickWord(u32, bool, u32),
    VaultBalance([u8; 32]),
    /// The caller's own balance entry inside `token` (an account's trustline or
    /// native balance, or a contract's SAC balance): touched by every transfer
    /// to or from the caller (ADR-021).
    UserBalance([u8; 32]),
}

/// One level the simulated walk visited (mirror of the contract's `CrossedLevel`).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CrossedLevel {
    pub tick: u32,
    pub head_seq: u32,
    pub open_lots: u64,
}

/// The simulate step's output plus what the client already knows (mirror of the
/// contract's `QuoteResult` for the fields the contract returns).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Quoted {
    pub market: MarketId,
    pub own_side: bool,
    pub limit_tick: u32,
    pub start_tick: u32,
    pub crossed: Vec<CrossedLevel>,
    /// `tail_seq` of the own-side level at `limit_tick`, at simulation.
    pub tail_seq: u32,
    pub taker: [u8; 32],
    pub nonce: u64,
    pub base: [u8; 32],
    pub quote: [u8; 32],
}

/// A page range, inclusive (mirror of the contract's `PageRange`).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PageRange {
    pub first: u32,
    pub last: u32,
}

/// The `SlotWindow` the client passes to `place` (mirror of the contract's).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WindowSpec {
    /// One entry per set level in the band: `(tick, pages)`.
    pub consume: Vec<(u32, PageRange)>,
    pub append: PageRange,
}

/// The padded declaration for one place (architecture §14).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PadOut {
    /// Every key to declare read-write. Superset of what the contract touches
    /// for any book state reachable between simulation and inclusion inside
    /// the band `[start_tick, pad_end]` and the declared windows.
    pub keys: Vec<ClientKey>,
    pub window: WindowSpec,
}

/// Width of the consume window past the simulated head page (§14: "small").
pub const CONSUME_WIDTH: u32 = 1;

/// Keys a `settle` touches: the order, its level, at most one page (the page
/// holding the settled seq; page 0 for an inline seq — the head advance may run
/// into page 0), the vault balances of both tokens (payout + refund).
#[allow(clippy::too_many_arguments)]
pub fn keys_for_settle(
    market: u32,
    owner: [u8; 32],
    nonce: u64,
    is_bid: bool,
    tick: u32,
    seq: u32,
    base: [u8; 32],
    quote: [u8; 32],
) -> Vec<ClientKey> {
    vec![
        ClientKey::Market(market),
        ClientKey::Order(market, owner, nonce),
        ClientKey::Level(market, is_bid, tick),
        ClientKey::LevelPage(market, is_bid, tick, page(seq)),
        ClientKey::VaultBalance(base),
        ClientKey::VaultBalance(quote),
        ClientKey::UserBalance(base),
        ClientKey::UserBalance(quote),
    ]
}

/// Keys a `replace` touches: settle's keys for the old order plus the rest keys
/// at the new tick (own-side level, its word, summary, best; the opposite best
/// for the post-only check; append pages around the simulated tail).
#[allow(clippy::too_many_arguments)]
pub fn keys_for_replace(
    market: u32,
    owner: [u8; 32],
    nonce: u64,
    old_is_bid: bool,
    old_tick: u32,
    old_seq: u32,
    new_is_bid: bool,
    new_tick: u32,
    new_tail_seq: u32,
    base: [u8; 32],
    quote: [u8; 32],
) -> (Vec<ClientKey>, PageRange) {
    let mut keys = keys_for_settle(
        market, owner, nonce, old_is_bid, old_tick, old_seq, base, quote,
    );
    keys.push(ClientKey::Config);
    let append = append_range(new_tail_seq);
    keys.push(ClientKey::Level(market, new_is_bid, new_tick));
    keys.push(ClientKey::TickWord(market, new_is_bid, word_of(new_tick)));
    keys.push(ClientKey::TickSummary(market, new_is_bid));
    keys.push(ClientKey::BestTick(market, new_is_bid));
    keys.push(ClientKey::BestTick(market, !new_is_bid));
    push_pages(&mut keys, market, new_is_bid, new_tick, append);
    dedup(&mut keys);
    (keys, append)
}

/// The append window for a rest whose simulated tail is `tail_seq`:
/// `{page(tail_sim), +1}` with page 0 always implied (05 "Encoding decisions").
pub fn append_range(tail_seq: u32) -> PageRange {
    let p = page(tail_seq);
    PageRange {
        first: p,
        last: p.saturating_add(1),
    }
}

/// Keys for a place padded to `pad_end` (architecture §14). `pad_end` is on the
/// opposite side, at-or-worse than `start_tick` in the walk direction; the band
/// is `[start_tick, pad_end]` inclusive, every level key set or not.
pub fn pad(q: &Quoted, pad_end: u32) -> PadOut {
    let opp = !q.own_side;
    let m = q.market;
    let mut keys = Vec::new();

    keys.push(ClientKey::Config);
    keys.push(ClientKey::Market(m));

    // Opposite side: the band, every Level key set or not.
    let (lo, hi) = if q.start_tick <= pad_end {
        (q.start_tick, pad_end)
    } else {
        (pad_end, q.start_tick)
    };
    let mut t = lo;
    loop {
        keys.push(ClientKey::Level(m, opp, t));
        if t == hi {
            break;
        }
        t += 1;
    }
    // Every word the bounded scan may read: start's word through limit's word,
    // plus the band's words.
    let (wlo, whi) = word_span(&[q.start_tick, q.limit_tick, pad_end]);
    for w in wlo..=whi {
        keys.push(ClientKey::TickWord(m, opp, w));
    }
    keys.push(ClientKey::TickSummary(m, opp));
    keys.push(ClientKey::BestTick(m, opp));

    // Consume windows for every set level in the band: pages around the
    // simulated head (a concurrent take can move the head into pages).
    let mut consume = Vec::new();
    for c in &q.crossed {
        let p = page(c.head_seq);
        let range = PageRange {
            first: p,
            last: p.saturating_add(CONSUME_WIDTH),
        };
        push_pages(&mut keys, m, opp, c.tick, range);
        consume.push((c.tick, range));
    }

    // Own side, for the possible rest.
    keys.push(ClientKey::Level(m, q.own_side, q.limit_tick));
    keys.push(ClientKey::TickWord(m, q.own_side, word_of(q.limit_tick)));
    keys.push(ClientKey::TickSummary(m, q.own_side));
    keys.push(ClientKey::BestTick(m, q.own_side));
    keys.push(ClientKey::Order(m, q.taker, q.nonce));
    let append = append_range(q.tail_seq);
    push_pages(&mut keys, m, q.own_side, q.limit_tick, append);

    // Both fee accruals and both vault balances (§14: exhaustive list).
    keys.push(ClientKey::FeeAccrual(m, q.base));
    keys.push(ClientKey::FeeAccrual(m, q.quote));
    keys.push(ClientKey::VaultBalance(q.base));
    keys.push(ClientKey::VaultBalance(q.quote));
    keys.push(ClientKey::UserBalance(q.base));
    keys.push(ClientKey::UserBalance(q.quote));

    dedup(&mut keys);
    PadOut {
        keys,
        window: WindowSpec { consume, append },
    }
}

/// The keys the simulated execution touched (as opposed to padded-only keys):
/// mark for P23 restore exactly those of them RPC reports archived (§14
/// "Archived keys in the pad"). `archived` is the RPC answer for `out.keys`.
pub fn restore_marks(q: &Quoted, out: &PadOut, archived: &[ClientKey]) -> Vec<ClientKey> {
    let m = q.market;
    let opp = !q.own_side;
    let mut touched = vec![
        ClientKey::Config,
        ClientKey::Market(m),
        ClientKey::TickSummary(m, opp),
        ClientKey::BestTick(m, opp),
        ClientKey::Level(m, q.own_side, q.limit_tick),
        ClientKey::TickWord(m, q.own_side, word_of(q.limit_tick)),
        ClientKey::TickSummary(m, q.own_side),
        ClientKey::BestTick(m, q.own_side),
        ClientKey::Order(m, q.taker, q.nonce),
        ClientKey::LevelPage(m, q.own_side, q.limit_tick, page(q.tail_seq)),
        ClientKey::LevelPage(
            m,
            q.own_side,
            q.limit_tick,
            page(q.tail_seq).saturating_add(1),
        ),
        ClientKey::FeeAccrual(m, q.base),
        ClientKey::FeeAccrual(m, q.quote),
    ];
    for c in &q.crossed {
        touched.push(ClientKey::Level(m, opp, c.tick));
        // consumption may run from the head's page into the next declared one
        let p = page(c.head_seq);
        touched.push(ClientKey::LevelPage(m, opp, c.tick, p));
        touched.push(ClientKey::LevelPage(
            m,
            opp,
            c.tick,
            p.saturating_add(CONSUME_WIDTH),
        ));
    }
    if q.crossed.is_empty() {
        touched.push(ClientKey::Level(m, opp, q.start_tick));
    }
    let (wlo, whi) = word_span(&[q.start_tick, q.limit_tick]);
    for w in wlo..=whi {
        touched.push(ClientKey::TickWord(m, opp, w));
    }
    archived
        .iter()
        .filter(|k| out.keys.contains(k) && touched.contains(k))
        .cloned()
        .collect()
}

fn word_span(ticks: &[u32]) -> (u32, u32) {
    let mut lo = u32::MAX;
    let mut hi = 0;
    for t in ticks {
        lo = lo.min(word_of(*t));
        hi = hi.max(word_of(*t));
    }
    (lo, hi)
}

fn push_pages(keys: &mut Vec<ClientKey>, market: u32, is_bid: bool, tick: u32, r: PageRange) {
    for p in r.first..=r.last {
        keys.push(ClientKey::LevelPage(market, is_bid, tick, p));
    }
    // page 0 is always implied by the contract's window rule
    keys.push(ClientKey::LevelPage(market, is_bid, tick, 0));
}

fn dedup(keys: &mut Vec<ClientKey>) {
    let mut seen: Vec<ClientKey> = Vec::with_capacity(keys.len());
    keys.retain(|k| {
        if seen.contains(k) {
            false
        } else {
            seen.push(k.clone());
            true
        }
    });
}

/// Nonce policy (05 open question 7): a per-owner counter. The contract only
/// requires "not currently live for this owner".
pub struct NonceAlloc {
    next: u64,
}

impl NonceAlloc {
    pub fn new() -> Self {
        Self { next: 1 }
    }

    pub fn take(&mut self) -> u64 {
        let n = self.next;
        self.next = self.next.saturating_add(1);
        n
    }
}

impl Default for NonceAlloc {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quoted() -> Quoted {
        Quoted {
            market: 0,
            own_side: true,
            limit_tick: 20,
            start_tick: 10,
            crossed: vec![CrossedLevel {
                tick: 10,
                head_seq: 3,
                open_lots: 5,
            }],
            tail_seq: 0,
            taker: [1; 32],
            nonce: 7,
            base: [2; 32],
            quote: [3; 32],
        }
    }

    #[test]
    fn pad_declares_the_exhaustive_list() {
        let q = quoted();
        let out = pad(&q, 25);
        let has = |k: ClientKey| out.keys.contains(&k);
        for t in 10..=25 {
            assert!(has(ClientKey::Level(0, false, t)), "band level {t}");
        }
        assert!(has(ClientKey::TickWord(0, false, 0)));
        assert!(has(ClientKey::TickSummary(0, false)));
        assert!(has(ClientKey::BestTick(0, false)));
        assert!(has(ClientKey::LevelPage(0, false, 10, 0)));
        assert!(has(ClientKey::LevelPage(0, false, 10, 1)));
        assert!(has(ClientKey::Level(0, true, 20)));
        assert!(has(ClientKey::TickWord(0, true, 0)));
        assert!(has(ClientKey::TickSummary(0, true)));
        assert!(has(ClientKey::BestTick(0, true)));
        assert!(has(ClientKey::Order(0, [1; 32], 7)));
        assert!(has(ClientKey::LevelPage(0, true, 20, 0)));
        assert!(has(ClientKey::LevelPage(0, true, 20, 1)));
        assert!(has(ClientKey::FeeAccrual(0, [2; 32])));
        assert!(has(ClientKey::FeeAccrual(0, [3; 32])));
        assert!(has(ClientKey::VaultBalance([2; 32])));
        assert!(has(ClientKey::VaultBalance([3; 32])));
        assert!(has(ClientKey::UserBalance([2; 32])));
        assert!(has(ClientKey::UserBalance([3; 32])));
        assert!(has(ClientKey::Config));
        assert!(has(ClientKey::Market(0)));
        assert_eq!(
            out.window.consume,
            vec![(10, PageRange { first: 0, last: 1 })]
        );
        assert_eq!(out.window.append, PageRange { first: 0, last: 1 });
        let mut copy = out.keys.clone();
        dedup(&mut copy);
        assert_eq!(copy.len(), out.keys.len());
    }

    #[test]
    fn restore_marks_only_touched_archived_keys() {
        let q = quoted();
        let out = pad(&q, 25);
        let archived = vec![
            ClientKey::Level(0, false, 10),
            ClientKey::Level(0, false, 24),
            ClientKey::Level(0, true, 20),
        ];
        let marks = restore_marks(&q, &out, &archived);
        assert_eq!(
            marks,
            vec![
                ClientKey::Level(0, false, 10),
                ClientKey::Level(0, true, 20)
            ]
        );
    }

    #[test]
    fn settle_keys_use_the_seq_page() {
        let keys = keys_for_settle(3, [7; 32], 9, true, 4, 40, [1; 32], [2; 32]);
        assert!(keys.contains(&ClientKey::Order(3, [7; 32], 9)));
        assert!(keys.contains(&ClientKey::LevelPage(3, true, 4, page(40))));
        assert_eq!(page(40), 0);
        let keys = keys_for_settle(3, [7; 32], 9, true, 4, 70, [1; 32], [2; 32]);
        assert!(keys.contains(&ClientKey::LevelPage(3, true, 4, 1)));
    }

    #[test]
    fn append_range_pages() {
        assert_eq!(append_range(0), PageRange { first: 0, last: 1 });
        assert_eq!(append_range(31), PageRange { first: 0, last: 1 });
        assert_eq!(append_range(32), PageRange { first: 0, last: 1 });
        assert_eq!(append_range(64), PageRange { first: 1, last: 2 });
    }

    #[test]
    fn nonce_increments() {
        let mut n = NonceAlloc::new();
        assert_eq!(n.take(), 1);
        assert_eq!(n.take(), 2);
    }
}
