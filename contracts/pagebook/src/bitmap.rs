use crate::errors::Error;
use crate::keys::DataKey;
use pagebook_types::{bit_in_word, word_of, TickBitmap, TICK_BITMAP_BYTES, WORD_TICKS};
use soroban_sdk::{Bytes, Env};

pub fn load_word(env: &Env, market: u32, is_bid: bool, word: u32) -> TickBitmap {
    load(env, DataKey::TickWord(market, is_bid, word))
}

pub fn load_summary(env: &Env, market: u32, is_bid: bool) -> TickBitmap {
    load(env, DataKey::TickSummary(market, is_bid))
}

/// A missing entry decodes as an all-zero bitmap; a present entry that fails to
/// decode is a typed error, never silently empty (a silently empty word would hide
/// live levels from matching and break invariant 3).
fn load(env: &Env, key: DataKey) -> TickBitmap {
    crate::store::note(&key);
    match env.storage().persistent().get::<_, Bytes>(&key) {
        Some(bytes) => {
            if bytes.len() != TICK_BITMAP_BYTES as u32 {
                env.panic_with_error(Error::CorruptEntry);
            }
            let mut raw = [0u8; TICK_BITMAP_BYTES];
            bytes.copy_into_slice(&mut raw);
            TickBitmap::decode(&raw).unwrap_or_else(|| env.panic_with_error(Error::CorruptEntry))
        }
        None => TickBitmap::default(),
    }
}

fn save(env: &Env, key: DataKey, bm: &TickBitmap) {
    crate::store::note(&key);
    env.storage()
        .persistent()
        .set(&key, &Bytes::from_array(env, &bm.encode()));
}

/// Idempotent: writes nothing when the bit (and the summary bit) are already set.
pub fn set_tick(env: &Env, market: u32, is_bid: bool, tick: u32) {
    let w = word_of(tick);
    let b = bit_in_word(tick);
    let mut word = load_word(env, market, is_bid, w);
    if word.get(b) {
        return;
    }
    let was_empty = !word.any_set();
    word.set(b);
    save(env, DataKey::TickWord(market, is_bid, w), &word);
    if was_empty {
        let mut sum = load_summary(env, market, is_bid);
        if !sum.get(w) {
            sum.set(w);
            save(env, DataKey::TickSummary(market, is_bid), &sum);
        }
    }
}

/// Idempotent: writes nothing when the bit is already clear. Returns whether a bit
/// was actually cleared.
pub fn clear_tick(env: &Env, market: u32, is_bid: bool, tick: u32) -> bool {
    let w = word_of(tick);
    let b = bit_in_word(tick);
    let mut word = load_word(env, market, is_bid, w);
    if !word.get(b) {
        return false;
    }
    word.clear(b);
    save(env, DataKey::TickWord(market, is_bid, w), &word);
    if !word.any_set() {
        let mut sum = load_summary(env, market, is_bid);
        if sum.get(w) {
            sum.clear(w);
            save(env, DataKey::TickSummary(market, is_bid), &sum);
        }
    }
    true
}

/// Next set tick strictly past `from` in the walk direction, never reading a
/// `TickWord` beyond `bound`'s word (the walk passes `limit_tick`; §8 "no scan
/// past the last sweep"): a `None` therefore means "no set bit between `from`
/// and the end of `bound`'s word", not "side empty".
pub fn next_set_tick(
    env: &Env,
    market: u32,
    is_bid: bool,
    from: u32,
    bound: u32,
    ascend: bool,
) -> Option<u32> {
    let start_word = word_of(from);
    let start_bit = bit_in_word(from);
    let bound_word = word_of(bound);
    if ascend {
        if let Some(t) = scan_word(
            env,
            market,
            is_bid,
            start_word,
            start_bit + 1,
            WORD_TICKS,
            true,
        ) {
            return Some(t);
        }
        if start_word >= bound_word {
            return None;
        }
        let sum = load_summary(env, market, is_bid);
        let mut w = start_word + 1;
        while w <= bound_word {
            if sum.get(w) {
                if let Some(t) = scan_word(env, market, is_bid, w, 0, WORD_TICKS, true) {
                    return Some(t);
                }
            }
            w += 1;
        }
        None
    } else {
        if start_bit > 0 {
            if let Some(t) = scan_word(env, market, is_bid, start_word, 0, start_bit, false) {
                return Some(t);
            }
        }
        if start_word <= bound_word {
            return None;
        }
        let sum = load_summary(env, market, is_bid);
        let mut w = start_word;
        while w > bound_word {
            w -= 1;
            if sum.get(w) {
                if let Some(t) = scan_word(env, market, is_bid, w, 0, WORD_TICKS, false) {
                    return Some(t);
                }
            }
        }
        None
    }
}

fn scan_word(
    env: &Env,
    market: u32,
    is_bid: bool,
    word: u32,
    bit_lo: u32,
    bit_hi: u32,
    ascend: bool,
) -> Option<u32> {
    let bm = load_word(env, market, is_bid, word);
    if ascend {
        let mut b = bit_lo;
        while b < bit_hi {
            if bm.get(b) {
                return Some(word * WORD_TICKS + b);
            }
            b += 1;
        }
    } else {
        let mut b = bit_hi;
        while b > bit_lo {
            b -= 1;
            if bm.get(b) {
                return Some(word * WORD_TICKS + b);
            }
        }
    }
    None
}
