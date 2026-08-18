use pagebook_types::{page, word_of, MarketId};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientKey {
    Config,
    Market(u32),
    Level(u32, bool, u32),
    LevelPage(u32, bool, u32, u32),
    Order(u32, [u8; 32], u64),
    FeeAccrual(u32, [u8; 32]),
    BestTick(u32, bool),
    TickSummary(u32, bool),
    TickWord(u32, bool, u32),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Quoted {
    pub start_tick: u32,
    pub crossed: Vec<u32>,
    pub tail_seq: u32,
    pub own_side: bool,
    pub limit_tick: u32,
    pub market: MarketId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PadOut {
    pub keys: Vec<ClientKey>,
    pub append_first: u32,
    pub append_last: u32,
}

pub fn keys_for_settle(
    market: u32,
    owner: [u8; 32],
    nonce: u64,
    is_bid: bool,
    tick: u32,
) -> Vec<ClientKey> {
    vec![
        ClientKey::Order(market, owner, nonce),
        ClientKey::Level(market, is_bid, tick),
        ClientKey::LevelPage(market, is_bid, tick, 0),
    ]
}

pub fn keys_for_place(q: &Quoted) -> Vec<ClientKey> {
    pad(q, q.limit_tick).keys
}

pub fn pad(q: &Quoted, pad_end: u32) -> PadOut {
    let opp = !q.own_side;
    let mut keys = Vec::new();
    let start = q.start_tick.min(pad_end);
    let end = q.start_tick.max(pad_end);
    let mut t = start;
    while t <= end {
        keys.push(ClientKey::Level(q.market, opp, t));
        t = t.saturating_add(1);
        if t == 0 {
            break;
        }
    }
    for tick in &q.crossed {
        keys.push(ClientKey::TickWord(q.market, opp, word_of(*tick)));
    }
    keys.push(ClientKey::TickWord(q.market, opp, word_of(q.limit_tick)));
    keys.push(ClientKey::TickWord(
        q.market,
        q.own_side,
        word_of(q.limit_tick),
    ));
    keys.push(ClientKey::TickSummary(q.market, opp));
    keys.push(ClientKey::TickSummary(q.market, q.own_side));
    keys.push(ClientKey::BestTick(q.market, opp));
    keys.push(ClientKey::BestTick(q.market, q.own_side));
    keys.push(ClientKey::Level(q.market, q.own_side, q.limit_tick));
    let p = page(q.tail_seq);
    keys.push(ClientKey::LevelPage(q.market, q.own_side, q.limit_tick, p));
    if p < u32::MAX {
        keys.push(ClientKey::LevelPage(
            q.market,
            q.own_side,
            q.limit_tick,
            p + 1,
        ));
    }
    keys.push(ClientKey::LevelPage(q.market, q.own_side, q.limit_tick, 0));
    PadOut {
        keys,
        append_first: p,
        append_last: p.saturating_add(1),
    }
}

pub struct NonceAlloc {
    next: u64,
}

impl NonceAlloc {
    pub fn new() -> Self {
        Self { next: 1 }
    }

    pub fn take(&mut self) -> u64 {
        let n = self.next;
        self.next = self.next.saturating_add(1);
        n
    }
}

impl Default for NonceAlloc {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pad_includes_own_level() {
        let q = Quoted {
            start_tick: 10,
            crossed: vec![10],
            tail_seq: 0,
            own_side: true,
            limit_tick: 20,
            market: 0,
        };
        let out = pad(&q, 20);
        assert!(out
            .keys
            .iter()
            .any(|k| matches!(k, ClientKey::Level(0, true, 20))));
        assert_eq!(out.append_first, 0);
        assert_eq!(out.append_last, 1);
    }

    #[test]
    fn nonce_increments() {
        let mut n = NonceAlloc::new();
        assert_eq!(n.take(), 1);
        assert_eq!(n.take(), 2);
    }

    #[test]
    fn settle_keys_name_order() {
        let keys = keys_for_settle(3, [7; 32], 9, true, 4);
        assert!(keys.iter().any(|k| matches!(k, ClientKey::Order(3, _, 9))));
    }
}
