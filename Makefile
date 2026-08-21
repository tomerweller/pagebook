.PHONY: build test fmt lint web-build web-test

build:
	stellar contract build

test:
	cargo test

fmt:
	cargo fmt --all

lint:
	cargo fmt --all -- --check
	cargo clippy --all-targets -- -D warnings

web-build:
	npm --prefix clients/web ci
	npm --prefix clients/web run build

web-test:
	npm --prefix clients/web test
