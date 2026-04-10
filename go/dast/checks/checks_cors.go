package checks

import (
	"net/http"
	"strings"
)

// CheckCORS tests for CORS misconfigurations
func (s *Scanner) CheckCORS() []Finding {
	var findings []Finding
	var lastConnError error
	connSucceeded := false

	// Test with a malicious origin to see if it's reflected
	testOrigins := []string{
		"https://evil.com",
		"null",
	}

	for _, origin := range testOrigins {
		req, err := http.NewRequest("GET", s.Target, nil)
		if err != nil {
			continue
		}

		req.Header.Set("Origin", origin)
		if s.AuthToken != "" {
			req.Header.Set("Authorization", "Bearer "+s.AuthToken)
		}

		resp, err := s.HTTPClient.Do(req)
		if err != nil {
			lastConnError = err
			continue
		}
		connSucceeded = true

		acao := resp.Header.Get("Access-Control-Allow-Origin")
		acac := resp.Header.Get("Access-Control-Allow-Credentials")

		resp.Body.Close()

		// Check for wildcard CORS
		if !s.ShouldSkip(CheckCORSWildcard) && acao == "*" {
			if strings.ToLower(acac) == "true" {
				findings = append(findings, Finding{
					Check:       string(CheckCORSWildcard),
					Severity:    SeverityHigh,
					Title:       "CORS Wildcard with Credentials",
					Description: "Access-Control-Allow-Origin is '*' with Access-Control-Allow-Credentials: true. This is invalid but may indicate misconfiguration.",
					Remediation: "Never use wildcard origin with credentials. Implement proper origin validation.",
				})
			} else {
				findings = append(findings, Finding{
					Check:       string(CheckCORSWildcard),
					Severity:    SeverityMedium,
					Title:       "CORS Wildcard Origin",
					Description: "Access-Control-Allow-Origin is set to '*'. Any website can make cross-origin requests.",
					Remediation: "Restrict allowed origins to specific trusted domains.",
				})
			}
			break // No need to test more origins
		}

		// Check if origin is reflected
		if !s.ShouldSkip(CheckCORSReflection) && acao == origin {
			severity := SeverityMedium
			description := "The server reflects arbitrary Origin headers in ACAO."

			if strings.ToLower(acac) == "true" {
				severity = SeverityHigh
				description = "The server reflects arbitrary Origin headers with credentials allowed. This allows any site to make authenticated requests."
			}

			findings = append(findings, Finding{
				Check:       string(CheckCORSReflection),
				Severity:    severity,
				Title:       "CORS Origin Reflection",
				Description: description + " Tested origin: " + origin,
				Remediation: "Implement strict origin validation with an allowlist of trusted domains.",
			})
		}

		// Check for null origin acceptance
		if !s.ShouldSkip(CheckCORSNull) && origin == "null" && acao == "null" {
			findings = append(findings, Finding{
				Check:       string(CheckCORSNull),
				Severity:    SeverityMedium,
				Title:       "CORS Accepts Null Origin",
				Description: "The server accepts 'null' as a valid origin. This can be exploited via sandboxed iframes.",
				Remediation: "Do not allow 'null' as a valid origin.",
			})
		}
	}

	// Check preflight response
	req, err := http.NewRequest("OPTIONS", s.Target, nil)
	if err == nil {
		req.Header.Set("Origin", "https://evil.com")
		req.Header.Set("Access-Control-Request-Method", "POST")
		req.Header.Set("Access-Control-Request-Headers", "X-Custom-Header")

		resp, err := s.HTTPClient.Do(req)
		if err == nil {
			connSucceeded = true
			defer resp.Body.Close()

			if !s.ShouldSkip(CheckCORSMethods) {
				acam := resp.Header.Get("Access-Control-Allow-Methods")
				if strings.Contains(strings.ToUpper(acam), "PUT") ||
					strings.Contains(strings.ToUpper(acam), "DELETE") ||
					strings.Contains(strings.ToUpper(acam), "PATCH") {

					acao := resp.Header.Get("Access-Control-Allow-Origin")
					if acao == "*" || acao == "https://evil.com" {
						findings = append(findings, Finding{
							Check:       string(CheckCORSMethods),
							Severity:    SeverityMedium,
							Title:       "CORS Allows Dangerous Methods",
							Description: "CORS preflight allows potentially dangerous methods (PUT/DELETE/PATCH) from arbitrary origins.",
							Remediation: "Restrict allowed methods and origins in CORS configuration.",
						})
					}
				}
			}
		} else {
			lastConnError = err
		}
	}

	// If no connection succeeded, report the connectivity issue
	if !connSucceeded && lastConnError != nil {
		findings = append(findings, Finding{
			Check:       string(CheckCORS),
			Severity:    SeverityHigh,
			Title:       "Connection Failed",
			Description: "Could not connect to target to check CORS configuration: " + lastConnError.Error(),
			Remediation: "Verify the target URL is correct and the server is reachable.",
		})
	}

	return findings
}
