use crate::constants::BITMAP_BYTES;

/// One 2,048-bit tick index word or the summary over words (architecture §5).
/// Stored as `BytesN<256>`; bit `i` is byte `i / 8`, mask `1 << (i % 8)`.
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
        assert!(bm.any_set());
    }
}
