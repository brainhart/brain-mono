package checks

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestNewScanner verifies scanner creation with defaults
func TestNewScanner(t *testing.T) {
	scanner := NewScanner("https://example.com", "test-token")

	if scanner.Target != "https://example.com" {
		t.Errorf("expected target https://example.com, got %s", scanner.Target)
	}
	if scanner.AuthToken != "test-token" {
		t.Errorf("expected auth token test-token, got %s", scanner.AuthToken)
	}
	if scanner.HTTPClient == nil {
		t.Error("expected HTTPClient to be initialized")
	}
	if scanner.Timeout != DefaultTimeout {
		t.Errorf("expected timeout %v, got %v", DefaultTimeout, scanner.Timeout)
	}
	if scanner.TLSTimeout != DefaultTLSTimeout {
		t.Errorf("expected TLS timeout %v, got %v", DefaultTLSTimeout, scanner.TLSTimeout)
	}
}

// TestNewScannerWithConfig verifies custom configuration
func TestNewScannerWithConfig(t *testing.T) {
	customTimeout := 60 * time.Second
	customTLSTimeout := 20 * time.Second

	config := &ScannerConfig{
		Timeout:    customTimeout,
		TLSTimeout: customTLSTimeout,
	}

	scanner := NewScannerWithConfig("https://example.com", "", config)

	if scanner.Timeout != customTimeout {
		t.Errorf("expected timeout %v, got %v", customTimeout, scanner.Timeout)
	}
	if scanner.TLSTimeout != customTLSTimeout {
		t.Errorf("expected TLS timeout %v, got %v", customTLSTimeout, scanner.TLSTimeout)
	}
}

// TestNewScannerWithCustomClient verifies custom HTTP client injection
func TestNewScannerWithCustomClient(t *testing.T) {
	customClient := &http.Client{
		Timeout: 5 * time.Second,
	}

	config := &ScannerConfig{
		HTTPClient: customClient,
	}

	scanner := NewScannerWithConfig("https://example.com", "", config)

	if scanner.HTTPClient != customClient {
		t.Error("expected custom HTTP client to be used")
	}
}

// TestConnectionFailureReporting verifies errors are reported, not hidden
func TestConnectionFailureReporting(t *testing.T) {
	// Use an invalid URL that will fail to connect
	scanner := NewScanner("https://invalid.localhost.test:99999", "")

	// Test each check reports connection failures
	tests := []struct {
		name  string
		check func() []Finding
	}{
		{"CheckSecurityHeaders", scanner.CheckSecurityHeaders},
		{"CheckCookies", scanner.CheckCookies},
		{"CheckInfoDisclosure", scanner.CheckInfoDisclosure},
		{"CheckCORS", scanner.CheckCORS},
		{"CheckSensitiveFiles", scanner.CheckSensitiveFiles},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			findings := tc.check()

			if len(findings) == 0 {
				t.Error("expected connection failure to be reported as a finding")
				return
			}

			// Verify at least one finding mentions connection failure
			hasConnectionError := false
			for _, f := range findings {
				if strings.Contains(f.Title, "Connection Failed") ||
					strings.Contains(f.Title, "Connection Error") ||
					strings.Contains(f.Description, "connect") {
					hasConnectionError = true
					break
				}
			}

			if !hasConnectionError {
				t.Errorf("expected connection error finding, got: %+v", findings)
			}
		})
	}
}

// TestSecurityHeadersCheck verifies security header detection
func TestSecurityHeadersCheck(t *testing.T) {
	// Server with no security headers
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	}))
	defer server.Close()

	scanner := NewScanner(server.URL, "")
	findings := scanner.CheckSecurityHeaders()

	// Should report missing HSTS, CSP, X-Content-Type-Options, X-Frame-Options
	expectedMissing := []string{
		"Strict-Transport-Security",
		"Content-Security-Policy",
		"X-Content-Type-Options",
		"X-Frame-Options",
	}

	for _, header := range expectedMissing {
		found := false
		for _, f := range findings {
			if strings.Contains(f.Title, header) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("expected finding for missing %s header", header)
		}
	}
}

// TestSecurityHeadersPresent verifies no findings when headers are present
func TestSecurityHeadersPresent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		w.Header().Set("Content-Security-Policy", "default-src 'self'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy", "geolocation=()")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	scanner := NewScanner(server.URL, "")
	findings := scanner.CheckSecurityHeaders()

	if len(findings) > 0 {
		t.Errorf("expected no findings when all headers present, got: %+v", findings)
	}
}

// TestCookiesCheck verifies cookie security analysis
func TestCookiesCheck(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Set an insecure session cookie
		http.SetCookie(w, &http.Cookie{
			Name:  "session_id",
			Value: "abc123",
			// Missing Secure, HttpOnly, SameSite
		})
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	scanner := NewScanner(server.URL, "")
	findings := scanner.CheckCookies()

	// Should find missing HttpOnly (HIGH for session cookie) and SameSite
	hasHttpOnlyFinding := false
	hasSameSiteFinding := false

	for _, f := range findings {
		if strings.Contains(f.Title, "HttpOnly") {
			hasHttpOnlyFinding = true
		}
		if strings.Contains(f.Title, "SameSite") {
			hasSameSiteFinding = true
		}
	}

	if !hasHttpOnlyFinding {
		t.Error("expected finding for missing HttpOnly flag")
	}
	if !hasSameSiteFinding {
		t.Error("expected finding for missing SameSite attribute")
	}
}

// TestCORSWildcard verifies CORS wildcard detection
func TestCORSWildcard(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	scanner := NewScanner(server.URL, "")
	findings := scanner.CheckCORS()

	hasCORSWildcard := false
	for _, f := range findings {
		if strings.Contains(f.Title, "CORS Wildcard") {
			hasCORSWildcard = true
			break
		}
	}

	if !hasCORSWildcard {
		t.Error("expected finding for CORS wildcard origin")
	}
}

// TestCORSOriginReflection verifies origin reflection detection
func TestCORSOriginReflection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	scanner := NewScanner(server.URL, "")
	findings := scanner.CheckCORS()

	hasOriginReflection := false
	for _, f := range findings {
		if strings.Contains(f.Title, "Origin Reflection") {
			hasOriginReflection = true
			break
		}
	}

	if !hasOriginReflection {
		t.Error("expected finding for CORS origin reflection")
	}
}

// TestInfoDisclosureHeaders verifies verbose header detection
func TestInfoDisclosureHeaders(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Server", "Apache/2.4.41 (Ubuntu)")
		w.Header().Set("X-Powered-By", "PHP/7.4.3")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	scanner := NewScanner(server.URL, "")
	findings := scanner.CheckInfoDisclosure()

	hasServerHeader := false
	hasPoweredByHeader := false

	for _, f := range findings {
		if strings.Contains(f.Title, "Server") {
			hasServerHeader = true
		}
		if strings.Contains(f.Title, "X-Powered-By") {
			hasPoweredByHeader = true
		}
	}

	if !hasServerHeader {
		t.Error("expected finding for verbose Server header")
	}
	if !hasPoweredByHeader {
		t.Error("expected finding for verbose X-Powered-By header")
	}
}

// TestInfoDisclosureErrorPatterns verifies error pattern detection
func TestInfoDisclosureErrorPatterns(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`<html>
			<body>
			Error: exception in thread main
			stack trace at com.example.App.main(App.java:15)
			</body>
		</html>`))
	}))
	defer server.Close()

	scanner := NewScanner(server.URL, "")
	findings := scanner.CheckInfoDisclosure()

	hasErrorDisclosure := false
	for _, f := range findings {
		if strings.Contains(f.Title, "Error Disclosure") {
			hasErrorDisclosure = true
			break
		}
	}

	if !hasErrorDisclosure {
		t.Error("expected finding for error pattern in response")
	}
}

// TestSensitiveFilesGitExposure verifies git config detection
func TestSensitiveFilesGitExposure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/.git/config" {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`[core]
	repositoryformatversion = 0
	filemode = true
[remote "origin"]
	url = git@github.com:example/repo.git
`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	scanner := NewScanner(server.URL, "")
	findings := scanner.CheckSensitiveFiles()

	hasGitExposure := false
	for _, f := range findings {
		if strings.Contains(f.Title, ".git/config") {
			hasGitExposure = true
			break
		}
	}

	if !hasGitExposure {
		t.Error("expected finding for exposed .git/config")
	}
}

// TestSensitiveFilesEnvExposure verifies .env detection
func TestSensitiveFilesEnvExposure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/.env" {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`DB_HOST=localhost
DB_PASSWORD=secret123
API_KEY=abc123
`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	scanner := NewScanner(server.URL, "")
	findings := scanner.CheckSensitiveFiles()

	hasEnvExposure := false
	for _, f := range findings {
		if strings.Contains(f.Title, ".env") {
			hasEnvExposure = true
			break
		}
	}

	if !hasEnvExposure {
		t.Error("expected finding for exposed .env file")
	}
}

// TestHTTPSEnforcementRedirect verifies HTTP->HTTPS redirect detection
func TestHTTPSEnforcementNoRedirect(t *testing.T) {
	// Create an HTTPS server
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	}))
	defer server.Close()

	// Create scanner with custom client that trusts the test server's cert
	config := &ScannerConfig{
		HTTPClient: server.Client(),
	}
	scanner := NewScannerWithConfig(server.URL, "", config)
	scanner.Timeout = 5 * time.Second

	// The HTTPS enforcement check tries to access HTTP version
	// Since test server is HTTPS-only, the HTTP check should get connection refused (which is OK)
	findings := scanner.CheckHTTPSEnforcement()

	// With a proper HTTPS-only server, we should have no findings
	// (connection refused on HTTP port is acceptable)
	for _, f := range findings {
		if f.Severity == SeverityHigh && strings.Contains(f.Title, "HTTP Serves Content") {
			t.Errorf("unexpected high severity finding: %+v", f)
		}
	}
}

// TestTLSCheckHTTPTarget verifies detection of non-HTTPS targets
func TestTLSCheckHTTPTarget(t *testing.T) {
	scanner := NewScanner("http://example.com", "")
	findings := scanner.CheckTLS()

	hasNoHTTPS := false
	for _, f := range findings {
		if strings.Contains(f.Title, "Not Using HTTPS") {
			hasNoHTTPS = true
			break
		}
	}

	if !hasNoHTTPS {
		t.Error("expected finding for non-HTTPS target")
	}
}

// TestTLSCheckInvalidCert verifies certificate validation error reporting
func TestTLSCheckInvalidCert(t *testing.T) {
	// Create a TLS server with self-signed cert
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	// Scanner with default settings (will fail cert validation)
	scanner := NewScanner(server.URL, "")
	findings := scanner.CheckTLS()

	hasCertError := false
	for _, f := range findings {
		if strings.Contains(f.Title, "Certificate Validation Failed") ||
			strings.Contains(f.Title, "Unverified Connection") {
			hasCertError = true
			break
		}
	}

	if !hasCertError {
		t.Error("expected finding for certificate validation failure")
	}
}

// TestRunAll verifies the complete scan execution
func TestRunAll(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	}))
	defer server.Close()

	scanner := NewScanner(server.URL, "")
	result := scanner.RunAll()

	if result.Target != server.URL {
		t.Errorf("expected target %s, got %s", server.URL, result.Target)
	}

	// Should have at least some security header findings
	if len(result.Findings) == 0 {
		t.Error("expected at least some findings from RunAll")
	}

	// Verify findings have required fields
	for _, f := range result.Findings {
		if f.Check == "" {
			t.Error("finding missing Check field")
		}
		if f.Severity == "" {
			t.Error("finding missing Severity field")
		}
		if f.Title == "" {
			t.Error("finding missing Title field")
		}
	}
}

// TestIsSessionCookie verifies session cookie detection
func TestIsSessionCookie(t *testing.T) {
	tests := []struct {
		name     string
		expected bool
	}{
		{"session_id", true},
		{"JSESSIONID", true},
		{"auth_token", true},
		{"jwt_token", true},
		{"access_token", true},
		{"refresh_token", true},
		{"login_state", true},
		{"user_credentials", true},
		{"_ga", false},
		{"theme", false},
		{"language", false},
		{"prefs", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := isSessionCookie(tc.name)
			if result != tc.expected {
				t.Errorf("isSessionCookie(%q) = %v, expected %v", tc.name, result, tc.expected)
			}
		})
	}
}

// TestHTTPClientTimeout verifies the client has proper timeout
func TestHTTPClientTimeout(t *testing.T) {
	scanner := NewScanner("https://example.com", "")

	if scanner.HTTPClient.Timeout != DefaultTimeout {
		t.Errorf("expected client timeout %v, got %v", DefaultTimeout, scanner.HTTPClient.Timeout)
	}

	transport, ok := scanner.HTTPClient.Transport.(*http.Transport)
	if !ok {
		t.Fatal("expected http.Transport")
	}

	if transport.TLSHandshakeTimeout != DefaultTLSTimeout {
		t.Errorf("expected TLS handshake timeout %v, got %v", DefaultTLSTimeout, transport.TLSHandshakeTimeout)
	}
}

// TestScannerConfigNil verifies defaults when config is nil
func TestScannerConfigNil(t *testing.T) {
	scanner := NewScannerWithConfig("https://example.com", "token", nil)

	if scanner.Timeout != DefaultTimeout {
		t.Errorf("expected default timeout %v, got %v", DefaultTimeout, scanner.Timeout)
	}
	if scanner.TLSTimeout != DefaultTLSTimeout {
		t.Errorf("expected default TLS timeout %v, got %v", DefaultTLSTimeout, scanner.TLSTimeout)
	}
}

// TestTLSConfigInsecureSkipVerify verifies default is secure
func TestTLSConfigInsecureSkipVerify(t *testing.T) {
	scanner := NewScanner("https://example.com", "")

	transport, ok := scanner.HTTPClient.Transport.(*http.Transport)
	if !ok {
		t.Fatal("expected http.Transport")
	}

	if transport.TLSClientConfig.InsecureSkipVerify {
		t.Error("InsecureSkipVerify should be false by default")
	}
}

// TestAuthTokenInjection verifies auth token is added to requests
func TestAuthTokenInjection(t *testing.T) {
	var receivedAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	scanner := NewScanner(server.URL, "my-secret-token")
	scanner.CheckSecurityHeaders() // Any check that uses auth

	expectedAuth := "Bearer my-secret-token"
	if receivedAuth != expectedAuth {
		t.Errorf("expected Authorization header %q, got %q", expectedAuth, receivedAuth)
	}
}

// TestFindingSeverityLevels verifies all severity levels are valid
func TestFindingSeverityLevels(t *testing.T) {
	validSeverities := map[Severity]bool{
		SeverityHigh:   true,
		SeverityMedium: true,
		SeverityLow:    true,
		SeverityInfo:   true,
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Server", "Apache/2.4")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	scanner := NewScanner(server.URL, "")
	result := scanner.RunAll()

	for _, f := range result.Findings {
		if !validSeverities[f.Severity] {
			t.Errorf("invalid severity %q in finding: %+v", f.Severity, f)
		}
	}
}

// TestRedirectHandling verifies scanner doesn't follow redirects
func TestRedirectHandling(t *testing.T) {
	redirectCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirectCount++
		if redirectCount == 1 {
			http.Redirect(w, r, "/redirect", http.StatusFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	scanner := NewScanner(server.URL, "")
	scanner.CheckSecurityHeaders()

	// Should only hit server once (no redirect following)
	if redirectCount != 1 {
		t.Errorf("expected 1 request (no redirect following), got %d", redirectCount)
	}
}
