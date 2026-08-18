mod auth;
mod book;
mod constructor;
mod fee_gates;
mod fees;
mod footprint;
mod harness;
mod market;
mod matching;
mod padding;
mod pages;
mod property;
mod reliquify;
mod route;
mod sizes;
mod ttl;
mod worst_case;

use soroban_sdk::{testutils::EnvTestConfig, Env};

pub fn env() -> Env {
    Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    })
}

pub fn assert_err<T: core::fmt::Debug>(
    got: Result<T, Result<soroban_sdk::Error, soroban_sdk::InvokeError>>,
    want: crate::Error,
) {
    match got {
        Err(Ok(e)) => assert_eq!(e, want.into()),
        other => panic!("expected {want:?}, got {other:?}"),
    }
}
