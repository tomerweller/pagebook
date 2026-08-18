//! Property tests (05 "Testing strategy"): random rest/take/settle/replace
//! sequences over 1–2 makers against a naive reference book (price priority,
//! FIFO within a level) that predicts fills and payouts. Caps are non-binding
//! (32 levels / 64 slots, `max_pages` 1) and depth is inline-only (≤ 30
//! appends per run), so the reference never has to model truncation.
//!
//! Asserted after every op: identical fills / rests / payouts. After the
//! sequence: settle every open order, then differential settlement — for
//! each token Σ user balances + collected fees == Σ deposits exactly, the
//! vault ends at zero, `open_lots` per level == the reference, and the
//! recorded `BestTick` is never worse than the true best (weak invariant 3).

extern crate std;

use super::harness::{setup, window, Harness};
use crate::{Error, PlaceFlags};
use proptest::prelude::*;
use soroban_sdk::{
    testutils::Address as _, token::StellarAssetClient, token::TokenClient, Address,
};
use std::vec::Vec;

const TICK_LO: u32 = 10;
const TICK_HI: u32 = 30;
const DEPOSIT: i128 = 1_000_000_000;
const FEE_BPS: i128 = 10;

#[derive(Clone, Debug)]
enum Op {
    Rest {
        maker: usize,
        is_bid: bool,
        tick: u32,
        qty: u64,
    },
    Take {
        is_bid: bool,
        limit: u32,
        qty: u64,
    },
    Settle {
        maker: usize,
        pick: usize,
    },
    Replace {
        maker: usize,
        pick: usize,
        tick: u32,
        qty: u64,
    },
}

fn op_strategy() -> impl Strategy<Value = Op> {
    prop_oneof![
        3 => (0..2usize, any::<bool>(), TICK_LO..=TICK_HI, 1..=20u64)
            .prop_map(|(maker, is_bid, tick, qty)| Op::Rest { maker, is_bid, tick, qty }),
        2 => (any::<bool>(), TICK_LO..=TICK_HI, 1..=20u64)
            .prop_map(|(is_bid, limit, qty)| Op::Take { is_bid, limit, qty }),
        2 => (0..2usize, 0..64usize).prop_map(|(maker, pick)| Op::Settle { maker, pick }),
        2 => (0..2usize, 0..64usize, TICK_LO..=TICK_HI, 1..=20u64)
            .prop_map(|(maker, pick, tick, qty)| Op::Replace { maker, pick, tick, qty }),
    ]
}

fn crosses(taker_is_bid: bool, opp_tick: u32, limit: u32) -> bool {
    if taker_is_bid {
        opp_tick <= limit
    } else {
        opp_tick >= limit
    }
}

fn fee_of(output: i128) -> i128 {
    (output * FEE_BPS + 9_999) / 10_000
}

#[derive(Clone, Debug)]
struct RefOrder {
    owner: usize,
    nonce: u64,
    is_bid: bool,
    tick: u32,
    qty: u64,
    filled: u64,
    seq: u64,
}

impl RefOrder {
    fn open(&self) -> u64 {
        self.qty - self.filled
    }
    /// (paid, refunded) per architecture §7 with lot 1 / tick 1.
    fn payout(&self) -> (i128, i128) {
        let filled = i128::from(self.filled);
        let open = i128::from(self.open());
        if self.is_bid {
            (filled, open * i128::from(self.tick))
        } else {
            (filled * i128::from(self.tick), open)
        }
    }
}

#[derive(Default)]
struct RefBook {
    orders: Vec<RefOrder>,
    next_seq: u64,
    fees_base: i128,
    fees_quote: i128,
}

impl RefBook {
    /// Consume crossing liquidity best-tick-first, FIFO within a level.
    fn take(&mut self, taker_is_bid: bool, limit: u32, qty: u64) -> (u64, i128) {
        let mut left = qty;
        let mut filled = 0u64;
        let mut quote = 0i128;
        while left > 0 {
            let best = self
                .orders
                .iter_mut()
                .filter(|o| {
                    o.is_bid != taker_is_bid && o.open() > 0 && crosses(taker_is_bid, o.tick, limit)
                })
                .min_by_key(|o| {
                    let price = if taker_is_bid {
                        i64::from(o.tick)
                    } else {
                        -i64::from(o.tick)
                    };
                    (price, o.seq)
                });
            let Some(o) = best else { break };
            let take = core::cmp::min(left, o.open());
            o.filled += take;
            left -= take;
            filled += take;
            quote += i128::from(take) * i128::from(o.tick);
        }
        if filled > 0 {
            if taker_is_bid {
                self.fees_base += fee_of(i128::from(filled));
            } else {
                self.fees_quote += fee_of(quote);
            }
        }
        (filled, quote)
    }

    fn rest(&mut self, owner: usize, nonce: u64, is_bid: bool, tick: u32, qty: u64) {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.orders.push(RefOrder {
            owner,
            nonce,
            is_bid,
            tick,
            qty,
            filled: 0,
            seq,
        });
    }

    fn live_of(&self, owner: usize) -> Vec<usize> {
        self.orders
            .iter()
            .enumerate()
            .filter(|(_, o)| o.owner == owner)
            .map(|(i, _)| i)
            .collect()
    }

    fn open_lots(&self, is_bid: bool, tick: u32) -> u64 {
        self.orders
            .iter()
            .filter(|o| o.is_bid == is_bid && o.tick == tick)
            .map(|o| o.open())
            .sum()
    }

    fn best(&self, is_bid: bool) -> Option<u32> {
        let it = self
            .orders
            .iter()
            .filter(|o| o.is_bid == is_bid && o.open() > 0)
            .map(|o| o.tick);
        if is_bid {
            it.max()
        } else {
            it.min()
        }
    }
}

struct World {
    h: Harness,
    makers: Vec<Address>,
    taker: Address,
    nonces: Vec<u64>,
    reference: RefBook,
}

impl World {
    fn new() -> Self {
        let h = setup();
        h.client()
            .set_market_caps(&h.market, &32, &64, &10, &1, &1_000_000, &1);
        let makers = std::vec![Address::generate(&h.env), Address::generate(&h.env)];
        let taker = Address::generate(&h.env);
        for who in makers.iter().chain(core::iter::once(&taker)) {
            StellarAssetClient::new(&h.env, &h.base).mint(who, &DEPOSIT);
            StellarAssetClient::new(&h.env, &h.quote).mint(who, &DEPOSIT);
        }
        World {
            h,
            makers,
            taker,
            nonces: std::vec![0, 0],
            reference: RefBook::default(),
        }
    }

    fn place(
        &mut self,
        who: &Address,
        is_bid: bool,
        limit: u32,
        qty: u64,
        nonce: u64,
        no_rest: bool,
    ) -> (bool, u64, i128) {
        let q = self
            .h
            .client()
            .quote_place(&self.h.market, &is_bid, &limit, &qty);
        let f = PlaceFlags {
            post_only: false,
            fill_or_kill: false,
            no_rest,
        };
        let out = self.h.client().place(
            who,
            &self.h.market,
            &is_bid,
            &limit,
            &qty,
            &q.start_tick,
            &nonce,
            &window(&self.h),
            &f,
        );
        // The dry run predicts the apply exactly when nothing moves in between.
        assert_eq!(q.filled_lots, out.1, "quote_place vs place fills");
        assert_eq!(q.quote_atoms, out.2, "quote_place vs place quote");
        out
    }

    fn apply(&mut self, op: &Op) {
        match *op {
            Op::Rest {
                maker,
                is_bid,
                tick,
                qty,
            } => {
                self.nonces[maker] += 1;
                let nonce = self.nonces[maker];
                let who = self.makers[maker].clone();
                let got = self.place(&who, is_bid, tick, qty, nonce, false);
                let (filled, quote) = self.reference.take(is_bid, tick, qty);
                let left = qty - filled;
                if left > 0 {
                    self.reference.rest(maker, nonce, is_bid, tick, left);
                }
                assert_eq!(got, (left > 0, filled, quote), "rest op {op:?}");
            }
            Op::Take { is_bid, limit, qty } => {
                let who = self.taker.clone();
                let got = self.place(&who, is_bid, limit, qty, 1, true);
                let (filled, quote) = self.reference.take(is_bid, limit, qty);
                assert_eq!(got, (false, filled, quote), "take op {op:?}");
            }
            Op::Settle { maker, pick } => {
                let live = self.reference.live_of(maker);
                if live.is_empty() {
                    return;
                }
                let idx = live[pick % live.len()];
                let o = self.reference.orders[idx].clone();
                let got = self
                    .h
                    .client()
                    .settle(&self.makers[maker], &self.h.market, &o.nonce);
                assert_eq!(got, o.payout(), "settle op {op:?} of {o:?}");
                self.reference.orders.remove(idx);
            }
            Op::Replace {
                maker,
                pick,
                tick,
                qty,
            } => {
                let live = self.reference.live_of(maker);
                if live.is_empty() {
                    return;
                }
                let idx = live[pick % live.len()];
                let o = self.reference.orders[idx].clone();
                let recorded = self.h.client().best(&self.h.market, &!o.is_bid);
                let res = self.h.client().try_replace(
                    &self.makers[maker],
                    &self.h.market,
                    &o.nonce,
                    &o.is_bid,
                    &tick,
                    &qty,
                    &window(&self.h),
                );
                match recorded {
                    // Replace is post-only against the recorded best as stored
                    // (§9/§10): a crossing tick fails closed, even on a stale best.
                    Some(t) if crosses(o.is_bid, t, tick) => {
                        super::assert_err(res, Error::Crossed);
                    }
                    _ => {
                        let got = res.expect("replace").expect("replace conversion");
                        assert_eq!(got, o.payout(), "replace op {op:?} of {o:?}");
                        self.reference.orders.remove(idx);
                        self.reference.rest(maker, o.nonce, o.is_bid, tick, qty);
                    }
                }
            }
        }
    }

    fn check_book(&self) {
        let c = self.h.client();
        for is_bid in [false, true] {
            for tick in TICK_LO..=TICK_HI {
                let got = c.level(&self.h.market, &is_bid, &tick).open_lots;
                let want = self.reference.open_lots(is_bid, tick);
                assert_eq!(got, want, "open_lots side={is_bid} tick={tick}");
            }
            let recorded = c.best(&self.h.market, &is_bid);
            let truth = self.reference.best(is_bid);
            match (recorded, truth) {
                (None, Some(t)) => panic!("side {is_bid}: recorded empty but {t} is live"),
                (Some(r), Some(t)) => {
                    let ok = if is_bid { r >= t } else { r <= t };
                    assert!(ok, "side {is_bid}: recorded best {r} worse than true {t}");
                }
                _ => {}
            }
        }
    }

    fn settle_all_and_check_conservation(&mut self) {
        let c = self.h.client();
        let all: Vec<RefOrder> = self.reference.orders.clone();
        for o in all {
            let got = c.settle(&self.makers[o.owner], &self.h.market, &o.nonce);
            assert_eq!(got, o.payout(), "final settle of {o:?}");
        }
        self.reference.orders.clear();
        self.check_book();

        let recipient = self.h._recipient.clone();
        for (token, want_fee) in [
            (self.h.base.clone(), self.reference.fees_base),
            (self.h.quote.clone(), self.reference.fees_quote),
        ] {
            let t = TokenClient::new(&self.h.env, &token);
            let vault = t.balance(&self.h.id);
            assert_eq!(vault, want_fee, "vault holds exactly the accrued fees");
            let collected = c.collect_fees(&self.h.market, &token);
            assert_eq!(collected, want_fee, "collect_fees == Σ reference fees");
            assert_eq!(t.balance(&self.h.id), 0, "vault empty after collect");
            let users: i128 = self
                .makers
                .iter()
                .chain(core::iter::once(&self.taker))
                .map(|a| t.balance(a))
                .sum();
            let deposits = DEPOSIT * (self.makers.len() as i128 + 1);
            assert_eq!(
                users + t.balance(&recipient),
                deposits,
                "Σ payouts + collected fees == Σ deposits"
            );
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 64,
        max_shrink_iters: 256,
        .. ProptestConfig::default()
    })]

    #[test]
    fn random_histories_match_reference_and_conserve(ops in prop::collection::vec(op_strategy(), 1..=30)) {
        let mut w = World::new();
        for op in &ops {
            w.apply(op);
        }
        w.check_book();
        w.settle_all_and_check_conservation();
    }
}
