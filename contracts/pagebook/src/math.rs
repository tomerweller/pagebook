use crate::errors::Error;
use pagebook_types::FEE_BPS_DENOM;
use soroban_sdk::Env;

pub fn chk_mul(env: &Env, a: i128, b: i128) -> i128 {
    a.checked_mul(b)
        .unwrap_or_else(|| env.panic_with_error(Error::Overflow))
}

pub fn chk_add(env: &Env, a: i128, b: i128) -> i128 {
    a.checked_add(b)
        .unwrap_or_else(|| env.panic_with_error(Error::Overflow))
}

pub fn chk_sub(env: &Env, a: i128, b: i128) -> i128 {
    a.checked_sub(b)
        .unwrap_or_else(|| env.panic_with_error(Error::Overflow))
}

pub fn u64_i128(_env: &Env, n: u64) -> i128 {
    i128::from(n)
}

pub fn quote_atoms(env: &Env, qty_lots: u64, tick: u32, tick_size: u64) -> i128 {
    let q = u64_i128(env, qty_lots);
    let t = i128::from(tick);
    let ts = u64_i128(env, tick_size);
    chk_mul(env, chk_mul(env, q, t), ts)
}

pub fn base_atoms(env: &Env, qty_lots: u64, lot_size: u64) -> i128 {
    chk_mul(env, u64_i128(env, qty_lots), u64_i128(env, lot_size))
}

pub fn taker_fee(env: &Env, output: i128, fee_bps: u32) -> i128 {
    if output <= 0 {
        return 0;
    }
    let bps = i128::from(fee_bps);
    let hi = chk_mul(env, output / FEE_BPS_DENOM, bps);
    let rem = chk_mul(env, output % FEE_BPS_DENOM, bps);
    let lo = if rem == 0 {
        0
    } else {
        (rem + FEE_BPS_DENOM - 1) / FEE_BPS_DENOM
    };
    chk_add(env, hi, lo)
}

pub fn overflow_bound_ok(level_cap: u32, max_order_lots: u64, factor: u64, extra: u32) -> bool {
    let rhs = (i128::MAX / (4 * i128::from(pagebook_types::MAX_ROUTE_LEGS))) as u128;
    let lhs = (level_cap as u128)
        .saturating_mul(max_order_lots as u128)
        .saturating_mul(factor as u128)
        .saturating_mul(extra as u128);
    lhs <= rhs
}
