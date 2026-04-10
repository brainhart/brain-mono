# gorun

`gorun` runs single-file Go scripts with lightweight dependency directives,
caching, and optional lockfile verification.

## Usage

From the repo root:

```bash
./bin/go run ./go/gorun --help
./bin/go run ./go/gorun ./go/gorun/examples/example_with_dep.go
./bin/go run ./go/gorun lock ./go/gorun/examples/example_with_dep.go
```

## Go binary override

By default, `gorun` shells out to `go` from `PATH` for `go build` and
`go mod tidy`, matching the original gist behavior.

Set `GORUN_GO_BINARY` to override that binary explicitly, for example when you
want to force the repo's pinned wrapper:

```bash
GORUN_GO_BINARY=/workspace/bin/go ./bin/go run ./go/gorun ./go/gorun/examples/example_with_dep.go
```
