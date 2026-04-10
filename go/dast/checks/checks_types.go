package checks

import (
	"crypto/tls"
	"net/http"
	"strings"
	"time"
)

// Default timeout values
const (
	DefaultTimeout    = 30 * time.Second
	DefaultTLSTimeout = 10 * time.Second
)

// Severity levels for findings
type Severity string

const (
	SeverityHigh   Severity = "HIGH"
	SeverityMedium Severity = "MEDIUM"
	SeverityLow    Severity = "LOW"
	SeverityInfo   Severity = "INFO"
)

// CheckID represents a unique identifier for a security check
type CheckID string

// Check IDs - use these constants when creating findings or disabling checks
// Parent check IDs (disable all sub-checks in a category)
const (
	CheckSecurityHeaders  CheckID = "security-headers"
	CheckCookies          CheckID = "cookies"
	CheckTLS              CheckID = "tls"
	CheckCORS             CheckID = "cors"
	CheckInfoDisclosure   CheckID = "info-disclosure"
	CheckSensitiveFiles   CheckID = "sensitive-files"
	CheckHTTPSEnforcement CheckID = "https-enforcement"
)

// Security header sub-check IDs
const (
	CheckHeaderHSTS               CheckID = "security-headers/hsts"
	CheckHeaderCSP                CheckID = "security-headers/csp"
	CheckHeaderXContentTypeOpts   CheckID = "security-headers/x-content-type-options"
	CheckHeaderXFrameOpts         CheckID = "security-headers/x-frame-options"
	CheckHeaderReferrerPolicy     CheckID = "security-headers/referrer-policy"
	CheckHeaderPermissionsPolicy  CheckID = "security-headers/permissions-policy"
)

// Cookie sub-check IDs
const (
	CheckCookieSecure   CheckID = "cookies/secure"
	CheckCookieHttpOnly CheckID = "cookies/httponly"
	CheckCookieSameSite CheckID = "cookies/samesite"
)

// TLS sub-check IDs
const (
	CheckTLSVersion     CheckID = "tls/version"
	CheckTLSCertificate CheckID = "tls/certificate"
)

// CORS sub-check IDs
const (
	CheckCORSWildcard   CheckID = "cors/wildcard"
	CheckCORSReflection CheckID = "cors/reflection"
	CheckCORSNull       CheckID = "cors/null-origin"
	CheckCORSMethods    CheckID = "cors/methods"
)

// Info disclosure sub-check IDs
const (
	CheckInfoDisclosureHeaders  CheckID = "info-disclosure/headers"
	CheckInfoDisclosureErrors   CheckID = "info-disclosure/errors"
	CheckInfoDisclosureComments CheckID = "info-disclosure/comments"
)

// AllCheckIDs returns all available check IDs (both parent and sub-checks)
func AllCheckIDs() []CheckID {
	return []CheckID{
		// Parent checks
		CheckSecurityHeaders,
		CheckCookies,
		CheckTLS,
		CheckCORS,
		CheckInfoDisclosure,
		CheckSensitiveFiles,
		CheckHTTPSEnforcement,
		// Security header sub-checks
		CheckHeaderHSTS,
		CheckHeaderCSP,
		CheckHeaderXContentTypeOpts,
		CheckHeaderXFrameOpts,
		CheckHeaderReferrerPolicy,
		CheckHeaderPermissionsPolicy,
		// Cookie sub-checks
		CheckCookieSecure,
		CheckCookieHttpOnly,
		CheckCookieSameSite,
		// TLS sub-checks
		CheckTLSVersion,
		CheckTLSCertificate,
		// CORS sub-checks
		CheckCORSWildcard,
		CheckCORSReflection,
		CheckCORSNull,
		CheckCORSMethods,
		// Info disclosure sub-checks
		CheckInfoDisclosureHeaders,
		CheckInfoDisclosureErrors,
		CheckInfoDisclosureComments,
	}
}

// Finding represents a single security finding
type Finding struct {
	Check       string   `json:"check"`
	Severity    Severity `json:"severity"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Remediation string   `json:"remediation,omitempty"`
}

// Result holds all findings from a scan
type Result struct {
	Target   string    `json:"target"`
	Findings []Finding `json:"findings"`
}

// ScannerConfig holds optional configuration for the scanner
type ScannerConfig struct {
	// HTTPClient allows injecting a custom HTTP client. If nil, a default client is created.
	HTTPClient *http.Client
	// Timeout for HTTP requests. Defaults to 30 seconds if zero.
	Timeout time.Duration
	// TLSTimeout for TLS handshake operations. Defaults to 10 seconds if zero.
	TLSTimeout time.Duration
	// SkipChecks contains check IDs to skip during scanning.
	SkipChecks []CheckID
}

// Scanner holds configuration for running checks
type Scanner struct {
	Target     string
	AuthToken  string
	HTTPClient *http.Client
	Timeout    time.Duration
	TLSTimeout time.Duration
	skipChecks map[CheckID]bool
}

// NewScanner creates a scanner with default settings
func NewScanner(target string, authToken string) *Scanner {
	return NewScannerWithConfig(target, authToken, nil)
}

// NewScannerWithConfig creates a scanner with custom configuration
func NewScannerWithConfig(target string, authToken string, config *ScannerConfig) *Scanner {
	timeout := DefaultTimeout
	tlsTimeout := DefaultTLSTimeout
	skipChecks := make(map[CheckID]bool)

	if config != nil {
		if config.Timeout > 0 {
			timeout = config.Timeout
		}
		if config.TLSTimeout > 0 {
			tlsTimeout = config.TLSTimeout
		}
		for _, id := range config.SkipChecks {
			skipChecks[id] = true
		}
	}

	var httpClient *http.Client
	if config != nil && config.HTTPClient != nil {
		httpClient = config.HTTPClient
	} else {
		httpClient = &http.Client{
			Timeout: timeout,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse // Don't follow redirects automatically
			},
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{
					InsecureSkipVerify: false,
				},
				TLSHandshakeTimeout:   tlsTimeout,
				ResponseHeaderTimeout: timeout,
			},
		}
	}

	return &Scanner{
		Target:     target,
		AuthToken:  authToken,
		HTTPClient: httpClient,
		Timeout:    timeout,
		TLSTimeout: tlsTimeout,
		skipChecks: skipChecks,
	}
}

// ShouldSkip returns true if the given check ID should be skipped.
// It checks both exact matches and parent checks (e.g., skipping "security-headers"
// will also skip "security-headers/hsts").
func (s *Scanner) ShouldSkip(id CheckID) bool {
	if s.skipChecks[id] {
		return true
	}
	// Check if parent is skipped (e.g., "security-headers" skips "security-headers/hsts")
	idStr := string(id)
	for skipped := range s.skipChecks {
		if strings.HasPrefix(idStr, string(skipped)+"/") {
			return true
		}
	}
	return false
}

// RunAll executes all checks and returns combined results
func (s *Scanner) RunAll() Result {
	result := Result{
		Target:   s.Target,
		Findings: []Finding{},
	}

	// Run all checks (skip disabled ones)
	if !s.ShouldSkip(CheckSecurityHeaders) {
		result.Findings = append(result.Findings, s.CheckSecurityHeaders()...)
	}
	if !s.ShouldSkip(CheckCookies) {
		result.Findings = append(result.Findings, s.CheckCookies()...)
	}
	if !s.ShouldSkip(CheckTLS) {
		result.Findings = append(result.Findings, s.CheckTLS()...)
	}
	if !s.ShouldSkip(CheckInfoDisclosure) {
		result.Findings = append(result.Findings, s.CheckInfoDisclosure()...)
	}
	if !s.ShouldSkip(CheckCORS) {
		result.Findings = append(result.Findings, s.CheckCORS()...)
	}
	if !s.ShouldSkip(CheckSensitiveFiles) {
		result.Findings = append(result.Findings, s.CheckSensitiveFiles()...)
	}
	if !s.ShouldSkip(CheckHTTPSEnforcement) {
		result.Findings = append(result.Findings, s.CheckHTTPSEnforcement()...)
	}

	return result
}
