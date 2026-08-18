use crate::errors::Error;
use crate::events;
use crate::iface::SlotWindow;
use crate::level;
use crate::store;
use pagebook_types::{BestTick, Market, Order};
use soroban_sdk::{Address, Env};

pub fn rest(
    env: &Env,
    owner: &Address,
    market: u32,
    m: &Market,
    is_bid: bool,
    tick: u32,
    qty: u64,
    nonce: u64,
    window: &SlotWindow,
    reuse_order: bool,
) {
    crate::market::require_qty(env, m, qty);
    crate::market::require_tick(env, m, tick);
    if !reuse_order && store::load_order(env, market, owner, nonce).is_some() {
        env.panic_with_error(Error::OrderExists);
    }
    let mut lvl = store::load_level(env, market, is_bid, tick);
    let was_empty = lvl.open_lots == 0;
    let seq = level::append(
        env,
        market,
        is_bid,
        tick,
        m,
        &mut lvl,
        qty,
        window.append.last,
    );
    store::save_level(env, market, is_bid, tick, &lvl);
    if was_empty {
        set_presence(env, market, is_bid, tick);
    }
    update_best_on_rest(env, market, is_bid, tick);
    store::save_order(
        env,
        market,
        owner,
        nonce,
        &Order {
            is_bid,
            tick,
            generation: lvl.generation,
            seq,
            qty_lots: qty,
        },
    );
    events::rested(env, market, owner, nonce, is_bid, tick, lvl.generation, seq);
}

fn set_presence(env: &Env, market: u32, is_bid: bool, tick: u32) {
    let word = pagebook_types::word_of(tick);
    let bit = pagebook_types::bit_in_word(tick);
    let mut tw = load_bitmap(env, DataKeyWord::Word(market, is_bid, word));
    tw.set(bit);
    save_bitmap(env, DataKeyWord::Word(market, is_bid, word), &tw);
    let mut sum = load_bitmap(env, DataKeyWord::Summary(market, is_bid));
    sum.set(word);
    save_bitmap(env, DataKeyWord::Summary(market, is_bid), &sum);
}

fn update_best_on_rest(env: &Env, market: u32, is_bid: bool, tick: u32) {
    let cur = store::load_best(env, market, is_bid);
    let take = cur.empty || better(is_bid, tick, cur.tick);
    if !take {
        return;
    }
    let old = if cur.empty { 0 } else { cur.tick };
    store::save_best(env, market, is_bid, &BestTick { empty: false, tick });
    events::top_changed(env, market, is_bid, old, tick);
}

pub fn better(is_bid: bool, cand: u32, rec: u32) -> bool {
    if is_bid {
        cand > rec
    } else {
        cand < rec
    }
}

pub fn crosses(taker_is_bid: bool, opp_tick: u32, limit_tick: u32) -> bool {
    if taker_is_bid {
        opp_tick <= limit_tick
    } else {
        opp_tick >= limit_tick
    }
}

enum DataKeyWord {
    Word(u32, bool, u32),
    Summary(u32, bool),
}

fn load_bitmap(env: &Env, k: DataKeyWord) -> pagebook_types::TickBitmap {
    use crate::keys::DataKey;
    use pagebook_types::{TickBitmap, TICK_BITMAP_BYTES};
    use soroban_sdk::Bytes;
    let key = match k {
        DataKeyWord::Word(m, b, w) => DataKey::TickWord(m, b, w),
        DataKeyWord::Summary(m, b) => DataKey::TickSummary(m, b),
    };
    match env.storage().persistent().get::<_, Bytes>(&key) {
        Some(bytes) => {
            let mut raw = [0u8; TICK_BITMAP_BYTES];
            if bytes.len() != TICK_BITMAP_BYTES as u32 {
                return TickBitmap::default();
            }
            bytes.copy_into_slice(&mut raw);
            TickBitmap::decode(&raw).unwrap_or_default()
        }
        None => TickBitmap::default(),
    }
}

fn save_bitmap(env: &Env, k: DataKeyWord, bm: &pagebook_types::TickBitmap) {
    use crate::keys::DataKey;
    use soroban_sdk::Bytes;
    let key = match k {
        DataKeyWord::Word(m, b, w) => DataKey::TickWord(m, b, w),
        DataKeyWord::Summary(m, b) => DataKey::TickSummary(m, b),
    };
    env.storage()
        .persistent()
        .set(&key, &Bytes::from_array(env, &bm.encode()));
}

pub fn clear_presence(env: &Env, market: u32, is_bid: bool, tick: u32) {
    let word = pagebook_types::word_of(tick);
    let bit = pagebook_types::bit_in_word(tick);
    let mut tw = load_bitmap(env, DataKeyWord::Word(market, is_bid, word));
    tw.clear(bit);
    save_bitmap(env, DataKeyWord::Word(market, is_bid, word), &tw);
    if !tw.any_set() {
        let mut sum = load_bitmap(env, DataKeyWord::Summary(market, is_bid));
        sum.clear(word);
        save_bitmap(env, DataKeyWord::Summary(market, is_bid), &sum);
    }
}
