use soroban_sdk::{contracttype, Address};

pub const MIN_PERSISTENT_TTL: u32 = 2_073_600;
pub const MAX_ENTRY_TTL: u32 = 3_110_400;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Config,
    Market(u32),
    Level(u32, bool, u32),
    LevelPage(u32, bool, u32, u32),
    Order(u32, Address, u64),
    FeeAccrual(u32, Address),
    BestTick(u32, bool),
    TickSummary(u32, bool),
    TickWord(u32, bool, u32),
}
