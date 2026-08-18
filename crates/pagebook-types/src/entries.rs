use crate::constants::{MARKET_BODY_BYTES, PACKED_VERSION};
use soroban_sdk::{contracttype, Address, Bytes, Env};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub fee_recipient: Address,
    pub paused: bool,
    pub market_counter: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigStore(pub Address, pub Address, pub bool, pub u32);

impl Config {
    pub fn to_store(&self) -> ConfigStore {
        ConfigStore(
            self.admin.clone(),
            self.fee_recipient.clone(),
            self.paused,
            self.market_counter,
        )
    }

    pub fn from_store(store: ConfigStore) -> Self {
        Self {
            admin: store.0,
            fee_recipient: store.1,
            paused: store.2,
            market_counter: store.3,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Market {
    pub base: Address,
    pub quote: Address,
    pub lot_size: u64,
    pub tick_size: u64,
    pub tick_min: u32,
    pub tick_max: u32,
    pub taker_fee_bps: u32,
    pub min_order_lots: u64,
    pub max_order_lots: u64,
    pub max_levels_crossed: u32,
    pub max_slots_scanned: u32,
    pub inline_slots: u32,
    pub page_slots: u32,
    pub max_pages: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketStore(pub Address, pub Address, pub Bytes);

impl Market {
    pub fn encode_body(&self) -> [u8; MARKET_BODY_BYTES] {
        let mut out = [0u8; MARKET_BODY_BYTES];
        out[0] = PACKED_VERSION;
        out[1..9].copy_from_slice(&self.lot_size.to_le_bytes());
        out[9..17].copy_from_slice(&self.tick_size.to_le_bytes());
        out[17..21].copy_from_slice(&self.tick_min.to_le_bytes());
        out[21..25].copy_from_slice(&self.tick_max.to_le_bytes());
        out[25..29].copy_from_slice(&self.taker_fee_bps.to_le_bytes());
        out[29..37].copy_from_slice(&self.min_order_lots.to_le_bytes());
        out[37..45].copy_from_slice(&self.max_order_lots.to_le_bytes());
        out[45..49].copy_from_slice(&self.max_levels_crossed.to_le_bytes());
        out[49..53].copy_from_slice(&self.max_slots_scanned.to_le_bytes());
        out[53..57].copy_from_slice(&self.inline_slots.to_le_bytes());
        out[57..61].copy_from_slice(&self.page_slots.to_le_bytes());
        out[61..65].copy_from_slice(&self.max_pages.to_le_bytes());
        out
    }

    pub fn to_store(&self, env: &Env) -> MarketStore {
        MarketStore(
            self.base.clone(),
            self.quote.clone(),
            Bytes::from_array(env, &self.encode_body()),
        )
    }

    pub fn from_store(store: MarketStore) -> Option<Self> {
        if store.2.len() != MARKET_BODY_BYTES as u32 {
            return None;
        }
        let mut body = [0u8; MARKET_BODY_BYTES];
        store.2.copy_into_slice(&mut body);
        if body[0] != PACKED_VERSION {
            return None;
        }
        Some(Self {
            base: store.0,
            quote: store.1,
            lot_size: u64::from_le_bytes(body[1..9].try_into().ok()?),
            tick_size: u64::from_le_bytes(body[9..17].try_into().ok()?),
            tick_min: u32::from_le_bytes(body[17..21].try_into().ok()?),
            tick_max: u32::from_le_bytes(body[21..25].try_into().ok()?),
            taker_fee_bps: u32::from_le_bytes(body[25..29].try_into().ok()?),
            min_order_lots: u64::from_le_bytes(body[29..37].try_into().ok()?),
            max_order_lots: u64::from_le_bytes(body[37..45].try_into().ok()?),
            max_levels_crossed: u32::from_le_bytes(body[45..49].try_into().ok()?),
            max_slots_scanned: u32::from_le_bytes(body[49..53].try_into().ok()?),
            inline_slots: u32::from_le_bytes(body[53..57].try_into().ok()?),
            page_slots: u32::from_le_bytes(body[57..61].try_into().ok()?),
            max_pages: u32::from_le_bytes(body[61..65].try_into().ok()?),
        })
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Order {
    pub is_bid: bool,
    pub tick: u32,
    pub generation: u32,
    pub seq: u32,
    pub qty_lots: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeAccrual {
    pub accrued: i128,
}
