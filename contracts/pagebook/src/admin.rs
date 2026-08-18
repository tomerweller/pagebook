use crate::store::{load_config, save_config};
use pagebook_types::Config;
use soroban_sdk::{Address, BytesN, Env};

pub fn construct(env: &Env, admin: Address, fee_recipient: Address) {
    let config = Config {
        admin,
        fee_recipient,
        paused: false,
        market_counter: 0,
    };
    save_config(env, &config);
}

/// Admin ops authenticate and, per architecture §12/§18 ("admin ops also
/// bump"), extend the instance and code TTLs like `keepalive`.
pub fn require_admin(env: &Env) -> Config {
    let config = load_config(env);
    config.admin.require_auth();
    keepalive(env);
    config
}

pub fn set_admin(env: &Env, new_admin: Address) {
    let mut config = require_admin(env);
    config.admin = new_admin;
    save_config(env, &config);
}

pub fn set_fee_recipient(env: &Env, recipient: Address) {
    let mut config = require_admin(env);
    config.fee_recipient = recipient;
    save_config(env, &config);
}

pub fn set_paused(env: &Env, paused: bool) {
    let mut config = require_admin(env);
    config.paused = paused;
    save_config(env, &config);
}

pub fn upgrade(env: &Env, wasm_hash: BytesN<32>) {
    let _ = require_admin(env);
    env.deployer().update_current_contract_wasm(wasm_hash);
}

pub fn keepalive(env: &Env) {
    let max = env.storage().max_ttl();
    env.deployer()
        .extend_ttl(env.current_contract_address(), max, max);
}
