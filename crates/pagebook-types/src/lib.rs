#![no_std]

mod bitmap;
mod constants;
mod entries;

pub use bitmap::*;
pub use constants::*;
pub use entries::*;

pub type MarketId = u32;

pub fn word_of(tick: u32) -> u32 {
    tick / WORD_TICKS
}

pub fn bit_in_word(tick: u32) -> u32 {
    tick % WORD_TICKS
}
