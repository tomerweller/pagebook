#![no_std]

mod admin;
mod errors;
mod keys;

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env};

pub use errors::Error;
pub use keys::{DataKey, MAX_ENTRY_TTL, MIN_PERSISTENT_TTL};
pub use pagebook_types::{Config, MarketId};

#[cfg(test)]
mod tests;

#[contract]
pub struct PageBook;

#[contractimpl]
impl PageBook {
    pub fn __constructor(env: Env, admin: Address, fee_recipient: Address) {
        admin::construct(&env, admin, fee_recipient);
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        admin::set_admin(&env, new_admin);
    }

    pub fn set_fee_recipient(env: Env, recipient: Address) {
        admin::set_fee_recipient(&env, recipient);
    }

    pub fn set_paused(env: Env, paused: bool) {
        admin::set_paused(&env, paused);
    }

    pub fn upgrade(env: Env, wasm_hash: BytesN<32>) {
        admin::upgrade(&env, wasm_hash);
    }

    pub fn keepalive(env: Env) {
        admin::keepalive(&env);
    }
}
