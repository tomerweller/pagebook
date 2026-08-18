.PHONY: build test fmt lint

build:
	stellar contract build

test:
	cargo test

fmt:
	cargo fmt --all

lint:
	cargo fmt --all -- --check
	cargo clippy --all-targets -- -D warnings
