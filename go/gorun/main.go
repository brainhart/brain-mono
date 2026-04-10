package main

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

const goBinaryEnvVar = "GORUN_GO_BINARY"

// lockFile acquires a flock on path. Pass syscall.LOCK_EX for exclusive or
// syscall.LOCK_SH for shared. Returns an unlock function.
func lockFile(path string, how int) (unlock func(), err error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("creating lock dir: %w", err)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDONLY, 0o644)
	if err != nil {
		return nil, fmt.Errorf("opening lock file: %w", err)
	}
	if err := syscall.Flock(int(f.Fd()), how); err != nil {
		f.Close()
		return nil, fmt.Errorf("flock: %w", err)
	}
	return func() {
		syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		f.Close()
	}, nil
}

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	// Subcommand dispatch
	switch os.Args[1] {
	case "help", "-h", "--help":
		printUsage()
		os.Exit(0)
	case "lock":
		cmdLock()
		return
	}

	// Default: run the script
	cmdRun()
}

func printUsage() {
	fmt.Fprintf(os.Stderr, `gorun — run single-file Go scripts with automatic dependency management

Usage:
  gorun <script.go> [arguments...]    Run a Go script
  gorun lock <script.go>              Resolve deps and write a lockfile sidecar
  gorun help                          Show this help message

Script directives (comment lines at the top of your .go file):
  // go <version>                     Set the Go language version (e.g. // go 1.23)
  // dep require <module> <version>   Declare a module dependency
  // sum sha256:<hex>                 Lockfile integrity hash (managed by 'gorun lock')

Environment:
  GORUN_GO_BINARY                     Override the Go binary used for 'go build'
                                      and 'go mod tidy' (default: go)

Shebang support:
  Add one of these lines as the first line of your script to make it
  directly executable (after chmod +x):

    #!/usr/bin/env gorun
    ///usr/bin/env gorun "$0" "$@"; exit $?

  The first form works on most systems. The second form is a polyglot that
  is both a valid shell command and a valid Go comment, so the script remains
  valid Go source that editors and go vet can process without complaint.

Examples:
  gorun my_script.go
  gorun my_script.go --flag arg1 arg2
  gorun lock my_script.go
  chmod +x my_script.go && ./my_script.go    (with shebang)

Scripts are compiled once and cached in ~/.cache/gorun under content-hashed
directories, so identical source always hits cache and different scripts
(or versions) never collide — even when run concurrently.
`)
}

// cmdLock resolves dependencies and writes the sidecar + updates the script's // sum.
func cmdLock() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "usage: gorun lock <script.go>\n")
		os.Exit(1)
	}

	script := loadScript(os.Args[2])

	if len(script.Deps) == 0 {
		fmt.Fprintf(os.Stderr, "gorun: no deps to lock in %s\n", script.Path)
		os.Exit(0)
	}

	// Resolve deps via go mod tidy in a temp dir
	tmpDir, err := os.MkdirTemp("", "gorun-lock-*")
	if err != nil {
		fatal("creating temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	if err := writeModuleFiles(tmpDir, script); err != nil {
		fatal("writing module files: %v", err)
	}

	if err := runCmd(tmpDir, goBinary(), "mod", "tidy"); err != nil {
		fatal("go mod tidy: %v", err)
	}

	// Read the resolved go.sum
	goSumContent, err := os.ReadFile(filepath.Join(tmpDir, "go.sum"))
	if err != nil {
		fatal("reading go.sum: %v", err)
	}

	// Write sidecar and update script
	if err := script.WriteSidecar(string(goSumContent)); err != nil {
		fatal("writing sidecar: %v", err)
	}

	if err := script.WriteScript(); err != nil {
		fatal("writing script: %v", err)
	}

	fmt.Fprintf(os.Stderr, "gorun: locked %s\n", filepath.Base(script.Path))
	fmt.Fprintf(os.Stderr, "  sidecar: %s\n", script.SidecarPath())
	fmt.Fprintf(os.Stderr, "  %s\n", script.SumHash)
}

// cmdRun builds and executes the script.
func cmdRun() {
	script := loadScript(os.Args[1])

	// Verify sidecar integrity if locked
	if warning, err := script.VerifySidecar(); err != nil {
		fatal("%v", err)
	} else if warning != "" {
		fmt.Fprintf(os.Stderr, "gorun: warning: %s\n", warning)
	}

	cleanSrc := script.CleanSource()
	deps := script.DepStrings()

	// Hash deps for shared module cache, code for binary cache
	depsKey := strings.Join(deps, "\n")
	if script.SumHash != "" {
		// Include sum hash in deps key so locked vs unlocked get separate caches
		depsKey += "\n" + script.SumHash
	}
	depsHash := hash(depsKey)
	codeHash := hash(cleanSrc)

	homeDir, err := os.UserHomeDir()
	if err != nil {
		fatal("getting home dir: %v", err)
	}
	cacheRoot := filepath.Join(homeDir, ".cache", "gorun")
	modDir := filepath.Join(cacheRoot, "mod", depsHash)
	buildDir := filepath.Join(cacheRoot, "build", codeHash)
	binPath := filepath.Join(cacheRoot, "bin", codeHash)

	// Fast path: compiled binary exists, just exec it
	if _, err := os.Stat(binPath); err == nil {
		execBin(binPath)
	}

	flockPath := modDir + ".lock"

	// Ensure shared module is set up (exclusive lock)
	if _, err := os.Stat(filepath.Join(modDir, ".ready")); os.IsNotExist(err) {
		unlock, err := lockFile(flockPath, syscall.LOCK_EX)
		if err != nil {
			fatal("acquiring exclusive lock: %v", err)
		}
		// Double-check after acquiring lock — another process may have finished setup
		if _, err := os.Stat(filepath.Join(modDir, ".ready")); os.IsNotExist(err) {
			if err := setupModule(modDir, script); err != nil {
				unlock()
				fatal("setup module: %v", err)
			}
		}
		unlock()
	}

	// Build in an isolated per-code-hash dir (shared lock protects modDir reads)
	unlock, err := lockFile(flockPath, syscall.LOCK_SH)
	if err != nil {
		fatal("acquiring shared lock: %v", err)
	}
	if err := prepareBuildDir(buildDir, modDir, cleanSrc); err != nil {
		unlock()
		fatal("preparing build dir: %v", err)
	}
	unlock()

	if err := os.MkdirAll(filepath.Join(cacheRoot, "bin"), 0o755); err != nil {
		fatal("creating bin dir: %v", err)
	}

	if err := runCmd(buildDir, goBinary(), "build", "-o", binPath, "main.go"); err != nil {
		fatal("go build: %v", err)
	}

	execBin(binPath)
}

// loadScript reads and parses a script file.
func loadScript(arg string) *Script {
	scriptPath, err := filepath.Abs(arg)
	if err != nil {
		fatal("resolving path: %v", err)
	}

	src, err := os.ReadFile(scriptPath)
	if err != nil {
		fatal("reading script: %v", err)
	}

	script, err := ParseScript(scriptPath, string(src))
	if err != nil {
		fatal("parsing script: %v", err)
	}

	return script
}

func execBin(binPath string) {
	args := append([]string{binPath}, os.Args[2:]...)
	if err := syscall.Exec(binPath, args, os.Environ()); err != nil {
		fatal("exec: %v", err)
	}
}

// writeModuleFiles sets up a Go module directory from a Script for go mod tidy.
func writeModuleFiles(dir string, s *Script) error {
	// Write source (needed for go mod tidy to resolve imports)
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte(s.CleanSource()), 0o644); err != nil {
		return fmt.Errorf("writing main.go: %w", err)
	}

	// Write go.mod
	var mod strings.Builder
	mod.WriteString("module gorun-script\n\n")
	if s.GoVersion != "" {
		mod.WriteString("go ")
		mod.WriteString(s.GoVersion)
		mod.WriteString("\n\n")
	}
	for _, dep := range s.DepStrings() {
		mod.WriteString(dep)
		mod.WriteString("\n")
	}

	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte(mod.String()), 0o644); err != nil {
		return fmt.Errorf("writing go.mod: %w", err)
	}

	return nil
}

// setupModule creates the shared module dir atomically using a temp dir + rename.
func setupModule(modDir string, s *Script) error {
	if err := os.MkdirAll(filepath.Dir(modDir), 0o755); err != nil {
		return fmt.Errorf("creating mod parent dir: %w", err)
	}
	tmpDir, err := os.MkdirTemp(filepath.Dir(modDir), ".tmp-mod-*")
	if err != nil {
		return fmt.Errorf("creating temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir) // clean up on failure

	if err := writeModuleFiles(tmpDir, s); err != nil {
		return fmt.Errorf("writing module files: %w", err)
	}

	// If locked, copy sidecar as go.sum so go mod tidy validates against it
	if s.IsLocked() {
		sidecar, err := s.ReadSidecar()
		if err != nil {
			return fmt.Errorf("reading sidecar: %w", err)
		}
		if sidecar != "" {
			if err := os.WriteFile(filepath.Join(tmpDir, "go.sum"), []byte(sidecar), 0o644); err != nil {
				return fmt.Errorf("writing go.sum from sidecar: %w", err)
			}
		}
	}

	if err := runCmd(tmpDir, goBinary(), "mod", "tidy"); err != nil {
		return fmt.Errorf("go mod tidy: %w", err)
	}

	// Write sentinel
	if err := os.WriteFile(filepath.Join(tmpDir, ".ready"), []byte("ok"), 0o644); err != nil {
		return fmt.Errorf("writing sentinel: %w", err)
	}

	// Atomically swap into place
	staleDir := modDir + ".stale"
	if err := os.RemoveAll(staleDir); err != nil {
		return fmt.Errorf("removing stale dir: %w", err)
	}
	if err := os.Rename(modDir, staleDir); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("rename old modDir: %w", err)
	}
	if err := os.Rename(tmpDir, modDir); err != nil {
		os.Rename(staleDir, modDir)
		return fmt.Errorf("rename to modDir: %w", err)
	}
	os.RemoveAll(staleDir)

	return nil
}

// prepareBuildDir sets up an isolated build directory with the script source
// and copies of go.mod/go.sum from the shared module dir.
func prepareBuildDir(buildDir, modDir, cleanSrc string) error {
	if err := os.MkdirAll(buildDir, 0o755); err != nil {
		return fmt.Errorf("creating build dir: %w", err)
	}

	if err := os.WriteFile(filepath.Join(buildDir, "main.go"), []byte(cleanSrc), 0o644); err != nil {
		return fmt.Errorf("writing main.go: %w", err)
	}

	for _, name := range []string{"go.mod", "go.sum"} {
		src := filepath.Join(modDir, name)
		dst := filepath.Join(buildDir, name)
		data, err := os.ReadFile(src)
		if err != nil {
			if os.IsNotExist(err) && name == "go.sum" {
				continue // go.sum may not exist for stdlib-only scripts
			}
			return fmt.Errorf("reading %s: %w", name, err)
		}
		if err := os.WriteFile(dst, data, 0o644); err != nil {
			return fmt.Errorf("writing %s: %w", name, err)
		}
	}

	return nil
}

func runCmd(dir string, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func goBinary() string {
	if path := strings.TrimSpace(os.Getenv(goBinaryEnvVar)); path != "" {
		return path
	}
	return "go"
}

func hash(s string) string {
	h := sha256.Sum256([]byte(s))
	return base64.RawURLEncoding.EncodeToString(h[:])
}

func isShebang(line string) bool {
	return strings.HasPrefix(line, "#!") ||
		strings.HasPrefix(line, "///usr/bin/env") ||
		strings.HasPrefix(line, "//usr/bin/env")
}

func fatal(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "gorun: "+format+"\n", args...)
	os.Exit(1)
}
