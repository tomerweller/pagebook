#![no_std]

mod constants;
mod entries;
mod packed;

pub use constants::*;
pub use entries::*;
pub use packed::*;

pub type MarketId = u32;

pub fn page(seq: u32) -> u32 {
    if seq < INLINE_SLOTS {
        0
    } else {
        (seq - INLINE_SLOTS) / PAGE_SLOTS
    }
}

pub fn is_inline(seq: u32) -> bool {
    seq < INLINE_SLOTS
}

pub fn slot_in_page(seq: u32) -> u32 {
    if seq < INLINE_SLOTS {
        seq
    } else {
        (seq - INLINE_SLOTS) % PAGE_SLOTS
    }
}

pub fn word_of(tick: u32) -> u32 {
    tick / WORD_TICKS
}

pub fn bit_in_word(tick: u32) -> u32 {
    tick % WORD_TICKS
}

pub fn level_cap(max_pages: u32) -> u32 {
    INLINE_SLOTS + PAGE_SLOTS * max_pages
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_inline_is_zero() {
        assert_eq!(page(0), 0);
        assert_eq!(page(INLINE_SLOTS - 1), 0);
    }

    #[test]
    fn page_first_overflow_is_zero() {
        assert_eq!(page(INLINE_SLOTS), 0);
        assert_eq!(page(INLINE_SLOTS + PAGE_SLOTS - 1), 0);
        assert_eq!(page(INLINE_SLOTS + PAGE_SLOTS), 1);
    }

    #[test]
    fn default_level_cap() {
        assert_eq!(level_cap(MAX_PAGES), 64);
    }
}
