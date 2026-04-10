package main

import "testing"

func TestGoBinaryDefault(t *testing.T) {
	t.Setenv(goBinaryEnvVar, "")

	if got := goBinary(); got != "go" {
		t.Fatalf("goBinary() = %q, want %q", got, "go")
	}
}

func TestGoBinaryOverride(t *testing.T) {
	t.Setenv(goBinaryEnvVar, "/custom/go")

	if got := goBinary(); got != "/custom/go" {
		t.Fatalf("goBinary() = %q, want %q", got, "/custom/go")
	}
}
