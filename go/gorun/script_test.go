package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseAndRoundTrip(t *testing.T) {
	input := `///usr/bin/env gorun "$0" "$@"; exit $?
// dep require github.com/fatih/color v1.18.0

package main

import "fmt"

func main() {
	fmt.Println("hello")
}
`
	s, err := ParseScript("/tmp/test.go", input)
	if err != nil {
		t.Fatal(err)
	}

	if s.Shebang != `///usr/bin/env gorun "$0" "$@"; exit $?` {
		t.Errorf("shebang = %q", s.Shebang)
	}
	if len(s.Deps) != 1 || s.Deps[0].Module != "github.com/fatih/color" || s.Deps[0].Version != "v1.18.0" {
		t.Errorf("deps = %+v", s.Deps)
	}
	if s.GoVersion != "" {
		t.Errorf("go version = %q", s.GoVersion)
	}
	if s.SumHash != "" {
		t.Errorf("sum hash = %q", s.SumHash)
	}

	got := s.String()
	if got != input {
		t.Errorf("round-trip mismatch:\n--- got ---\n%s\n--- want ---\n%s", got, input)
	}
}

func TestParseWithGoVersion(t *testing.T) {
	input := `#!/usr/bin/env gorun
// go 1.23
// dep require github.com/fatih/color v1.18.0

package main

func main() {}
`
	s, err := ParseScript("/tmp/test.go", input)
	if err != nil {
		t.Fatal(err)
	}

	if s.GoVersion != "1.23" {
		t.Errorf("go version = %q, want 1.23", s.GoVersion)
	}
	if len(s.Deps) != 1 {
		t.Errorf("deps = %+v", s.Deps)
	}

	got := s.String()
	if got != input {
		t.Errorf("round-trip mismatch:\n--- got ---\n%s\n--- want ---\n%s", got, input)
	}
}

func TestParseWithSum(t *testing.T) {
	input := `#!/usr/bin/env gorun
// dep require github.com/fatih/color v1.18.0
// sum sha256:abcdef1234567890

package main

func main() {}
`
	s, err := ParseScript("/tmp/test.go", input)
	if err != nil {
		t.Fatal(err)
	}

	if s.SumHash != "sha256:abcdef1234567890" {
		t.Errorf("sum hash = %q", s.SumHash)
	}
	if !s.IsLocked() {
		t.Error("expected IsLocked() = true")
	}

	got := s.String()
	if got != input {
		t.Errorf("round-trip mismatch:\n--- got ---\n%s\n--- want ---\n%s", got, input)
	}
}

func TestParseWithAllDirectives(t *testing.T) {
	input := `///usr/bin/env gorun "$0" "$@"; exit $?
// go 1.23
// dep require github.com/fatih/color v1.18.0
// sum sha256:abc123

package main

func main() {}
`
	s, err := ParseScript("/tmp/test.go", input)
	if err != nil {
		t.Fatal(err)
	}

	if s.GoVersion != "1.23" {
		t.Errorf("go version = %q", s.GoVersion)
	}
	if len(s.Deps) != 1 {
		t.Errorf("deps = %+v", s.Deps)
	}
	if s.SumHash != "sha256:abc123" {
		t.Errorf("sum hash = %q", s.SumHash)
	}

	got := s.String()
	if got != input {
		t.Errorf("round-trip mismatch:\n--- got ---\n%s\n--- want ---\n%s", got, input)
	}
}

func TestCanonicalizesSortAndDedup(t *testing.T) {
	input := `///usr/bin/env gorun "$0" "$@"; exit $?
// dep require github.com/z/z v1.0.0
// dep require github.com/a/a v2.0.0
// dep require github.com/a/a v2.0.0

package main

func main() {}
`
	s, err := ParseScript("/tmp/test.go", input)
	if err != nil {
		t.Fatal(err)
	}

	if len(s.Deps) != 2 {
		t.Fatalf("expected 2 deps, got %d", len(s.Deps))
	}
	if s.Deps[0].Module != "github.com/a/a" {
		t.Errorf("first dep = %s, want github.com/a/a", s.Deps[0].Module)
	}
	if s.Deps[1].Module != "github.com/z/z" {
		t.Errorf("second dep = %s, want github.com/z/z", s.Deps[1].Module)
	}
}

func TestNoDirectives(t *testing.T) {
	input := `package main

func main() {}
`
	s, err := ParseScript("/tmp/test.go", input)
	if err != nil {
		t.Fatal(err)
	}

	if s.IsLocked() {
		t.Error("expected IsLocked() = false")
	}

	got := s.String()
	if got != input {
		t.Errorf("round-trip mismatch:\n--- got ---\n%s\n--- want ---\n%s", got, input)
	}
}

func TestScatteredDepsGetCanonicalized(t *testing.T) {
	input := `///usr/bin/env gorun "$0" "$@"; exit $?

package main

// dep require github.com/fatih/color v1.18.0

import "fmt"

// dep require github.com/z/z v1.0.0

func main() {
	fmt.Println("hello")
}
`
	s, err := ParseScript("/tmp/test.go", input)
	if err != nil {
		t.Fatal(err)
	}

	want := `///usr/bin/env gorun "$0" "$@"; exit $?
// dep require github.com/fatih/color v1.18.0
// dep require github.com/z/z v1.0.0

package main

import "fmt"

func main() {
	fmt.Println("hello")
}
`
	got := s.String()
	if got != want {
		t.Errorf("canonical mismatch:\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

func TestCleanSource(t *testing.T) {
	input := `///usr/bin/env gorun "$0" "$@"; exit $?
// go 1.23
// dep require github.com/fatih/color v1.18.0
// sum sha256:abc123

package main

func main() {}
`
	s, err := ParseScript("/tmp/test.go", input)
	if err != nil {
		t.Fatal(err)
	}

	want := `package main

func main() {}
`
	got := s.CleanSource()
	if got != want {
		t.Errorf("clean source mismatch:\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

func TestHashSum(t *testing.T) {
	content := "some go.sum content\n"
	h := HashSum(content)
	if h[:7] != "sha256:" {
		t.Errorf("expected sha256: prefix, got %q", h)
	}
	// Same input produces same hash
	if HashSum(content) != h {
		t.Error("HashSum not deterministic")
	}
	// Different input produces different hash
	if HashSum("different") == h {
		t.Error("different content should produce different hash")
	}
}

func TestSidecarPath(t *testing.T) {
	s := &Script{Path: "/home/user/scripts/deploy.go"}
	if s.SidecarPath() != "/home/user/scripts/deploy.go.sum" {
		t.Errorf("sidecar path = %q", s.SidecarPath())
	}
}

func TestVerifySidecar(t *testing.T) {
	tmpDir := t.TempDir()
	scriptPath := filepath.Join(tmpDir, "test.go")

	// Unlocked, no sidecar — should pass with no warning
	s := &Script{Path: scriptPath}
	warning, err := s.VerifySidecar()
	if err != nil {
		t.Errorf("unlocked should pass: %v", err)
	}
	if warning != "" {
		t.Errorf("unlocked without sidecar should not warn, got: %s", warning)
	}

	// Locked but no sidecar — should fail
	s.SumHash = "sha256:abc123"
	_, err = s.VerifySidecar()
	if err == nil {
		t.Error("locked without sidecar should fail")
	}

	// Locked with matching sidecar — should pass
	goSumContent := "example go.sum content\n"
	s.SumHash = HashSum(goSumContent)
	if err := os.WriteFile(s.SidecarPath(), []byte(goSumContent), 0o644); err != nil {
		t.Fatal(err)
	}
	warning, err = s.VerifySidecar()
	if err != nil {
		t.Errorf("matching sidecar should pass: %v", err)
	}
	if warning != "" {
		t.Errorf("matching sidecar should not warn, got: %s", warning)
	}

	// Locked with mismatched sidecar — should fail
	if err := os.WriteFile(s.SidecarPath(), []byte("tampered content\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err = s.VerifySidecar()
	if err == nil {
		t.Error("mismatched sidecar should fail")
	}
}

func TestDuplicateSumDirective(t *testing.T) {
	input := `// sum sha256:abc
// sum sha256:def

package main
`
	_, err := ParseScript("/tmp/test.go", input)
	if err == nil {
		t.Error("expected error for duplicate // sum")
	}
}

func TestInvalidSumFormat(t *testing.T) {
	input := `// sum md5:abc

package main
`
	_, err := ParseScript("/tmp/test.go", input)
	if err == nil {
		t.Error("expected error for non-sha256 sum")
	}
}

func TestOrphanedSidecarWarns(t *testing.T) {
	tmpDir := t.TempDir()
	scriptPath := filepath.Join(tmpDir, "test.go")

	// Unlocked script with an orphaned sidecar file on disk
	s := &Script{Path: scriptPath}
	if err := os.WriteFile(s.SidecarPath(), []byte("leftover go.sum\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	warning, err := s.VerifySidecar()
	if err != nil {
		t.Errorf("orphaned sidecar should not error: %v", err)
	}
	if warning == "" {
		t.Error("orphaned sidecar should produce a warning")
	}
	if !strings.Contains(warning, "no // sum directive") {
		t.Errorf("warning should mention missing directive, got: %s", warning)
	}
}

func TestRelockUpdatesCleanly(t *testing.T) {
	tmpDir := t.TempDir()
	scriptPath := filepath.Join(tmpDir, "test.go")

	// Start with a locked script
	original := &Script{
		Path:    scriptPath,
		Shebang: "#!/usr/bin/env gorun",
		Deps:    []Dep{{Module: "github.com/fatih/color", Version: "v1.18.0"}},
		SumHash: "sha256:oldoldhash",
		Body:    "package main\n\nfunc main() {}\n",
	}

	// Write initial script and sidecar
	if err := os.WriteFile(scriptPath, []byte(original.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(original.SidecarPath(), []byte("old go.sum content\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Simulate re-lock: parse the script back, write new sidecar
	src, err := os.ReadFile(scriptPath)
	if err != nil {
		t.Fatal(err)
	}
	reparsed, err := ParseScript(scriptPath, string(src))
	if err != nil {
		t.Fatal(err)
	}

	// Verify old sum was parsed
	if reparsed.SumHash != "sha256:oldoldhash" {
		t.Fatalf("expected old hash, got %q", reparsed.SumHash)
	}

	// Write new sidecar (simulates fresh go mod tidy output)
	newGoSum := "new resolved go.sum content\n"
	if err := reparsed.WriteSidecar(newGoSum); err != nil {
		t.Fatal(err)
	}
	if err := reparsed.WriteScript(); err != nil {
		t.Fatal(err)
	}

	// Verify the updated script
	updatedSrc, err := os.ReadFile(scriptPath)
	if err != nil {
		t.Fatal(err)
	}
	final, err := ParseScript(scriptPath, string(updatedSrc))
	if err != nil {
		t.Fatal(err)
	}

	// Sum should be updated
	expectedHash := HashSum(newGoSum)
	if final.SumHash != expectedHash {
		t.Errorf("sum hash = %q, want %q", final.SumHash, expectedHash)
	}

	// Deps should be preserved
	if len(final.Deps) != 1 || final.Deps[0].Module != "github.com/fatih/color" {
		t.Errorf("deps changed unexpectedly: %+v", final.Deps)
	}

	// Body should be preserved
	if final.Body != original.Body {
		t.Errorf("body changed:\n--- got ---\n%s\n--- want ---\n%s", final.Body, original.Body)
	}

	// Sidecar should verify cleanly
	warning, err := final.VerifySidecar()
	if err != nil {
		t.Errorf("re-locked script should verify: %v", err)
	}
	if warning != "" {
		t.Errorf("unexpected warning: %s", warning)
	}
}

func TestDepsWithoutImports(t *testing.T) {
	// Script declares a dep but doesn't import it
	input := `#!/usr/bin/env gorun
// dep require github.com/fatih/color v1.18.0

package main

import "fmt"

func main() {
	fmt.Println("no color import here")
}
`
	s, err := ParseScript("/tmp/test.go", input)
	if err != nil {
		t.Fatal(err)
	}

	// The dep should be preserved in the parsed struct
	if len(s.Deps) != 1 || s.Deps[0].Module != "github.com/fatih/color" {
		t.Errorf("deps = %+v, want 1 dep for fatih/color", s.Deps)
	}

	// Round-trip should preserve it
	got := s.String()
	if got != input {
		t.Errorf("round-trip mismatch:\n--- got ---\n%s\n--- want ---\n%s", got, input)
	}

	// CleanSource should still produce valid Go that references the dep in go.mod
	// even though the import isn't used — go mod tidy will strip it, but that's
	// the go toolchain's job, not ours
	clean := s.CleanSource()
	if strings.Contains(clean, "// dep") {
		t.Error("clean source should not contain directives")
	}

	// writeModuleFiles should include the dep in go.mod regardless
	tmpDir := t.TempDir()
	if err := writeModuleFiles(tmpDir, s); err != nil {
		t.Fatal(err)
	}

	goMod, err := os.ReadFile(filepath.Join(tmpDir, "go.mod"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(goMod), "github.com/fatih/color") {
		t.Errorf("go.mod should contain the declared dep:\n%s", goMod)
	}
}

func TestDepStrings(t *testing.T) {
	s := &Script{
		Deps: []Dep{
			{Module: "github.com/a/a", Version: "v1.0.0"},
			{Module: "github.com/b/b", Version: "v2.0.0"},
		},
	}
	got := s.DepStrings()
	want := []string{
		"require github.com/a/a v1.0.0",
		"require github.com/b/b v2.0.0",
	}
	if len(got) != len(want) {
		t.Fatalf("len = %d, want %d", len(got), len(want))
	}
	for i := range got {
		if got[i] != want[i] {
			t.Errorf("dep[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}
