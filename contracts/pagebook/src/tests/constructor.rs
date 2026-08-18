use crate::{PageBook, PageBookClient};
use soroban_sdk::{testutils::Address as _, Address, BytesN, IntoVal};

#[test]
fn constructor_sets_admin() {
    let env = super::env();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let id = env.register(PageBook, (&admin, &recipient));
    let client = PageBookClient::new(&env, &id);
    let next = Address::generate(&env);
    // the constructor's admin can rotate; afterwards only `next` may act
    client.set_admin(&next);
    client.set_fee_recipient(&next);
    env.set_auths(&[]);
    assert!(client.try_set_paused(&true).is_err(), "no auth: rejected");
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &admin,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &id,
            fn_name: "set_paused",
            args: (true,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(
        client.try_set_paused(&true).is_err(),
        "old admin: rejected after rotation"
    );
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &next,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &id,
            fn_name: "set_paused",
            args: (true,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.set_paused(&true);
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
