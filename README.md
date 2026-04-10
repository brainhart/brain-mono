# brain-mono

Multi-language monorepo for personal projects. All SDLC tooling is pinned,
checksummed, and distributed via [DotSlash](https://dotslash-cli.com) files
under `bin/`.

## Prerequisites

Install [DotSlash](https://dotslash-cli.com/docs/installation) — it is the
**only** binary you need on your system. Everything else (just, uv, node, go,
rustup) is fetched on first use from the dotslash files in `bin/`.

```bash
# Linux
curl -LSfs "https://github.com/facebook/dotslash/releases/latest/download/dotslash-ubuntu-22.04.$(uname -m).tar.gz" \
  | sudo tar fxz - -C /usr/local/bin

# macOS (Homebrew)
brew install dotslash
```

## Repository layout

```
bin/           DotSlash wrappers for all tooling (just, uv, node, npm, npx, go, rustup-init)
py/            Python projects (managed with uv)
ts/            TypeScript projects (managed with npm via dotslash node)
go/            Go projects
rust/          Rust projects (cargo/rustc assumed installed via rustup-init)
justfile       Task runner recipes (use ./bin/just)
```

## Quick start

```bash
# List all available tasks
./bin/just

# Run a specific language's hello-world
./bin/just py-run
./bin/just ts-run
./bin/just go-run
./bin/just rust-run

# Install dependencies
./bin/just py-sync      # Python (uv sync)
./bin/just ts-install   # TypeScript (npm install)

# Lint everything
./bin/just lint-all

# Test everything
./bin/just test-all

# Build everything
./bin/just build-all
```

## Tool versions (pinned in `bin/`)

| Tool | Version | DotSlash file |
|------|---------|---------------|
| just | 1.49.0 | `bin/just` |
| uv | 0.11.6 | `bin/uv` |
| Node.js | 22.22.2 LTS | `bin/node` |
| Go | 1.26.2 | `bin/go` |
| rustup | 1.28.2 | `bin/rustup-init` |

npm and npx are thin shell wrappers (`bin/npm`, `bin/npx`) that delegate to
the npm bundled inside the dotslash-managed Node.js installation.
