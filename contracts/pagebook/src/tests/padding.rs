//! In-repo padding helper (05 M2) mirroring `crates/pagebook-client` `pad()`,
//! but producing contract `DataKey`s and a `SlotWindow`, plus the sim-to-apply
//! race suite: simulate with `quote_place`, declare, mutate the book, apply
//! with the stale `start_tick`/window, and assert both the defined outcome and
//! `keys_touched(place) ⊆ declared` (architecture §14/§15, invariant 6).

extern crate std;

use super::footprint::keys_touched;
use super::harness::{flags, mint, rest_ask, rest_bid, setup, window, Harness};
use crate::{ConsumeWindow, DataKey, Error, PageRange, PlaceFlags, QuoteResult, SlotWindow};
use pagebook_types::{page, word_of};
use soroban_sdk::{testutils::Address as _, Address};
use std::vec::Vec;

/// Width of the consume window past the simulated head page (§14: "small").
const CONSUME_WIDTH: u32 = 1;

fn push_pages(keys: &mut Vec<DataKey>, market: u32, is_bid: bool, tick: u32, r: PageRange) {
    for p in r.first..=r.last {
        keys.push(DataKey::LevelPage(market, is_bid, tick, p));
    }
    // page 0 is always implied by the contract's window rule
    keys.push(DataKey::LevelPage(market, is_bid, tick, 0));
}

fn append_range(tail_seq: u32) -> PageRange {
    let p = page(tail_seq);
    PageRange {
        first: p,
        last: p.saturating_add(1),
    }
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

fn dedup(keys: &mut Vec<DataKey>) {
    let mut seen: Vec<DataKey> = Vec::with_capacity(keys.len());
    keys.retain(|k| {
        if seen.contains(k) {
            false
        } else {
            seen.push(k.clone());
            true
        }
    });
}

/// The keys a client declares for a place padded to `pad_end`, and the
/// `SlotWindow` it passes (architecture §14). Band Levels `[start..=pad_end]`
/// on the opposite side (set or not), TickWords for the words spanning start,
/// limit and pad_end, TickSummary/BestTick both sides, own-side Level/TickWord
/// at `limit_tick`, `Order(taker, nonce)`, consume pages
/// `[page(head_seq), +1]` ∪ {0} per crossed level, append pages
/// `{page(tail_seq), +1, 0}`, both FeeAccruals, Market, Config.
pub fn declare_place(
    h: &Harness,
    q: &QuoteResult,
    taker: &Address,
    nonce: u64,
    is_bid: bool,
    limit_tick: u32,
    pad_end: u32,
) -> (Vec<DataKey>, SlotWindow) {
    let m = h.market;
    let opp = !is_bid;
    let mut keys = Vec::new();
    keys.push(DataKey::Config);
    keys.push(DataKey::Market(m));

    let (lo, hi) = if q.start_tick <= pad_end {
        (q.start_tick, pad_end)
    } else {
        (pad_end, q.start_tick)
    };
    for t in lo..=hi {
        keys.push(DataKey::Level(m, opp, t));
    }
    let (wlo, whi) = word_span(&[q.start_tick, limit_tick, pad_end]);
    for w in wlo..=whi {
        keys.push(DataKey::TickWord(m, opp, w));
    }
    keys.push(DataKey::TickSummary(m, opp));
    keys.push(DataKey::BestTick(m, opp));

    let mut consume = soroban_sdk::Vec::new(&h.env);
    for c in q.crossed.iter() {
        let p = page(c.head_seq);
        let range = PageRange {
            first: p,
            last: p.saturating_add(CONSUME_WIDTH),
        };
        push_pages(&mut keys, m, opp, c.tick, range.clone());
        consume.push_back(ConsumeWindow {
            tick: c.tick,
            pages: range,
        });
    }

    keys.push(DataKey::Level(m, is_bid, limit_tick));
    keys.push(DataKey::TickWord(m, is_bid, word_of(limit_tick)));
    keys.push(DataKey::TickSummary(m, is_bid));
    keys.push(DataKey::BestTick(m, is_bid));
    keys.push(DataKey::Order(m, taker.clone(), nonce));
    let append = append_range(q.tail_seq);
    push_pages(&mut keys, m, is_bid, limit_tick, append.clone());

    keys.push(DataKey::FeeAccrual(m, h.base.clone()));
    keys.push(DataKey::FeeAccrual(m, h.quote.clone()));

    dedup(&mut keys);
    (keys, SlotWindow { consume, append })
}

/// `touched \ declared`.
pub fn undeclared(touched: &[DataKey], declared: &[DataKey]) -> Vec<DataKey> {
    touched
        .iter()
        .filter(|k| !declared.contains(k))
        .cloned()
        .collect()
}

fn assert_subset(touched: &[DataKey], declared: &[DataKey]) {
    let extra = undeclared(touched, declared);
    assert!(
        extra.is_empty(),
        "place touched keys outside the declared set: {extra:?}"
    );
}

fn no_rest() -> PlaceFlags {
    PlaceFlags {
        post_only: false,
        fill_or_kill: false,
        no_rest: true,
    }
}

/// Simulate a bid at `limit` for `qty`, declare padded to `pad_end`.
fn sim_bid(
    h: &Harness,
    taker: &Address,
    nonce: u64,
    limit: u32,
    qty: u64,
    pad_end: u32,
) -> (QuoteResult, Vec<DataKey>, SlotWindow) {
    let q = h.client().quote_place(&h.market, &true, &limit, &qty);
    let (keys, win) = declare_place(h, &q, taker, nonce, true, limit, pad_end);
    (q, keys, win)
}

#[test]
fn simulated_footprint_declares_own_side_rest_keys() {
    // ADR-012 H1: a resting place's simulated footprint contains its own-side
    // Level, TickWord, TickSummary and BestTick keys.
    let h = setup();
    let taker = Address::generate(&h.env);
    let (q, keys, _) = sim_bid(&h, &taker, 1, 40, 5, 40);
    let m = h.market;
    for k in [
        DataKey::Level(m, true, 40),
        DataKey::TickWord(m, true, 0),
        DataKey::TickSummary(m, true),
        DataKey::BestTick(m, true),
    ] {
        assert!(q.keys.contains(&k), "quote_place keys lack {k:?}");
        assert!(keys.contains(&k), "declared keys lack {k:?}");
    }
    // Empty opposite side: start_tick = limit_tick; the walk checks the bit at
    // 40, reads no Level (nothing to read on an empty side), and quote_place
    // still names Level(asks, 40) as the one-key band.
    assert_eq!(q.start_tick, 40);
    assert_eq!(q.crossed.len(), 0);
    assert!(q.keys.contains(DataKey::Level(m, false, 40)));
}

#[test]
fn race_better_priced_rest_is_never_visited() {
    // Sim against ask 20; an ask lands at 15 (better than start_tick). The walk
    // never visits it (inv. 5), the remainder is refunded because the recorded
    // best still crosses (inv. 8), BestTick(asks) is untouched, and every key
    // read is inside the declaration.
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 20, 1, 1);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let (q, declared, win) = sim_bid(&h, &taker, 9, 30, 5, 30);
    assert_eq!(q.start_tick, 20);
    rest_ask(&h, &maker, 15, 1, 2);
    let mut out = (false, 0u64, 0i128);
    let touched = keys_touched(&h, || {
        out = h.client().place(
            &taker,
            &h.market,
            &true,
            &30,
            &5,
            &q.start_tick,
            &9,
            &win,
            &flags(),
        );
    });
    assert_eq!(out.1, 1);
    assert!(!out.0, "remainder refunded: ask 15 still crosses");
    assert_eq!(h.client().best(&h.market, &false), Some(15));
    assert_eq!(h.client().level(&h.market, &false, &15).open_lots, 1);
    assert!(!touched.contains(&DataKey::Level(h.market, false, 15)));
    assert_subset(&touched, &declared);
}

#[test]
fn race_new_level_inside_band_is_taken() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 20, 2, 1);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let (q, declared, win) = sim_bid(&h, &taker, 9, 30, 5, 30);
    assert_eq!(q.crossed.len(), 1);
    // A level appears at 25, inside the band [20, 30].
    rest_ask(&h, &maker, 25, 2, 2);
    let mut out = (false, 0u64, 0i128);
    let touched = keys_touched(&h, || {
        out = h.client().place(
            &taker,
            &h.market,
            &true,
            &30,
            &5,
            &q.start_tick,
            &9,
            &win,
            &flags(),
        );
    });
    assert_eq!(out.1, 4, "sweeps 20 and the new level at 25");
    assert!(out.0, "remainder rests at 30");
    assert_eq!(h.client().best(&h.market, &false), None);
    assert_eq!(h.client().best(&h.market, &true), Some(30));
    assert!(touched.contains(&DataKey::Level(h.market, false, 25)));
    assert_subset(&touched, &declared);
}

#[test]
fn race_level_emptied_by_settle_is_lazily_cleared() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 20, 2, 1);
    rest_ask(&h, &maker, 25, 2, 2);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let (q, declared, win) = sim_bid(&h, &taker, 9, 30, 3, 30);
    assert_eq!(q.crossed.len(), 2);
    // The level at start_tick empties: stale bit, stale BestTick.
    h.client().settle(&maker, &h.market, &1);
    assert_eq!(h.client().best(&h.market, &false), Some(20));
    let mut out = (false, 0u64, 0i128);
    let touched = keys_touched(&h, || {
        out = h.client().place(
            &taker,
            &h.market,
            &true,
            &30,
            &3,
            &q.start_tick,
            &9,
            &win,
            &flags(),
        );
    });
    assert_eq!(out.1, 2, "the stale level is skipped, 25 is swept");
    assert!(out.0, "remainder rests at 30");
    assert_eq!(h.client().best(&h.market, &false), None);
    assert!(
        !touched.iter().any(|k| matches!(k, DataKey::LevelPage(..))),
        "a sweep-only walk reads no pages"
    );
    assert_subset(&touched, &declared);
}

#[test]
fn race_head_advanced_into_page_zero_by_another_taker() {
    let h = setup();
    let maker = Address::generate(&h.env);
    for n in 1..=40u64 {
        rest_ask(&h, &maker, 20, 1, n);
    }
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let (q, declared, win) = sim_bid(&h, &taker, 9, 20, 3, 20);
    assert_eq!(q.crossed.get(0).unwrap().head_seq, 0);
    assert_eq!(
        win.consume.get(0).unwrap().pages,
        PageRange { first: 0, last: 1 }
    );
    // Another taker consumes 35 slots: the head is now inside page 0.
    let other = Address::generate(&h.env);
    mint(&h, &h.quote, &other, 1_000_000);
    h.client().place(
        &other,
        &h.market,
        &true,
        &20,
        &35,
        &20,
        &1,
        &win,
        &no_rest(),
    );
    assert_eq!(h.client().level(&h.market, &false, &20).head_seq, 35);
    let mut out = (false, 0u64, 0i128);
    let touched = keys_touched(&h, || {
        out = h.client().place(
            &taker,
            &h.market,
            &true,
            &20,
            &3,
            &q.start_tick,
            &9,
            &win,
            &no_rest(),
        );
    });
    assert_eq!(out.1, 3, "partial consumption continues inside page 0");
    assert!(touched.contains(&DataKey::LevelPage(h.market, false, 20, 0)));
    assert_subset(&touched, &declared);
    let lvl = h.client().level(&h.market, &false, &20);
    assert_eq!(lvl.head_seq, 38);
    assert_eq!(lvl.open_lots, 2);
}

fn rest_bid_paged(h: &Harness, maker: &Address, tick: u32, nonce: u64, append_last: u32) {
    mint(h, &h.quote, maker, 1_000_000);
    let win = SlotWindow {
        consume: soroban_sdk::Vec::new(&h.env),
        append: PageRange {
            first: 0,
            last: append_last,
        },
    };
    h.client().place(
        maker,
        &h.market,
        &true,
        &tick,
        &1,
        &tick,
        &nonce,
        &win,
        &flags(),
    );
}

#[test]
fn race_tail_pushed_past_append_window_is_retry_rest() {
    // With max_pages = 3 the level cap is 128; the append window declared at
    // simulation (tail 0 → pages {0, 1}) covers 96 concurrent same-level rests.
    // The 97th slot lands in page 2: outside the window → RetryRest, and the
    // failed place still touched only declared keys.
    let h = setup();
    h.client()
        .set_market_caps(&h.market, &32, &64, &10, &1, &1_000_000, &3);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let (q, declared, win) = sim_bid(&h, &taker, 9, 30, 1, 30);
    assert_eq!(q.tail_seq, 0);
    assert_eq!(win.append, PageRange { first: 0, last: 1 });
    let crowd = Address::generate(&h.env);
    for n in 1..=96u64 {
        rest_bid_paged(&h, &crowd, 30, n, 3);
    }
    assert_eq!(h.client().level(&h.market, &true, &30).tail_seq, 96);
    let touched = keys_touched(&h, || {
        super::assert_err(
            h.client().try_place(
                &taker,
                &h.market,
                &true,
                &30,
                &1,
                &q.start_tick,
                &9,
                &win,
                &flags(),
            ),
            Error::RetryRest,
        );
    });
    assert_subset(&touched, &declared);
    // Inside the window (tail at 95) the same rest lands in page 1.
    let h = setup();
    h.client()
        .set_market_caps(&h.market, &32, &64, &10, &1, &1_000_000, &3);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let (q, declared, win) = sim_bid(&h, &taker, 9, 30, 1, 30);
    let crowd = Address::generate(&h.env);
    for n in 1..=95u64 {
        rest_bid_paged(&h, &crowd, 30, n, 3);
    }
    let touched = keys_touched(&h, || {
        let (rested, _, _) = h.client().place(
            &taker,
            &h.market,
            &true,
            &30,
            &1,
            &q.start_tick,
            &9,
            &win,
            &flags(),
        );
        assert!(rested);
    });
    assert_eq!(h.client().order(&h.market, &taker, &9).seq, 95);
    assert!(touched.contains(&DataKey::LevelPage(h.market, true, 30, 1)));
    assert_subset(&touched, &declared);
}

#[test]
fn race_tail_pushed_to_level_cap_is_level_full() {
    // max_pages = 1: LEVEL_CAP = 64. 64 concurrent rests fill the level; the
    // stale place fails LevelFull (not RetryRest) inside its declaration.
    let h = setup();
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let (q, declared, win) = sim_bid(&h, &taker, 9, 30, 1, 30);
    let crowd = Address::generate(&h.env);
    for n in 1..=64u64 {
        rest_bid(&h, &crowd, 30, 1, n);
    }
    let touched = keys_touched(&h, || {
        super::assert_err(
            h.client().try_place(
                &taker,
                &h.market,
                &true,
                &30,
                &1,
                &q.start_tick,
                &9,
                &win,
                &flags(),
            ),
            Error::LevelFull,
        );
    });
    assert_subset(&touched, &declared);
}

#[test]
fn race_generation_bumped_by_sweep_between_sim_and_apply() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 20, 5, 1);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let (q, declared, win) = sim_bid(&h, &taker, 9, 20, 2, 20);
    let gen_before = h.client().level(&h.market, &false, &20).generation;
    // Another taker sweeps the level (generation bump), then a fresh rest.
    let other = Address::generate(&h.env);
    mint(&h, &h.quote, &other, 1_000_000);
    h.client()
        .place(&other, &h.market, &true, &20, &5, &20, &1, &win, &no_rest());
    rest_ask(&h, &maker, 20, 3, 2);
    let lvl = h.client().level(&h.market, &false, &20);
    assert_eq!(lvl.generation, gen_before + 1);
    let mut out = (false, 0u64, 0i128);
    let touched = keys_touched(&h, || {
        out = h.client().place(
            &taker,
            &h.market,
            &true,
            &20,
            &2,
            &q.start_tick,
            &9,
            &win,
            &no_rest(),
        );
    });
    assert_eq!(out.1, 2, "takes from the new generation");
    assert_eq!(h.client().level(&h.market, &false, &20).open_lots, 1);
    assert_subset(&touched, &declared);
    // The swept order (old generation) still settles as fully filled.
    let (paid, refunded) = h.client().settle(&maker, &h.market, &1);
    assert_eq!(paid, 100);
    assert_eq!(refunded, 0);
}

#[test]
fn negative_walk_past_pad_end_touches_undeclared_level() {
    // asks 1@20 and 1@40; bid limit 50 for 5, under-padded to pad_end = 30:
    // the walk sweeps 20, then reads Level(40) — the only key outside the
    // declaration (the trap of §14/§15).
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 20, 1, 1);
    rest_ask(&h, &maker, 40, 1, 2);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let (q, declared, win) = sim_bid(&h, &taker, 9, 50, 5, 30);
    let (_, declared_40, _) = sim_bid(&h, &taker, 9, 50, 5, 40);
    let touched = keys_touched(&h, || {
        h.client().place(
            &taker,
            &h.market,
            &true,
            &50,
            &5,
            &q.start_tick,
            &9,
            &win,
            &flags(),
        );
    });
    let extra = undeclared(&touched, &declared);
    assert_eq!(extra, std::vec![DataKey::Level(h.market, false, 40)]);
    // Padded to 40 the same place is fully declared.
    assert!(undeclared(&touched, &declared_40).is_empty());
}

#[test]
fn race_frontier_written_in_flight_stays_inside_declared_keys() {
    // Multi-word band. Asks 1@2040 (word 0) and 1@3000 (word 1). Taker B sims a
    // bid limit 3500 qty 3 (start 2040, crossed 2040 and 3000). In flight taker A
    // sweeps 2040 with limit 2040: the bounded scan finds nothing else in word 0
    // and BestTick(asks) moves to the frontier of the next summary-set word
    // (2048), a bit-less tick. B applies with its stale start_tick 2040: the
    // walk must not read Level(asks, 2048) — it checks the bit in word 1
    // (declared) and scans on to 3000. touched ⊆ declared, fill 1 @ 3000.
    let mut h = setup();
    h.market = h
        .client()
        .create_market(&h.base, &h.quote, &1, &1, &1, &10_000, &10, &1, &1_000_000);
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 2040, 1, 1);
    rest_ask(&h, &maker, 3000, 1, 2);
    let b = Address::generate(&h.env);
    mint(&h, &h.quote, &b, 10_000_000);
    let (q, declared, win) = sim_bid(&h, &b, 7, 3500, 3, 3000);
    assert_eq!(q.start_tick, 2040);
    assert_eq!(q.crossed.len(), 2);

    let a = Address::generate(&h.env);
    mint(&h, &h.quote, &a, 10_000_000);
    h.client().place(
        &a,
        &h.market,
        &true,
        &2040,
        &1,
        &2040,
        &1,
        &window(&h),
        &no_rest(),
    );
    assert_eq!(
        h.client().best(&h.market, &false),
        Some(2048),
        "frontier of word 1"
    );

    let touched = keys_touched(&h, || {
        let (rested, filled, _) = h.client().place(
            &b,
            &h.market,
            &true,
            &3500,
            &3,
            &q.start_tick,
            &7,
            &win,
            &flags(),
        );
        assert_eq!(filled, 1);
        assert!(rested, "2 lots rest at 3500");
    });
    assert!(
        !touched.contains(&DataKey::Level(h.market, false, 2048)),
        "no Level read at the frontier"
    );
    let extra = undeclared(&touched, &declared);
    assert!(extra.is_empty(), "undeclared keys touched: {extra:?}");
}

/// The shipped client `pad()` and the in-repo `declare_place` must declare the
/// same PageBook keys (05 M5: the client wraps the M2 helper). Compared by
/// shape (variant + numeric fields; addresses are opaque on the client side).
#[test]
fn client_pad_matches_in_repo_declare_place() {
    use pagebook_client::{pad, ClientKey, CrossedLevel as CCross, Quoted};
    let h = setup();
    let maker = Address::generate(&h.env);
    for n in 1..=34u64 {
        rest_ask(&h, &maker, 20, 1, n); // head will sit in page 0 after 33 takes
    }
    rest_ask(&h, &maker, 23, 2, 40);
    let t = Address::generate(&h.env);
    mint(&h, &h.quote, &t, 1_000_000);
    h.client().place(
        &t,
        &h.market,
        &true,
        &20,
        &33,
        &20,
        &1,
        &window(&h),
        &no_rest(),
    );
    let taker = Address::generate(&h.env);
    let (q, declared, win) = sim_bid(&h, &taker, 9, 25, 5, 27);

    let cq = Quoted {
        market: h.market,
        own_side: true,
        limit_tick: 25,
        start_tick: q.start_tick,
        crossed: q
            .crossed
            .iter()
            .map(|c| CCross {
                tick: c.tick,
                head_seq: c.head_seq,
                open_lots: c.open_lots,
            })
            .collect(),
        tail_seq: q.tail_seq,
        taker: [1; 32],
        nonce: 9,
        base: [2; 32],
        quote: [3; 32],
    };
    let out = pad(&cq, 27);

    fn shape_d(k: &DataKey) -> std::string::String {
        match k {
            DataKey::Config => "Config".into(),
            DataKey::Market(m) => std::format!("Market({m})"),
            DataKey::Level(m, s, t) => std::format!("Level({m},{s},{t})"),
            DataKey::LevelPage(m, s, t, p) => std::format!("LevelPage({m},{s},{t},{p})"),
            DataKey::Order(m, _, n) => std::format!("Order({m},_,{n})"),
            DataKey::FeeAccrual(m, _) => std::format!("FeeAccrual({m},_)"),
            DataKey::BestTick(m, s) => std::format!("BestTick({m},{s})"),
            DataKey::TickSummary(m, s) => std::format!("TickSummary({m},{s})"),
            DataKey::TickWord(m, s, w) => std::format!("TickWord({m},{s},{w})"),
        }
    }
    fn shape_c(k: &ClientKey) -> Option<std::string::String> {
        Some(match k {
            ClientKey::Config => "Config".into(),
            ClientKey::Market(m) => std::format!("Market({m})"),
            ClientKey::Level(m, s, t) => std::format!("Level({m},{s},{t})"),
            ClientKey::LevelPage(m, s, t, p) => std::format!("LevelPage({m},{s},{t},{p})"),
            ClientKey::Order(m, _, n) => std::format!("Order({m},_,{n})"),
            ClientKey::FeeAccrual(m, _) => std::format!("FeeAccrual({m},_)"),
            ClientKey::BestTick(m, s) => std::format!("BestTick({m},{s})"),
            ClientKey::TickSummary(m, s) => std::format!("TickSummary({m},{s})"),
            ClientKey::TickWord(m, s, w) => std::format!("TickWord({m},{s},{w})"),
            ClientKey::VaultBalance(_) | ClientKey::UserBalance(_) => return None,
        })
    }
    let mut a: Vec<_> = declared.iter().map(shape_d).collect();
    let mut b: Vec<_> = out.keys.iter().filter_map(shape_c).collect();
    a.sort();
    a.dedup();
    b.sort();
    b.dedup();
    assert_eq!(a, b, "client pad() and in-repo declare_place() disagree");
    // and the windows agree
    assert_eq!(out.window.append.first, win.append.first);
    assert_eq!(out.window.append.last, win.append.last);
    assert_eq!(out.window.consume.len(), win.consume.len() as usize);
    for (i, (tick, r)) in out.window.consume.iter().enumerate() {
        let w = win.consume.get(i as u32).unwrap();
        assert_eq!(
            (*tick, r.first, r.last),
            (w.tick, w.pages.first, w.pages.last)
        );
    }
    // both include vault + user balances on the client side
    assert!(out.keys.contains(&ClientKey::VaultBalance([2; 32])));
    assert!(out.keys.contains(&ClientKey::UserBalance([3; 32])));
}
