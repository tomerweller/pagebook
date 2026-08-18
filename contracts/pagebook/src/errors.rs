use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotAdmin = 1,
    Paused = 2,
    SameToken = 3,
    UnknownMarket = 4,
    BadQuantization = 5,
    TickOutOfBand = 6,
    BadStartTick = 7,
    QtyOutOfBounds = 8,
    Crossed = 9,
    Unfilled = 10,
    LevelFull = 11,
    RetryRest = 12,
    OrderExists = 13,
    NotOwner = 14,
    UnknownOrder = 15,
    Overflow = 16,
    FeeTooHigh = 17,
    TooManyLegs = 18,
    BadWindow = 19,
    BatchTooLarge = 20,
    TokenNotAuthorized = 21,
}
