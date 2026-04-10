package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Script is a parsed representation of a gorun script file.
// It separates the header directives (shebang, go version, deps, sum)
// from the body, enabling round-trip editing with a canonical header.
type Script struct {
	Path      string // absolute path to the script file
	Shebang   string // e.g. "#!/usr/bin/env gorun" — empty if none
	GoVersion string // from "// go 1.23" — empty if none
	Deps      []Dep  // sorted, deduplicated
	SumHash   string // from "// sum sha256:<hex>" — empty if unlocked
	Body      string // everything else, with directive lines stripped
}

// Dep is a single module dependency.
type Dep struct {
	Module  string // e.g. "github.com/fatih/color"
	Version string // e.g. "v1.18.0"
}

func (d Dep) String() string {
	return fmt.Sprintf("// dep require %s %s", d.Module, d.Version)
}

// ParseScript parses a gorun script source into its structured parts.
func ParseScript(path, src string) (*Script, error) {
	lines := strings.Split(src, "\n")
	s := &Script{Path: path}

	// Strip shebang
	start := 0
	if len(lines) > 0 && isShebang(lines[0]) {
		s.Shebang = lines[0]
		start = 1
	}

	// Collect directives, pass everything else through to body
	var bodyLines []string
	for i := start; i < len(lines); i++ {
		trimmed := strings.TrimSpace(lines[i])

		if strings.HasPrefix(trimmed, "// dep ") {
			dep, err := parseDep(trimmed)
			if err != nil {
				return nil, fmt.Errorf("line %d: %w", i+1, err)
			}
			s.Deps = append(s.Deps, dep)
			continue
		}

		if strings.HasPrefix(trimmed, "// go ") {
			ver := strings.TrimPrefix(trimmed, "// go ")
			if s.GoVersion != "" {
				return nil, fmt.Errorf("line %d: duplicate // go directive", i+1)
			}
			s.GoVersion = strings.TrimSpace(ver)
			continue
		}

		if strings.HasPrefix(trimmed, "// sum ") {
			val := strings.TrimPrefix(trimmed, "// sum ")
			if s.SumHash != "" {
				return nil, fmt.Errorf("line %d: duplicate // sum directive", i+1)
			}
			if !strings.HasPrefix(val, "sha256:") {
				return nil, fmt.Errorf("line %d: // sum must be sha256:<hex>, got: %q", i+1, val)
			}
			s.SumHash = strings.TrimSpace(val)
			continue
		}

		bodyLines = append(bodyLines, lines[i])
	}

	// Strip leading blank lines from body (we'll add our own separator)
	for len(bodyLines) > 0 && strings.TrimSpace(bodyLines[0]) == "" {
		bodyLines = bodyLines[1:]
	}

	// Collapse runs of blank lines left behind by stripped directives
	var collapsed []string
	prevBlank := false
	for _, line := range bodyLines {
		blank := strings.TrimSpace(line) == ""
		if blank && prevBlank {
			continue
		}
		collapsed = append(collapsed, line)
		prevBlank = blank
	}

	s.Body = strings.Join(collapsed, "\n")

	// Normalize deps
	sort.Slice(s.Deps, func(i, j int) bool {
		return s.Deps[i].Module < s.Deps[j].Module
	})
	s.Deps = dedupDeps(s.Deps)

	return s, nil
}

// String writes the script back in canonical form:
//
//	<shebang>               (if present)
//	// go <version>         (if present)
//	// dep require ...      (sorted)
//	// sum sha256:<hex>     (if locked)
//	                        (blank line)
//	<body>
func (s *Script) String() string {
	var b strings.Builder

	if s.Shebang != "" {
		b.WriteString(s.Shebang)
		b.WriteString("\n")
	}

	hasDirectives := s.GoVersion != "" || len(s.Deps) > 0 || s.SumHash != ""

	if s.GoVersion != "" {
		b.WriteString("// go ")
		b.WriteString(s.GoVersion)
		b.WriteString("\n")
	}

	for _, dep := range s.Deps {
		b.WriteString(dep.String())
		b.WriteString("\n")
	}

	if s.SumHash != "" {
		b.WriteString("// sum ")
		b.WriteString(s.SumHash)
		b.WriteString("\n")
	}

	if hasDirectives {
		b.WriteString("\n")
	}

	b.WriteString(s.Body)

	return b.String()
}

// CleanSource returns the source suitable for go build — no shebang, no directives.
func (s *Script) CleanSource() string {
	return s.Body
}

// DepStrings returns dep lines in go.mod "require" format.
func (s *Script) DepStrings() []string {
	out := make([]string, len(s.Deps))
	for i, d := range s.Deps {
		out[i] = fmt.Sprintf("require %s %s", d.Module, d.Version)
	}
	return out
}

// SidecarPath returns the path to the .sum sidecar file.
func (s *Script) SidecarPath() string {
	return s.Path + ".sum"
}

// IsLocked returns true if the script has a // sum directive.
func (s *Script) IsLocked() bool {
	return s.SumHash != ""
}

// HasSidecar returns true if the .sum sidecar file exists on disk.
func (s *Script) HasSidecar() bool {
	_, err := os.Stat(s.SidecarPath())
	return err == nil
}

// ReadSidecar reads the sidecar file content. Returns empty string if not found.
func (s *Script) ReadSidecar() (string, error) {
	data, err := os.ReadFile(s.SidecarPath())
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return string(data), nil
}

// WriteSidecar writes the sidecar file and updates SumHash to match.
func (s *Script) WriteSidecar(goSumContent string) error {
	s.SumHash = HashSum(goSumContent)
	return os.WriteFile(s.SidecarPath(), []byte(goSumContent), 0o644)
}

// WriteScript writes the script back to its original path in canonical form.
func (s *Script) WriteScript() error {
	return os.WriteFile(s.Path, []byte(s.String()), 0o644)
}

// VerifySidecar checks that the sidecar exists and its hash matches SumHash.
// Returns an error if integrity checks fail. Returns a non-empty warning string
// if the state is suspicious but not fatal (e.g. orphaned sidecar).
func (s *Script) VerifySidecar() (warning string, err error) {
	if !s.IsLocked() {
		if s.HasSidecar() {
			return fmt.Sprintf("sidecar %s exists but script has no // sum directive — consider running 'gorun lock %s'",
				s.SidecarPath(), filepath.Base(s.Path)), nil
		}
		return "", nil
	}

	content, err := s.ReadSidecar()
	if err != nil {
		return "", fmt.Errorf("reading sidecar: %w", err)
	}
	if content == "" {
		return "", fmt.Errorf("script is locked (// sum %s) but sidecar %s not found — run 'gorun lock %s'",
			s.SumHash, s.SidecarPath(), filepath.Base(s.Path))
	}

	actual := HashSum(content)
	if actual != s.SumHash {
		return "", fmt.Errorf("sidecar hash mismatch: script expects %s but sidecar is %s — run 'gorun lock %s'",
			s.SumHash, actual, filepath.Base(s.Path))
	}

	return "", nil
}

// HashSum computes the sha256 hash of go.sum content in the "sha256:<hex>" format.
func HashSum(content string) string {
	h := sha256.Sum256([]byte(content))
	return "sha256:" + hex.EncodeToString(h[:])
}

func parseDep(line string) (Dep, error) {
	// line is like "// dep require github.com/foo/bar v1.2.3"
	rest := strings.TrimPrefix(line, "// dep ")
	parts := strings.Fields(rest)
	if len(parts) != 3 {
		return Dep{}, fmt.Errorf("expected '// dep require <module> <version>', got: %q", line)
	}
	if parts[0] != "require" {
		return Dep{}, fmt.Errorf("expected 'require' keyword, got: %q", parts[0])
	}
	if !strings.HasPrefix(parts[2], "v") {
		return Dep{}, fmt.Errorf("version should start with 'v', got: %q", parts[2])
	}
	return Dep{Module: parts[1], Version: parts[2]}, nil
}

func dedupDeps(sorted []Dep) []Dep {
	if len(sorted) <= 1 {
		return sorted
	}
	result := []Dep{sorted[0]}
	for _, d := range sorted[1:] {
		if d.Module != result[len(result)-1].Module {
			result = append(result, d)
		}
	}
	return result
}
