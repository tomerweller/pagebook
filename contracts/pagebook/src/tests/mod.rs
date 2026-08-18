mod constructor;
mod footprint;
mod sizes;
mod ttl;

use soroban_sdk::{testutils::EnvTestConfig, Env};

pub fn env() -> Env {
    Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    })
}
