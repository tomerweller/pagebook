use crate::math::taker_fee;

#[test]
fn split_form_matches_ceil() {
    let env = super::env();
    for output in [0i128, 1, 99, 10_000, 10_001, 99_999, 1_000_000, 12_345_678] {
        for bps in [0u32, 1, 10, 25, 100, 1000] {
            let split = taker_fee(&env, output, bps);
            let naive_num = output * i128::from(bps);
            let ceil = (naive_num + 9_999) / 10_000;
            assert_eq!(split, ceil, "output={output} bps={bps}");
            assert!(split <= output);
        }
    }
}

#[test]
fn split_never_exceeds_output() {
    let env = super::env();
    let fee = taker_fee(&env, 7, 1000);
    assert!(fee <= 7);
}
