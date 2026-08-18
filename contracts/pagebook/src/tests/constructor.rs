use crate::{PageBook, PageBookClient};
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env};

#[test]
fn constructor_sets_admin() {
    let env = super::env();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let id = env.register(PageBook, (&admin, &recipient));
    let client = PageBookClient::new(&env, &id);
    let next = Address::generate(&env);
    client.set_admin(&next);
    client.set_fee_recipient(&next);
}

#[test]
fn upgrade_requires_admin_auth() {
    let env = super::env();
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let id = env.register(PageBook, (&admin, &recipient));
    let client = PageBookClient::new(&env, &id);
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    assert!(client.try_upgrade(&hash).is_err());
}
