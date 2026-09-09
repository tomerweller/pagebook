//! PageBook client helper (05 M5): key computation and the padding protocol of
//! architecture §14. Pure functions over the contract's `quote_place` output;
//! the SDK that wraps this resolves `ClientKey`s to ledger keys, adds archived
//! flags from RPC (`getLedgerEntries`), and LAYERS the result on the
//! simulation footprint: `pad()` names the PageBook and balance entries the
//! book can move between simulation and inclusion; the simulation footprint
//! already carries the fixed entries (PageBook and SAC instances/code).
//!
//! A level's queue is one `Level` entry (ADR-037), so a pad is a list of keys
//! and nothing else: the opposite side's `Level` at every tick of the band
//! `[start_tick, pad_end]`, the tick words the bounded scan may read, both
//! sides' summaries and bests, the taker's own rest level and order, both fee
//! accruals and both tokens' vault and user balances.

use pagebook_types::{word_of, MarketId};

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

/// Access a trading call declares for a `ClientKey`. `Config` and `Market` are
/// read-only; every other variant can be written after a race.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Access {
    ReadOnly,
    ReadWrite,
}

pub fn access_of(k: &ClientKey) -> Access {
    match k {
        ClientKey::Config | ClientKey::Market(_) => Access::ReadOnly,
        ClientKey::Level(_, _, _)
        | ClientKey::Order(_, _, _)
        | ClientKey::FeeAccrual(_, _)
        | ClientKey::BestTick(_, _)
        | ClientKey::TickSummary(_, _)
        | ClientKey::TickWord(_, _, _)
        | ClientKey::VaultBalance(_)
        | ClientKey::UserBalance(_) => Access::ReadWrite,
    }
}

/// One level the simulated walk visited (mirror of the contract's `CrossedLevel`).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CrossedLevel {
    pub tick: u32,
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
    pub taker: [u8; 32],
    pub nonce: u64,
    pub base: [u8; 32],
    pub quote: [u8; 32],
}

/// The padded declaration for one place (architecture §14).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PadOut {
    /// Keys to declare. `access_of` splits them: `Config` and `Market` are
    /// read-only; every other key is read-write. Superset of what the contract
    /// touches for any book state reachable between simulation and inclusion
    /// inside the band `[start_tick, pad_end]`.
    pub keys: Vec<ClientKey>,
}

/// Keys a `settle` touches: the market, the order, its level, the vault and
/// user balances of both tokens (payout + refund).
pub fn keys_for_settle(
    market: u32,
    owner: [u8; 32],
    nonce: u64,
    is_bid: bool,
    tick: u32,
    base: [u8; 32],
    quote: [u8; 32],
) -> Vec<ClientKey> {
    vec![
        ClientKey::Market(market),
        ClientKey::Order(market, owner, nonce),
        ClientKey::Level(market, is_bid, tick),
        ClientKey::VaultBalance(base),
        ClientKey::VaultBalance(quote),
        ClientKey::UserBalance(base),
        ClientKey::UserBalance(quote),
    ]
}

/// Keys a `replace` touches: settle's keys for the old order plus the rest keys
/// at the new tick (own-side level, its word, summary, best; the opposite best
/// for the post-only check) and `Config`.
#[allow(clippy::too_many_arguments)]
pub fn keys_for_replace(
    market: u32,
    owner: [u8; 32],
    nonce: u64,
    old_is_bid: bool,
    old_tick: u32,
    new_is_bid: bool,
    new_tick: u32,
    base: [u8; 32],
    quote: [u8; 32],
) -> Vec<ClientKey> {
    let mut keys = keys_for_settle(market, owner, nonce, old_is_bid, old_tick, base, quote);
    keys.push(ClientKey::Config);
    keys.push(ClientKey::Level(market, new_is_bid, new_tick));
    keys.push(ClientKey::TickWord(market, new_is_bid, word_of(new_tick)));
    keys.push(ClientKey::TickSummary(market, new_is_bid));
    keys.push(ClientKey::BestTick(market, new_is_bid));
    keys.push(ClientKey::BestTick(market, !new_is_bid));
    dedup(&mut keys);
    keys
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
    for t in lo..=hi {
        keys.push(ClientKey::Level(m, opp, t));
    }
    // Every word the bounded scan may read: start's word through limit's word,
    // plus the band's words.
    let (wlo, whi) = word_span(&[q.start_tick, q.limit_tick, pad_end]);
    for w in wlo..=whi {
        keys.push(ClientKey::TickWord(m, opp, w));
    }
    keys.push(ClientKey::TickSummary(m, opp));
    keys.push(ClientKey::BestTick(m, opp));

    // Own side, for the possible rest.
    keys.push(ClientKey::Level(m, q.own_side, q.limit_tick));
    keys.push(ClientKey::TickWord(m, q.own_side, word_of(q.limit_tick)));
    keys.push(ClientKey::TickSummary(m, q.own_side));
    keys.push(ClientKey::BestTick(m, q.own_side));
    keys.push(ClientKey::Order(m, q.taker, q.nonce));

    // Both fee accruals, both vault balances, both user balances (§14:
    // exhaustive list).
    keys.push(ClientKey::FeeAccrual(m, q.base));
    keys.push(ClientKey::FeeAccrual(m, q.quote));
    keys.push(ClientKey::VaultBalance(q.base));
    keys.push(ClientKey::VaultBalance(q.quote));
    keys.push(ClientKey::UserBalance(q.base));
    keys.push(ClientKey::UserBalance(q.quote));

    dedup(&mut keys);
    PadOut { keys }
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
        ClientKey::FeeAccrual(m, q.base),
        ClientKey::FeeAccrual(m, q.quote),
    ];
    for c in &q.crossed {
        touched.push(ClientKey::Level(m, opp, c.tick));
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

/// Stable string form shared with the TypeScript client (`keyStr`) and the
/// pad-conformance fixture.
pub fn key_str(k: &ClientKey) -> String {
    match k {
        ClientKey::Config => "Config".into(),
        ClientKey::Market(m) => format!("Market({m})"),
        ClientKey::Level(m, bid, t) => format!("Level({m},{bid},{t})"),
        ClientKey::Order(m, owner, n) => format!("Order({m},{},{n})", hex32(owner)),
        ClientKey::FeeAccrual(m, tok) => format!("FeeAccrual({m},{})", hex32(tok)),
        ClientKey::BestTick(m, bid) => format!("BestTick({m},{bid})"),
        ClientKey::TickSummary(m, bid) => format!("TickSummary({m},{bid})"),
        ClientKey::TickWord(m, bid, w) => format!("TickWord({m},{bid},{w})"),
        ClientKey::VaultBalance(tok) => format!("VaultBalance({})", hex32(tok)),
        ClientKey::UserBalance(tok) => format!("UserBalance({})", hex32(tok)),
    }
}

/// Sorted `key_str` list, the fixture comparison form.
pub fn sorted_key_strs(keys: &[ClientKey]) -> Vec<String> {
    let mut s: Vec<String> = keys.iter().map(key_str).collect();
    s.sort();
    s
}

fn hex32(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
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
                open_lots: 5,
            }],
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
        assert!(has(ClientKey::Level(0, true, 20)));
        assert!(has(ClientKey::TickWord(0, true, 0)));
        assert!(has(ClientKey::TickSummary(0, true)));
        assert!(has(ClientKey::BestTick(0, true)));
        assert!(has(ClientKey::Order(0, [1; 32], 7)));
        assert!(has(ClientKey::FeeAccrual(0, [2; 32])));
        assert!(has(ClientKey::FeeAccrual(0, [3; 32])));
        assert!(has(ClientKey::VaultBalance([2; 32])));
        assert!(has(ClientKey::VaultBalance([3; 32])));
        assert!(has(ClientKey::UserBalance([2; 32])));
        assert!(has(ClientKey::UserBalance([3; 32])));
        assert!(has(ClientKey::Config));
        assert!(has(ClientKey::Market(0)));
        // 16 band levels + word/summary/best on the opposite side + 5 own-side
        // keys + 2 fees + 4 balances + Config + Market: nothing else.
        assert_eq!(out.keys.len(), 16 + 3 + 5 + 2 + 4 + 2);
        let mut copy = out.keys.clone();
        dedup(&mut copy);
        assert_eq!(copy.len(), out.keys.len());
    }

    #[test]
    fn pad_band_runs_downward_on_the_ask_side() {
        let mut q = quoted();
        q.own_side = false;
        q.start_tick = 50;
        q.limit_tick = 40;
        q.crossed = vec![CrossedLevel {
            tick: 50,
            open_lots: 2,
        }];
        let out = pad(&q, 45);
        for t in 45..=50 {
            assert!(
                out.keys.contains(&ClientKey::Level(0, true, t)),
                "band level {t}"
            );
        }
        assert!(!out.keys.contains(&ClientKey::Level(0, true, 44)));
        assert!(!out.keys.contains(&ClientKey::Level(0, true, 51)));
        assert!(out.keys.contains(&ClientKey::Level(0, false, 40)));
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
    fn settle_keys_are_the_order_its_level_and_the_balances() {
        let keys = keys_for_settle(3, [7; 32], 9, true, 4, [1; 32], [2; 32]);
        assert_eq!(
            keys,
            vec![
                ClientKey::Market(3),
                ClientKey::Order(3, [7; 32], 9),
                ClientKey::Level(3, true, 4),
                ClientKey::VaultBalance([1; 32]),
                ClientKey::VaultBalance([2; 32]),
                ClientKey::UserBalance([1; 32]),
                ClientKey::UserBalance([2; 32]),
            ]
        );
    }

    #[test]
    fn replace_same_tick_dedups_the_level() {
        let keys = keys_for_replace(0, [1; 32], 7, true, 20, true, 20, [2; 32], [3; 32]);
        assert_eq!(
            keys.iter()
                .filter(|k| **k == ClientKey::Level(0, true, 20))
                .count(),
            1
        );
        assert!(keys.contains(&ClientKey::Config));
        assert!(keys.contains(&ClientKey::TickWord(0, true, 0)));
        assert!(keys.contains(&ClientKey::TickSummary(0, true)));
        assert!(keys.contains(&ClientKey::BestTick(0, true)));
        assert!(keys.contains(&ClientKey::BestTick(0, false)));
    }

    #[test]
    fn nonce_increments() {
        let mut n = NonceAlloc::new();
        assert_eq!(n.take(), 1);
        assert_eq!(n.take(), 2);
    }

    fn sorted_keys(keys: &[ClientKey]) -> Vec<String> {
        sorted_key_strs(keys)
    }

    fn fixture_quoted() -> Quoted {
        Quoted {
            market: 0,
            own_side: true,
            limit_tick: 20,
            start_tick: 10,
            crossed: vec![
                CrossedLevel {
                    tick: 10,
                    open_lots: 5,
                },
                CrossedLevel {
                    tick: 11,
                    open_lots: 2,
                },
                CrossedLevel {
                    tick: 12,
                    open_lots: 1,
                },
            ],
            taker: [1; 32],
            nonce: 7,
            base: [2; 32],
            quote: [3; 32],
        }
    }

    const PLACE_3CROSS: &[&str] = &[
        "BestTick(0,false)",
        "BestTick(0,true)",
        "Config",
        "FeeAccrual(0,0202020202020202020202020202020202020202020202020202020202020202)",
        "FeeAccrual(0,0303030303030303030303030303030303030303030303030303030303030303)",
        "Level(0,false,10)",
        "Level(0,false,11)",
        "Level(0,false,12)",
        "Level(0,true,20)",
        "Market(0)",
        "Order(0,0101010101010101010101010101010101010101010101010101010101010101,7)",
        "TickSummary(0,false)",
        "TickSummary(0,true)",
        "TickWord(0,false,0)",
        "TickWord(0,true,0)",
        "UserBalance(0202020202020202020202020202020202020202020202020202020202020202)",
        "UserBalance(0303030303030303030303030303030303030303030303030303030303030303)",
        "VaultBalance(0202020202020202020202020202020202020202020202020202020202020202)",
        "VaultBalance(0303030303030303030303030303030303030303030303030303030303030303)",
    ];

    const SETTLE: &[&str] = &[
        "Level(0,true,20)",
        "Market(0)",
        "Order(0,0101010101010101010101010101010101010101010101010101010101010101,7)",
        "UserBalance(0202020202020202020202020202020202020202020202020202020202020202)",
        "UserBalance(0303030303030303030303030303030303030303030303030303030303030303)",
        "VaultBalance(0202020202020202020202020202020202020202020202020202020202020202)",
        "VaultBalance(0303030303030303030303030303030303030303030303030303030303030303)",
    ];

    const REPLACE_CROSS_SIDE: &[&str] = &[
        "BestTick(0,false)",
        "BestTick(0,true)",
        "Config",
        "Level(0,false,22)",
        "Level(0,true,20)",
        "Market(0)",
        "Order(0,0101010101010101010101010101010101010101010101010101010101010101,7)",
        "TickSummary(0,false)",
        "TickWord(0,false,0)",
        "UserBalance(0202020202020202020202020202020202020202020202020202020202020202)",
        "UserBalance(0303030303030303030303030303030303030303030303030303030303030303)",
        "VaultBalance(0202020202020202020202020202020202020202020202020202020202020202)",
        "VaultBalance(0303030303030303030303030303030303030303030303030303030303030303)",
    ];

    const RESTORE: &[&str] = &["Level(0,false,10)", "Level(0,false,11)", "Level(0,true,20)"];

    const PLACE_3CROSS_RO: &[&str] = &["Config", "Market(0)"];
    const SETTLE_RO: &[&str] = &["Market(0)"];
    const REPLACE_CROSS_SIDE_RO: &[&str] = &["Config", "Market(0)"];

    fn read_only_of(keys: &[ClientKey]) -> Vec<String> {
        sorted_keys(
            &keys
                .iter()
                .filter(|k| access_of(k) == Access::ReadOnly)
                .cloned()
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn access_of_every_variant() {
        assert_eq!(access_of(&ClientKey::Config), Access::ReadOnly);
        assert_eq!(access_of(&ClientKey::Market(0)), Access::ReadOnly);
        assert_eq!(access_of(&ClientKey::Level(0, true, 1)), Access::ReadWrite);
        assert_eq!(
            access_of(&ClientKey::Order(0, [1; 32], 7)),
            Access::ReadWrite
        );
        assert_eq!(
            access_of(&ClientKey::FeeAccrual(0, [2; 32])),
            Access::ReadWrite
        );
        assert_eq!(access_of(&ClientKey::BestTick(0, true)), Access::ReadWrite);
        assert_eq!(
            access_of(&ClientKey::TickSummary(0, false)),
            Access::ReadWrite
        );
        assert_eq!(
            access_of(&ClientKey::TickWord(0, true, 0)),
            Access::ReadWrite
        );
        assert_eq!(
            access_of(&ClientKey::VaultBalance([2; 32])),
            Access::ReadWrite
        );
        assert_eq!(
            access_of(&ClientKey::UserBalance([3; 32])),
            Access::ReadWrite
        );
    }

    #[test]
    fn js_fixtures() {
        let q = fixture_quoted();
        let out = pad(&q, 12);
        assert_eq!(sorted_keys(&out.keys), PLACE_3CROSS);
        assert_eq!(read_only_of(&out.keys), PLACE_3CROSS_RO);

        let settle = keys_for_settle(0, [1; 32], 7, true, 20, [2; 32], [3; 32]);
        assert_eq!(sorted_keys(&settle), SETTLE);
        assert_eq!(read_only_of(&settle), SETTLE_RO);

        let rep = keys_for_replace(0, [1; 32], 7, true, 20, false, 22, [2; 32], [3; 32]);
        assert_eq!(sorted_keys(&rep), REPLACE_CROSS_SIDE);
        assert_eq!(read_only_of(&rep), REPLACE_CROSS_SIDE_RO);

        let archived = vec![
            ClientKey::Level(0, false, 10),
            ClientKey::Level(0, false, 11),
            ClientKey::Level(0, false, 99),
            ClientKey::Level(0, true, 20),
        ];
        assert_eq!(sorted_keys(&restore_marks(&q, &out, &archived)), RESTORE);
    }
}
