use crate::{empty_window, PageBook, PageBookClient, PlaceFlags, SlotWindow};
use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Address, Env};

pub struct Harness {
    pub env: Env,
    pub _admin: Address,
    pub _recipient: Address,
    pub id: Address,
    pub base: Address,
    pub quote: Address,
    pub market: u32,
}

impl Harness {
    pub fn client(&self) -> PageBookClient<'_> {
        PageBookClient::new(&self.env, &self.id)
    }
}

pub fn setup() -> Harness {
    let env = super::env();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let id = env.register(PageBook, (&admin, &recipient));
    let base_sac = env.register_stellar_asset_contract_v2(admin.clone());
    let quote_sac = env.register_stellar_asset_contract_v2(admin.clone());
    let base = base_sac.address();
    let quote = quote_sac.address();
    let client = PageBookClient::new(&env, &id);
    StellarAssetClient::new(&env, &base).set_authorized(&id, &true);
    StellarAssetClient::new(&env, &quote).set_authorized(&id, &true);
    let market = client.create_market(&base, &quote, &1, &1, &1, &1000, &10, &1, &1_000_000);
    Harness {
        env,
        _admin: admin,
        _recipient: recipient,
        id,
        base,
        quote,
        market,
    }
}

pub fn mint(h: &Harness, token: &Address, to: &Address, amount: i128) {
    StellarAssetClient::new(&h.env, token).mint(to, &amount);
}

pub fn window(h: &Harness) -> SlotWindow {
    empty_window(&h.env)
}

pub fn flags() -> PlaceFlags {
    PlaceFlags::none()
}

pub fn rest_ask(h: &Harness, maker: &Address, tick: u32, qty: u64, nonce: u64) {
    mint(h, &h.base, maker, 1_000_000_000);
    h.client().place(
        maker,
        &h.market,
        &false,
        &tick,
        &qty,
        &tick,
        &nonce,
        &window(h),
        &flags(),
    );
}

pub fn rest_bid(h: &Harness, maker: &Address, tick: u32, qty: u64, nonce: u64) {
    mint(h, &h.quote, maker, 1_000_000_000);
    h.client().place(
        maker,
        &h.market,
        &true,
        &tick,
        &qty,
        &tick,
        &nonce,
        &window(h),
        &flags(),
    );
}
