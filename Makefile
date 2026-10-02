.DEFAULT_GOAL := help

NPM ?= npm
GO ?= go
PYTHON ?= python3
HOST ?= 127.0.0.1
PORT ?= 8000
TILECACHE_ADDR ?= 127.0.0.1:8091
BENCH_ADDR ?= 127.0.0.1:9000
BENCH_CACHE ?= /tmp/micromap-bench-cache
PAGES_DIR ?= _site

.PHONY: help setup build test check check-package pack pages serve dev tilecache bench test-tilecache

help: ## List targets and common overrides.
	@awk 'BEGIN { FS = ":.*## " } /^[a-z-]+:.*## / { printf "  %-16s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@printf '\n%s\n' 'Overrides: make serve PORT=9000; make pages PAGES_DIR=/tmp/micromap-site'

setup: ## Install locked development dependencies.
	$(NPM) ci

build: ## Regenerate minified browser bundles.
	$(NPM) run build

test: ## Run Node.js tests.
	$(NPM) test

check: ## Verify bundles, size budgets, tests and installed package.
	$(NPM) run check

check-package: ## Verify tarball contents, imports and browser bundling.
	$(NPM) run check:package

pack: ## Create the npm tarball; builds release bundles first.
	$(NPM) pack

pages: ## Stage the public site into an empty PAGES_DIR.
	$(NPM) run stage:pages -- "$(PAGES_DIR)"

serve: ## Serve the checkout at HOST:PORT (requires Python 3).
	$(PYTHON) -m http.server "$(PORT)" --bind "$(HOST)"

dev: tilecache ## Serve the checkout with the local tile proxy (requires Go).

tilecache: ## Alias for the local tile proxy at TILECACHE_ADDR.
	cd tools/tilecache && $(GO) run . -addr "$(TILECACHE_ADDR)" -static ../..

bench: ## Serve the browser benchmark with a persistent tile cache.
	cd tools/tilecache && $(GO) run . -addr "$(BENCH_ADDR)" -static ../.. -cache "$(BENCH_CACHE)"

test-tilecache: ## Run the local proxy's Go tests.
	cd tools/tilecache && $(GO) test ./...
