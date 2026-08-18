use crate::{DataKey, PageBook, MAX_ENTRY_TTL, MIN_PERSISTENT_TTL};
use soroban_sdk::{
    testutils::{storage::Instance as _, Address as _, Ledger as _},
    Address,
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
    assert!(
        still_there,
        "documented test-host behaviour (ADR-016): expiry does not evict; archival is a soak-only path"
    );
}

#[test]
fn ttl_constants_match_architecture() {
    assert_eq!(MIN_PERSISTENT_TTL, 2_073_600);
    assert_eq!(MAX_ENTRY_TTL, 3_110_400);
}

#[test]
fn keepalive_and_admin_ops_extend_instance_ttl() {
    let env = super::env();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let id = env.register(PageBook, (&admin, &recipient));
    let client = crate::PageBookClient::new(&env, &id);
    let before = env.as_contract(&id, || env.storage().instance().get_ttl());
    // move time on so an extension is observable, then crank
    let seq = env.ledger().sequence();
    env.ledger().set_sequence_number(seq + 1_000);
    client.keepalive();
    let after = env.as_contract(&id, || env.storage().instance().get_ttl());
    let max = env.as_contract(&id, || env.storage().max_ttl());
    assert!(after >= before, "keepalive extends: {after} >= {before}");
    assert_eq!(after, max, "keepalive extends to the max TTL");
    env.ledger().set_sequence_number(seq + 2_000);
    client.set_paused(&false);
    let after_admin = env.as_contract(&id, || env.storage().instance().get_ttl());
    assert!(
        after_admin >= after,
        "admin ops also bump: {after_admin} >= {after}"
    );
}
