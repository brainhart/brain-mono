# brain-mono — multi-language monorepo
# Run recipes with: ./bin/just <recipe>

# Default: list available recipes
default:
    @./bin/just --list

# ── Python (uv) ────────────────────────────────────────────

# Sync Python dependencies
py-sync:
    cd py && ../bin/uv sync

# Run Python project
py-run:
    cd py && ../bin/uv run main.py

# Lint Python with ruff
py-lint:
    cd py && ../bin/uv run ruff check .

# Format Python with ruff
py-fmt:
    cd py && ../bin/uv run ruff format .

# Test Python with pytest
py-test:
    cd py && ../bin/uv run pytest

# ── TypeScript (node) ──────────────────────────────────────

# Install TypeScript dependencies
ts-install:
    cd ts && ../bin/npm install

# Build TypeScript project
ts-build:
    cd ts && ../bin/npm run build

# Run TypeScript project
ts-run: ts-build
    cd ts && ../bin/node dist/main.js

# Lint TypeScript with eslint
ts-lint:
    cd ts && ../bin/npm run lint

# Test TypeScript
ts-test: ts-build
    cd ts && ../bin/npm test

# ── Go ─────────────────────────────────────────────────────

# Build Go project
go-build:
    cd go && ../bin/go build -o hello-go .

# Run Go project
go-run:
    cd go && ../bin/go run .

# Lint Go with go vet
go-lint:
    cd go && ../bin/go vet ./...

# Test Go
go-test:
    cd go && ../bin/go test ./...

# ── Rust ───────────────────────────────────────────────────

# Build Rust project
rust-build:
    cd rust && cargo build

# Run Rust project
rust-run:
    cd rust && cargo run

# Lint Rust with clippy
rust-lint:
    cd rust && cargo clippy -- -D warnings

# Format Rust
rust-fmt:
    cd rust && cargo fmt

# Test Rust
rust-test:
    cd rust && cargo test

# ── Cross-cutting ──────────────────────────────────────────

# Lint all projects
lint-all: py-lint ts-lint go-lint rust-lint

# Test all projects
test-all: py-test ts-test go-test rust-test

# Build all projects
build-all: ts-build go-build rust-build
