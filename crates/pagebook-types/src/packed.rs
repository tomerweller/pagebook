use crate::constants::*;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Level {
    pub generation: u32,
    pub head_seq: u32,
    pub tail_seq: u32,
    pub head_consumed_lots: u64,
    pub open_lots: u64,
    pub slots: [u64; INLINE_SLOTS as usize],
}

impl Default for Level {
    fn default() -> Self {
        Self {
            generation: 0,
            head_seq: 0,
            tail_seq: 0,
            head_consumed_lots: 0,
            open_lots: 0,
            slots: [0; INLINE_SLOTS as usize],
        }
    }
}

impl Level {
    pub fn encode(&self) -> [u8; LEVEL_BYTES] {
        let mut out = [0u8; LEVEL_BYTES];
        out[0] = PACKED_VERSION;
        out[1..5].copy_from_slice(&self.generation.to_le_bytes());
        out[5..9].copy_from_slice(&self.head_seq.to_le_bytes());
        out[9..13].copy_from_slice(&self.tail_seq.to_le_bytes());
        out[13..21].copy_from_slice(&self.head_consumed_lots.to_le_bytes());
        out[21..29].copy_from_slice(&self.open_lots.to_le_bytes());
        let mut off = 29;
        for qty in self.slots {
            out[off..off + 8].copy_from_slice(&qty.to_le_bytes());
            off += 8;
        }
        out
    }

    pub fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != LEVEL_BYTES || bytes[0] != PACKED_VERSION {
            return None;
        }
        let mut slots = [0u64; INLINE_SLOTS as usize];
        let mut off = 29;
        for slot in &mut slots {
            *slot = u64::from_le_bytes(bytes[off..off + 8].try_into().ok()?);
            off += 8;
        }
        Some(Self {
            generation: u32::from_le_bytes(bytes[1..5].try_into().ok()?),
            head_seq: u32::from_le_bytes(bytes[5..9].try_into().ok()?),
            tail_seq: u32::from_le_bytes(bytes[9..13].try_into().ok()?),
            head_consumed_lots: u64::from_le_bytes(bytes[13..21].try_into().ok()?),
            open_lots: u64::from_le_bytes(bytes[21..29].try_into().ok()?),
            slots,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LevelPage {
    pub slots: [u64; PAGE_SLOTS as usize],
}

impl Default for LevelPage {
    fn default() -> Self {
        Self {
            slots: [0; PAGE_SLOTS as usize],
        }
    }
}

impl LevelPage {
    pub fn encode(&self) -> [u8; LEVEL_PAGE_BYTES] {
        let mut out = [0u8; LEVEL_PAGE_BYTES];
        out[0] = PACKED_VERSION;
        let mut off = 1;
        for qty in self.slots {
            out[off..off + 8].copy_from_slice(&qty.to_le_bytes());
            off += 8;
        }
        out
    }

    pub fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != LEVEL_PAGE_BYTES || bytes[0] != PACKED_VERSION {
            return None;
        }
        let mut slots = [0u64; PAGE_SLOTS as usize];
        let mut off = 1;
        for slot in &mut slots {
            *slot = u64::from_le_bytes(bytes[off..off + 8].try_into().ok()?);
            off += 8;
        }
        Some(Self { slots })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TickBitmap {
    pub bits: [u8; BITMAP_BYTES],
}

impl Default for TickBitmap {
    fn default() -> Self {
        Self {
            bits: [0; BITMAP_BYTES],
        }
    }
}

impl TickBitmap {
    pub fn encode(&self) -> [u8; TICK_BITMAP_BYTES] {
        let mut out = [0u8; TICK_BITMAP_BYTES];
        out[0] = PACKED_VERSION;
        out[1..].copy_from_slice(&self.bits);
        out
    }

    pub fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != TICK_BITMAP_BYTES || bytes[0] != PACKED_VERSION {
            return None;
        }
        let mut bits = [0u8; BITMAP_BYTES];
        bits.copy_from_slice(&bytes[1..]);
        Some(Self { bits })
    }

    pub fn get(&self, i: u32) -> bool {
        let byte = (i / 8) as usize;
        let mask = 1u8 << (i % 8);
        self.bits[byte] & mask != 0
    }

    pub fn set(&mut self, i: u32) {
        let byte = (i / 8) as usize;
        let mask = 1u8 << (i % 8);
        self.bits[byte] |= mask;
    }

    pub fn clear(&mut self, i: u32) {
        let byte = (i / 8) as usize;
        let mask = 1u8 << (i % 8);
        self.bits[byte] &= !mask;
    }

    pub fn any_set(&self) -> bool {
        self.bits.iter().any(|b| *b != 0)
    }
}

pub type TickWord = TickBitmap;
pub type TickSummary = TickBitmap;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_roundtrip_max() {
        let mut level = Level {
            generation: u32::MAX,
            head_seq: u32::MAX,
            tail_seq: u32::MAX,
            head_consumed_lots: u64::MAX,
            open_lots: u64::MAX,
            slots: [u64::MAX; INLINE_SLOTS as usize],
        };
        level.slots[0] = 1;
        level.slots[31] = 2;
        let encoded = level.encode();
        assert_eq!(encoded.len(), LEVEL_BYTES);
        assert_eq!(encoded[0], PACKED_VERSION);
        assert_eq!(Level::decode(&encoded), Some(level));
    }

    #[test]
    fn level_page_roundtrip() {
        let mut page = LevelPage::default();
        page.slots[0] = 9;
        page.slots[31] = 8;
        assert_eq!(LevelPage::decode(&page.encode()), Some(page));
    }

    #[test]
    fn bitmap_bit_order() {
        let mut bm = TickBitmap::default();
        bm.set(0);
        bm.set(7);
        bm.set(8);
        bm.set(2047);
        assert!(bm.get(0));
        assert!(bm.get(7));
        assert!(bm.get(8));
        assert!(bm.get(2047));
        assert!(!bm.get(1));
        assert_eq!(bm.bits[0], 0b1000_0001);
        assert_eq!(bm.bits[1], 0b0000_0001);
        assert_eq!(bm.bits[255], 0b1000_0000);
        bm.clear(7);
        assert!(!bm.get(7));
        assert_eq!(TickBitmap::decode(&bm.encode()), Some(bm));
    }

    #[test]
    fn reject_bad_version() {
        let mut raw = Level::default().encode();
        raw[0] = 2;
        assert!(Level::decode(&raw).is_none());
    }
}
