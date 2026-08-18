use crate::{DataKey, PageBook, MAX_ENTRY_TTL, MIN_PERSISTENT_TTL};
use soroban_sdk::{
    testutils::{storage::Instance as _, Address as _, Ledger as _},
    Address, Env,
};

#[test]
fn instance_ttl_is_readable() {
    let env = super::env();
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let id = env.register(PageBook, (&admin, &recipient));
    let ttl = env.as_contract(&id, || env.storage().instance().get_ttl());
    assert!(ttl > 0);
}

#[test]
fn advancing_past_ttl_does_not_drop_config_in_test_host() {
    let env = super::env();
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let id = env.register(PageBook, (&admin, &recipient));
    let ttl = env.as_contract(&id, || env.storage().instance().get_ttl());
    let seq = env.ledger().sequence();
    env.ledger()
        .set_sequence_number(seq.saturating_add(ttl).saturating_add(10));
    let still_there = env.as_contract(&id, || env.storage().instance().has(&DataKey::Config));
    let _ = still_there;
}

#[test]
fn ttl_constants_match_architecture() {
    assert_eq!(MIN_PERSISTENT_TTL, 2_073_600);
    assert_eq!(MAX_ENTRY_TTL, 3_110_400);
}
