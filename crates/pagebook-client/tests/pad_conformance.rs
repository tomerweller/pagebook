//! Shared pad-conformance fixture: Rust is the generator and one consumer.
//! TypeScript loads the same JSON.

use pagebook_client::{
    keys_for_replace, keys_for_settle, pad, restore_marks, sorted_key_strs, ClientKey,
    CrossedLevel, Quoted,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const TAKER: [u8; 32] = [1; 32];
const BASE: [u8; 32] = [2; 32];
const QUOTE: [u8; 32] = [3; 32];
const NONCE: u64 = 7;

const NOTE: &str = "Liveness-aware pads drop archived keys in the TS engine applyPad. \
This fixture still enumerates the full pad. The Rust crate does not classify archival.";

#[derive(Clone, Serialize, Deserialize)]
struct Fixture {
    taker: String,
    nonce: u64,
    base: String,
    quote: String,
    note: String,
    cases: Vec<Case>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Case {
    name: String,
    quoted: QuotedIn,
    options: Options,
    #[serde(skip_serializing_if = "Option::is_none")]
    settle: Option<SettleIn>,
    #[serde(skip_serializing_if = "Option::is_none")]
    replace: Option<ReplaceIn>,
    #[serde(skip_serializing_if = "Option::is_none")]
    archived: Option<Vec<String>>,
    expected: Expected,
}

#[derive(Clone, Serialize, Deserialize)]
struct QuotedIn {
    market: u32,
    is_bid: bool,
    limit_tick: u32,
    start_tick: u32,
    qty: u64,
    crossed: Vec<CrossedIn>,
    filled_lots: u64,
}

#[derive(Clone, Serialize, Deserialize)]
struct CrossedIn {
    tick: u32,
    open_lots: u64,
}

#[derive(Clone, Serialize, Deserialize)]
struct Options {
    pad_end: u32,
}

#[derive(Clone, Serialize, Deserialize)]
struct SettleIn {
    is_bid: bool,
    tick: u32,
}

#[derive(Clone, Serialize, Deserialize)]
struct ReplaceIn {
    old_is_bid: bool,
    old_tick: u32,
    new_is_bid: bool,
    new_tick: u32,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
struct Expected {
    keys: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    keys_for_settle: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    keys_for_replace: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    restore_marks: Option<Vec<String>>,
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/pad-conformance.json")
}

fn hex32(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn parse_hex32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).expect("hex32");
    }
    out
}

fn parse_key(s: &str) -> ClientKey {
    if s == "Config" {
        return ClientKey::Config;
    }
    let (name, inner) = s.split_once('(').expect("key(");
    let inner = inner.strip_suffix(')').expect(")");
    let parts: Vec<&str> = inner.split(',').collect();
    match name {
        "Market" => ClientKey::Market(parts[0].parse().unwrap()),
        "Level" => ClientKey::Level(
            parts[0].parse().unwrap(),
            parts[1].parse().unwrap(),
            parts[2].parse().unwrap(),
        ),
        "Order" => ClientKey::Order(
            parts[0].parse().unwrap(),
            parse_hex32(parts[1]),
            parts[2].parse().unwrap(),
        ),
        "FeeAccrual" => ClientKey::FeeAccrual(parts[0].parse().unwrap(), parse_hex32(parts[1])),
        "BestTick" => ClientKey::BestTick(parts[0].parse().unwrap(), parts[1].parse().unwrap()),
        "TickSummary" => {
            ClientKey::TickSummary(parts[0].parse().unwrap(), parts[1].parse().unwrap())
        }
        "TickWord" => ClientKey::TickWord(
            parts[0].parse().unwrap(),
            parts[1].parse().unwrap(),
            parts[2].parse().unwrap(),
        ),
        "VaultBalance" => ClientKey::VaultBalance(parse_hex32(parts[0])),
        "UserBalance" => ClientKey::UserBalance(parse_hex32(parts[0])),
        other => panic!("unknown key {other}"),
    }
}

fn to_quoted(q: &QuotedIn, taker: [u8; 32], nonce: u64, base: [u8; 32], quote: [u8; 32]) -> Quoted {
    Quoted {
        market: q.market,
        own_side: q.is_bid,
        limit_tick: q.limit_tick,
        start_tick: q.start_tick,
        crossed: q
            .crossed
            .iter()
            .map(|c| CrossedLevel {
                tick: c.tick,
                open_lots: c.open_lots,
            })
            .collect(),
        taker,
        nonce,
        base,
        quote,
    }
}

fn compute(case: &Case, taker: [u8; 32], nonce: u64, base: [u8; 32], quote: [u8; 32]) -> Expected {
    let q = to_quoted(&case.quoted, taker, nonce, base, quote);
    let out = pad(&q, case.options.pad_end);
    let keys_for_settle = case.settle.as_ref().map(|s| {
        sorted_key_strs(&keys_for_settle(
            case.quoted.market,
            taker,
            nonce,
            s.is_bid,
            s.tick,
            base,
            quote,
        ))
    });
    let keys_for_replace = case.replace.as_ref().map(|r| {
        sorted_key_strs(&keys_for_replace(
            case.quoted.market,
            taker,
            nonce,
            r.old_is_bid,
            r.old_tick,
            r.new_is_bid,
            r.new_tick,
            base,
            quote,
        ))
    });
    let restore = case.archived.as_ref().map(|rows| {
        let archived: Vec<ClientKey> = rows.iter().map(|s| parse_key(s)).collect();
        sorted_key_strs(&restore_marks(&q, &out, &archived))
    });
    Expected {
        keys: sorted_key_strs(&out.keys),
        keys_for_settle,
        keys_for_replace,
        restore_marks: restore,
    }
}

fn inputs() -> Fixture {
    let crossed = |rows: &[(u32, u64)]| {
        rows.iter()
            .map(|(t, o)| CrossedIn {
                tick: *t,
                open_lots: *o,
            })
            .collect()
    };
    let quoted = |is_bid, limit, start, qty, filled, rows: &[(u32, u64)]| QuotedIn {
        market: 0,
        is_bid,
        limit_tick: limit,
        start_tick: start,
        qty,
        crossed: crossed(rows),
        filled_lots: filled,
    };
    let opts = |pad_end| Options { pad_end };
    let cases = vec![
        Case {
            name: "multi_cross".into(),
            quoted: quoted(true, 20, 10, 8, 8, &[(10, 5), (11, 2), (12, 1)]),
            options: opts(12),
            settle: Some(SettleIn {
                is_bid: true,
                tick: 20,
            }),
            replace: Some(ReplaceIn {
                old_is_bid: true,
                old_tick: 20,
                new_is_bid: false,
                new_tick: 22,
            }),
            archived: Some(vec![
                "Level(0,false,10)".into(),
                "Level(0,false,11)".into(),
                "Level(0,false,99)".into(),
                "Level(0,true,20)".into(),
            ]),
            expected: empty_expected(),
        },
        Case {
            name: "word_boundary".into(),
            quoted: quoted(true, 2100, 2040, 2, 0, &[(2048, 3)]),
            options: opts(2060),
            settle: None,
            replace: None,
            archived: None,
            expected: empty_expected(),
        },
        Case {
            name: "wide_band".into(),
            quoted: quoted(true, 250, 100, 1, 0, &[(100, 1)]),
            options: opts(249),
            settle: None,
            replace: None,
            archived: None,
            expected: empty_expected(),
        },
        Case {
            name: "ask_side".into(),
            quoted: quoted(false, 40, 50, 3, 1, &[(50, 2), (48, 1)]),
            options: opts(35),
            settle: Some(SettleIn {
                is_bid: false,
                tick: 40,
            }),
            replace: Some(ReplaceIn {
                old_is_bid: false,
                old_tick: 40,
                new_is_bid: false,
                new_tick: 38,
            }),
            archived: Some(vec![
                "Level(0,true,50)".into(),
                "Level(0,false,40)".into(),
                "Level(0,true,99)".into(),
            ]),
            expected: empty_expected(),
        },
        Case {
            name: "start_eq_pad_end".into(),
            quoted: quoted(true, 20, 15, 1, 0, &[]),
            options: opts(15),
            settle: None,
            replace: None,
            archived: None,
            expected: empty_expected(),
        },
    ];
    Fixture {
        taker: hex32(&TAKER),
        nonce: NONCE,
        base: hex32(&BASE),
        quote: hex32(&QUOTE),
        note: NOTE.into(),
        cases,
    }
}

fn empty_expected() -> Expected {
    Expected {
        keys: vec![],
        keys_for_settle: None,
        keys_for_replace: None,
        restore_marks: None,
    }
}

#[test]
#[ignore]
fn regen_pad_conformance() {
    let mut fx = inputs();
    for case in &mut fx.cases {
        case.expected = compute(case, TAKER, NONCE, BASE, QUOTE);
    }
    let path = fixture_path();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let body = serde_json::to_string_pretty(&fx).unwrap() + "\n";
    std::fs::write(&path, body).unwrap();
}

#[test]
fn pad_conformance_matches_frozen_fixture() {
    let raw = std::fs::read_to_string(fixture_path()).expect("pad-conformance.json");
    let fx: Fixture = serde_json::from_str(&raw).expect("fixture json");
    let taker = parse_hex32(&fx.taker);
    let base = parse_hex32(&fx.base);
    let quote = parse_hex32(&fx.quote);
    let expected_names: Vec<String> = inputs().cases.iter().map(|c| c.name.clone()).collect();
    let names: Vec<String> = fx.cases.iter().map(|c| c.name.clone()).collect();
    assert_eq!(
        names, expected_names,
        "fixture case list drifted from inputs()"
    );
    for case in &fx.cases {
        let got = compute(case, taker, fx.nonce, base, quote);
        assert_eq!(got, case.expected, "case {}", case.name);
        for k in &case.expected.keys {
            assert!(
                !k.starts_with("LevelPage"),
                "case {} declares a page key {k}",
                case.name
            );
        }
    }
}
