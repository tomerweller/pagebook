# Frozen measurement instruments

`decompose.py` and `analyze.py` produced the measurements recorded in
ADR-025 through ADR-028; their logs and the checked-in size sweeps are the
provenance for those numbers. They import `tools/soak/soak.py` and
`tools/stress/stress.py` via hardcoded paths, which is why those two files
stay in place, frozen. Do not edit any of the three; re-measure with new
tooling under `clients/web/ops/` instead.
