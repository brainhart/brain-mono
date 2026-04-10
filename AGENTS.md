# AGENTS.md

## Cursor Cloud specific instructions

This is a multi-language monorepo. All tooling is managed via
[DotSlash](https://dotslash-cli.com) files under `bin/`. The only
system-level dependency is `dotslash` itself — everything else is
fetched and cached on first invocation.

### Running tasks

Use `./bin/just <recipe>` from the repo root. Run `./bin/just` (no args)
to list all available recipes. See the `justfile` for the full list.

### Language-specific notes

- **Python** — managed by `./bin/uv`. Run `./bin/just py-sync` to install
  deps. The virtualenv lives at `py/.venv/`. Lint with ruff, test with pytest.
- **TypeScript** — managed by `./bin/npm`. Run `./bin/just ts-install` to
  install deps. Build produces `ts/dist/`. Lint with eslint.
- **Go** — uses the dotslash-managed `./bin/go`. No extra install step needed.
  Lint with `go vet`.
- **Rust** — uses the system `cargo`/`rustc` installed via `rustup`. The
  dotslash `bin/rustup-init` can bootstrap a fresh Rust toolchain if needed
  (`./bin/rustup-init -y --no-modify-path`). Lint with clippy.

### Gotchas

- Always invoke tools through `./bin/` wrappers (or via justfile recipes) to
  use the pinned versions — do **not** rely on system-installed `node`, `go`,
  `uv`, etc.
- `bin/npm` and `bin/npx` are shell scripts (not dotslash files) that locate
  the npm bundled inside the dotslash-managed Node.js extraction.
- The Go dotslash file sets `GOROOT` implicitly (the Go binary finds its own
  SDK in the extracted archive). If you need `GOROOT` explicitly, resolve the
  real binary path: `$(./bin/go env GOROOT)`.
- Rust lint uses `cargo clippy -- -D warnings` which treats all warnings as
  errors.
