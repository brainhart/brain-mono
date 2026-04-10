package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/brain-mono/dast/checks"
)

func main() {
	target := flag.String("target", "", "Target URL to scan (required)")
	authToken := flag.String("auth", "", "Bearer token for authenticated requests (optional)")
	outputFormat := flag.String("format", "text", "Output format: text or json")
	skipChecks := flag.String("skip-checks", "", "Comma-separated list of check IDs to skip (e.g., tls,cors)")
	listChecks := flag.Bool("list-checks", false, "List all available check IDs and exit")
	flag.Parse()

	if *listChecks {
		fmt.Println("Available check IDs:")
		for _, id := range checks.AllCheckIDs() {
			fmt.Printf("  %s\n", id)
		}
		os.Exit(0)
	}

	if *target == "" {
		fmt.Fprintln(os.Stderr, "Error: -target is required")
		fmt.Fprintln(os.Stderr, "Usage: dast -target https://example.com [-auth token] [-format json] [-skip-checks tls,cors]")
		fmt.Fprintln(os.Stderr, "Use -list-checks to see all available check IDs")
		os.Exit(1)
	}

	// Ensure target has a scheme
	if !strings.HasPrefix(*target, "http://") && !strings.HasPrefix(*target, "https://") {
		*target = "https://" + *target
	}

	// Parse skip checks
	var skipCheckIDs []checks.CheckID
	if *skipChecks != "" {
		for _, id := range strings.Split(*skipChecks, ",") {
			id = strings.TrimSpace(id)
			if id != "" {
				skipCheckIDs = append(skipCheckIDs, checks.CheckID(id))
			}
		}
	}

	scanner := checks.NewScannerWithConfig(*target, *authToken, &checks.ScannerConfig{
		SkipChecks: skipCheckIDs,
	})
	result := scanner.RunAll()

	if *outputFormat == "json" {
		outputJSON(result)
	} else {
		outputText(result)
	}

	// Exit with non-zero if high severity findings
	for _, f := range result.Findings {
		if f.Severity == checks.SeverityHigh {
			os.Exit(1)
		}
	}
}

func outputJSON(result checks.Result) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(result)
}

func outputText(result checks.Result) {
	fmt.Printf("DAST Scan Results for: %s\n", result.Target)
	fmt.Println(strings.Repeat("=", 60))

	if len(result.Findings) == 0 {
		fmt.Println("No findings.")
		return
	}

	// Group by severity
	bySeverity := map[checks.Severity][]checks.Finding{
		checks.SeverityHigh:   {},
		checks.SeverityMedium: {},
		checks.SeverityLow:    {},
		checks.SeverityInfo:   {},
	}

	for _, f := range result.Findings {
		bySeverity[f.Severity] = append(bySeverity[f.Severity], f)
	}

	// Print summary
	fmt.Printf("\nSummary: %d HIGH, %d MEDIUM, %d LOW, %d INFO\n\n",
		len(bySeverity[checks.SeverityHigh]),
		len(bySeverity[checks.SeverityMedium]),
		len(bySeverity[checks.SeverityLow]),
		len(bySeverity[checks.SeverityInfo]),
	)

	// Print findings by severity
	for _, sev := range []checks.Severity{checks.SeverityHigh, checks.SeverityMedium, checks.SeverityLow, checks.SeverityInfo} {
		findings := bySeverity[sev]
		if len(findings) == 0 {
			continue
		}

		fmt.Printf("[%s]\n", sev)
		for _, f := range findings {
			fmt.Printf("  - %s\n", f.Title)
			fmt.Printf("    %s\n", f.Description)
			if f.Remediation != "" {
				fmt.Printf("    Fix: %s\n", f.Remediation)
			}
			fmt.Println()
		}
	}
}
