# brain-mono

Multi-language monorepo for personal projects. All SDLC tooling is pinned,
checksummed, and distributed via [DotSlash](https://dotslash-cli.com) files
under `bin/`.

Each language directory is a **workspace root** that supports multiple
sub-projects using native monorepo semantics:

| Language   | Workspace type    | Sub-project location | Add a new project                        |
|------------|-------------------|----------------------|------------------------------------------|
| Python     | uv workspace      | `py/packages/*`      | `cd py && ../bin/uv init packages/NAME`  |
| TypeScript | npm workspaces    | `ts/packages/*`      | `mkdir ts/packages/NAME && cd ts/packages/NAME && npm init` |
| Go         | go.work           | `go/*/`              | `mkdir go/NAME && cd go/NAME && ../../bin/go mod init ...` then `go work use ./NAME` |
| Rust       | cargo workspace   | `rust/crates/*`      | `cargo new rust/crates/NAME`             |
| Pi         | package collection | `pi/packages/*`     | `mkdir -p pi/packages/NAME/{extensions,skills,prompts}` |

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
bin/                DotSlash wrappers for all tooling
├── just            just 1.49.0
├── uv              uv 0.11.6
├── node            Node.js 22.22.2 LTS
├── npm, npx        shell wrappers delegating to dotslash node's bundled npm
├── go              Go 1.26.2
└── rustup-init     rustup 1.28.2

py/                 Python workspace (uv)
├── pyproject.toml  workspace root config (ruff, pytest, workspace members)
└── packages/
    └── hello-py/   example package

ts/                 TypeScript workspace (npm)
├── package.json    workspace root with npm workspaces
├── tsconfig.json   project-references root
└── packages/
    └── hello-ts/   example package

go/                 Go workspace
├── go.work         go.work listing all modules
├── dast/           DAST CLI with a checks subpackage
├── gorun/          single-file Go script runner
└── hello-go/       example module

rust/               Rust workspace (cargo)
├── Cargo.toml      workspace root
└── crates/
    └── hello-rust/ example crate

pi/                 Pi resource packages
├── README.md       usage and organization guidance
└── packages/
    └── brain-pi-kit/
        ├── extensions/
        ├── prompts/
        └── skills/
```

## Quick start

```bash
# List all available tasks
./bin/just

# Run a specific language's hello-world
./bin/just py-run
./bin/just ts-run
./bin/just go-run
./bin/just dast-run target=https://example.com
./bin/just rust-run

# Install / sync dependencies
./bin/just py-sync       # uv sync --all-packages
./bin/just ts-install    # npm install (workspace-aware)

# Inspect the starter pi package
ls pi/packages/brain-pi-kit

# Lint all workspaces
./bin/just lint-all

# Test all workspaces
./bin/just test-all

# Build all workspaces
./bin/just build-all
```

## Pi references

- [pi-coding-agent extension examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions)
- [pi-skills](https://github.com/badlogic/pi-skills)
- [pi-coding-agent SDK session runtime example (`13-session-runtime.ts`)](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/sdk/13-session-runtime.ts)

## Tool versions (pinned in `bin/`)

| Tool | Version | DotSlash file |
|------|---------|---------------|
| just | 1.49.0 | `bin/just` |
| uv | 0.11.6 | `bin/uv` |
| Node.js | 22.22.2 LTS | `bin/node` |
| Go | 1.26.2 | `bin/go` |
| rustup | 1.28.2 | `bin/rustup-init` |
