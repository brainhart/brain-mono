# AGENTS.md

## Cursor Cloud specific instructions

This is a multi-language monorepo. All tooling is managed via
[DotSlash](https://dotslash-cli.com) files under `bin/`. The only
system-level dependency is `dotslash` itself — everything else is
fetched and cached on first invocation.

### Running tasks

Use `./bin/just <recipe>` from the repo root. Run `./bin/just` (no args)
to list all available recipes. See the `justfile` for the full list.

### Workspace structure

Each language directory is its own workspace root — commands operate on
the entire workspace, not a single project:

- **`py/`** — uv workspace. Members live in `py/packages/*`. The workspace
  root `py/pyproject.toml` defines shared dev deps (ruff, pytest) and
  config. Run `./bin/just py-sync` to install, `py-test` to test all
  packages, `py-lint` to lint all packages.
- **`ts/`** — npm workspaces. Packages live in `ts/packages/*`. Root
  `ts/package.json` defines shared devDependencies and forwards
  build/lint/test to all workspace members. Run `./bin/just ts-install`.
- **`go/`** — Go workspace via `go.work`. Each module is a direct
  subdirectory (e.g. `go/hello-go/`). Add new modules with
  `go work use ./new-module` from `go/`.
- **`rust/`** — Cargo workspace. Crates live in `rust/crates/*`. The
  workspace root `rust/Cargo.toml` has `members = ["crates/*"]`.

### Gotchas

- Always invoke tools through `./bin/` wrappers (or via justfile recipes)
  to use the pinned versions — do **not** rely on system-installed
  `node`, `go`, `uv`, etc.
- `bin/npm` and `bin/npx` are shell scripts (not dotslash files) that
  locate the npm bundled inside the dotslash-managed Node.js extraction.
- The Go dotslash file sets `GOROOT` implicitly (the Go binary finds its
  own SDK in the extracted archive). If you need `GOROOT` explicitly:
  `$(./bin/go env GOROOT)`.
- Go workspace `./...` pattern does NOT work from the workspace root; the
  justfile enumerates modules via `*/go.mod` glob. When adding a new Go
  module, also run `cd go && ../bin/go work use ./new-module`.
- Rust lint uses `cargo clippy --workspace -- -D warnings` (warnings are
  errors).
- TypeScript tests require a build first (`ts-test` depends on `ts-build`).
  If `tsc -b` produces no output despite no errors, delete stale
  `tsconfig.tsbuildinfo` files and rebuild:
  `rm -f ts/packages/*/tsconfig.tsbuildinfo && ./bin/just ts-build`.
