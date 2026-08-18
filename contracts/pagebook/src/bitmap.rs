use crate::keys::DataKey;
use pagebook_types::{
    bit_in_word, word_of, TickBitmap, SUMMARY_WORDS, TICK_BITMAP_BYTES, WORD_TICKS,
};
use soroban_sdk::{Bytes, Env};

pub fn load_word(env: &Env, market: u32, is_bid: bool, word: u32) -> TickBitmap {
    load(env, DataKey::TickWord(market, is_bid, word))
}

pub fn load_summary(env: &Env, market: u32, is_bid: bool) -> TickBitmap {
    load(env, DataKey::TickSummary(market, is_bid))
}

fn load(env: &Env, key: DataKey) -> TickBitmap {
    match env.storage().persistent().get::<_, Bytes>(&key) {
        Some(bytes) if bytes.len() == TICK_BITMAP_BYTES as u32 => {
            let mut raw = [0u8; TICK_BITMAP_BYTES];
            bytes.copy_into_slice(&mut raw);
            TickBitmap::decode(&raw).unwrap_or_default()
        }
        _ => TickBitmap::default(),
    }
}

fn save(env: &Env, key: DataKey, bm: &TickBitmap) {
    env.storage()
        .persistent()
        .set(&key, &Bytes::from_array(env, &bm.encode()));
}

pub fn set_tick(env: &Env, market: u32, is_bid: bool, tick: u32) {
    let w = word_of(tick);
    let mut word = load_word(env, market, is_bid, w);
    word.set(bit_in_word(tick));
    save(env, DataKey::TickWord(market, is_bid, w), &word);
    let mut sum = load_summary(env, market, is_bid);
    sum.set(w);
    save(env, DataKey::TickSummary(market, is_bid), &sum);
}

pub fn clear_tick(env: &Env, market: u32, is_bid: bool, tick: u32) {
    let w = word_of(tick);
    let mut word = load_word(env, market, is_bid, w);
    word.clear(bit_in_word(tick));
    save(env, DataKey::TickWord(market, is_bid, w), &word);
    if !word.any_set() {
        let mut sum = load_summary(env, market, is_bid);
        sum.clear(w);
        save(env, DataKey::TickSummary(market, is_bid), &sum);
    }
}

pub fn next_set_tick(env: &Env, market: u32, is_bid: bool, from: u32, ascend: bool) -> Option<u32> {
    let start_word = word_of(from);
    let start_bit = bit_in_word(from);
    let sum = load_summary(env, market, is_bid);
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
        let mut w = start_word + 1;
        let mut n = 0u32;
        while w < SUMMARY_WORDS && n < SUMMARY_WORDS {
            if sum.get(w) {
                if let Some(t) = scan_word(env, market, is_bid, w, 0, WORD_TICKS, true) {
                    return Some(t);
                }
            }
            w += 1;
            n += 1;
        }
        None
    } else {
        if start_bit > 0 {
            if let Some(t) = scan_word(env, market, is_bid, start_word, 0, start_bit, false) {
                return Some(t);
            }
        }
        let mut n = 0u32;
        let mut w = start_word;
        while w > 0 && n < SUMMARY_WORDS {
            w -= 1;
            if sum.get(w) {
                if let Some(t) = scan_word(env, market, is_bid, w, 0, WORD_TICKS, false) {
                    return Some(t);
                }
            }
            n += 1;
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
