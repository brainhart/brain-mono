# brain-mono — multi-language monorepo
# Run recipes with: ./bin/just <recipe>

# Default: list available recipes
default:
    @./bin/just --list

# ── Python (uv workspace) ─────────────────────────────────

# Sync the entire Python workspace
py-sync:
    cd py && ../bin/uv sync --all-packages

# Run a specific Python package (default: hello-py)
py-run package="hello-py":
    cd py && ../bin/uv run --package {{package}} {{package}}

# Lint the entire Python workspace with ruff
py-lint:
    cd py && ../bin/uv run ruff check .

# Format the entire Python workspace with ruff
py-fmt:
    cd py && ../bin/uv run ruff format .

# Test the entire Python workspace with pytest
py-test:
    cd py && ../bin/uv run pytest

# ── TypeScript (npm workspaces) ────────────────────────────

# Install all TypeScript workspace dependencies
ts-install:
    cd ts && ../bin/npm install

# Build the entire TypeScript workspace
ts-build:
    cd ts && ../bin/npm run build

# Run a specific TypeScript package (default: hello-ts)
ts-run package="hello-ts": ts-build
    cd ts && ../bin/node packages/{{package}}/dist/index.js

# Lint the entire TypeScript workspace
ts-lint:
    cd ts && ../bin/npm run lint

# Test the entire TypeScript workspace
ts-test: ts-build
    cd ts && ../bin/npm test

# ── Go (go.work workspace) ─────────────────────────────────

# Build all Go workspace modules (outputs to go/bin/)
go-build:
    cd go && mkdir -p bin && for d in */go.mod; do dir="${d%/go.mod}"; ../bin/go build -o "bin/$dir" "./$dir"; done

# Run a specific Go module (default: hello-go)
go-run module="hello-go":
    cd go && ../bin/go run ./{{module}}

# Lint the entire Go workspace with go vet
go-lint:
    cd go && for d in */go.mod; do ../bin/go vet "./${d%/go.mod}/..."; done

# Test the entire Go workspace
go-test:
    cd go && for d in */go.mod; do ../bin/go test "./${d%/go.mod}/..."; done

# ── Rust (cargo workspace) ─────────────────────────────────

# Build the entire Rust workspace
rust-build:
    cd rust && cargo build --workspace

# Run a specific Rust crate (default: hello-rust)
rust-run crate="hello-rust":
    cd rust && cargo run --package {{crate}}

# Lint the entire Rust workspace with clippy
rust-lint:
    cd rust && cargo clippy --workspace -- -D warnings

# Format the entire Rust workspace
rust-fmt:
    cd rust && cargo fmt --all

# Test the entire Rust workspace
rust-test:
    cd rust && cargo test --workspace

# ── Cross-cutting ──────────────────────────────────────────

# Lint all workspaces
lint-all: py-lint ts-lint go-lint rust-lint

# Test all workspaces
test-all: py-test ts-test go-test rust-test

# Build all workspaces
build-all: ts-build go-build rust-build
