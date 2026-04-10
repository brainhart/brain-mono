package checks

import (
	"net/http"
	"strings"
)

// securityHeader defines an expected security header
type securityHeader struct {
	Name        string
	CheckID     CheckID
	Required    bool
	Severity    Severity
	Description string
	Remediation string
	Validator   func(value string) bool
}

var securityHeaders = []securityHeader{
	{
		Name:        "Strict-Transport-Security",
		CheckID:     CheckHeaderHSTS,
		Required:    true,
		Severity:    SeverityHigh,
		Description: "HSTS header is missing. Browsers may connect over insecure HTTP.",
		Remediation: "Add 'Strict-Transport-Security: max-age=31536000; includeSubDomains' header.",
		Validator: func(v string) bool {
			return strings.Contains(v, "max-age=")
		},
	},
	{
		Name:        "Content-Security-Policy",
		CheckID:     CheckHeaderCSP,
		Required:    true,
		Severity:    SeverityMedium,
		Description: "CSP header is missing. Site may be vulnerable to XSS attacks.",
		Remediation: "Implement a Content-Security-Policy header appropriate for your application.",
	},
	{
		Name:        "X-Content-Type-Options",
		CheckID:     CheckHeaderXContentTypeOpts,
		Required:    true,
		Severity:    SeverityMedium,
		Description: "X-Content-Type-Options header is missing. Browsers may MIME-sniff responses.",
		Remediation: "Add 'X-Content-Type-Options: nosniff' header.",
		Validator: func(v string) bool {
			return strings.ToLower(v) == "nosniff"
		},
	},
	{
		Name:        "X-Frame-Options",
		CheckID:     CheckHeaderXFrameOpts,
		Required:    true,
		Severity:    SeverityMedium,
		Description: "X-Frame-Options header is missing. Site may be vulnerable to clickjacking.",
		Remediation: "Add 'X-Frame-Options: DENY' or 'X-Frame-Options: SAMEORIGIN' header.",
		Validator: func(v string) bool {
			v = strings.ToUpper(v)
			return v == "DENY" || v == "SAMEORIGIN"
		},
	},
	{
		Name:        "Referrer-Policy",
		CheckID:     CheckHeaderReferrerPolicy,
		Required:    false,
		Severity:    SeverityLow,
		Description: "Referrer-Policy header is missing. Referrer information may leak to external sites.",
		Remediation: "Add 'Referrer-Policy: strict-origin-when-cross-origin' or stricter.",
	},
	{
		Name:        "Permissions-Policy",
		CheckID:     CheckHeaderPermissionsPolicy,
		Required:    false,
		Severity:    SeverityLow,
		Description: "Permissions-Policy header is missing. Browser features are not explicitly restricted.",
		Remediation: "Add Permissions-Policy header to restrict unnecessary browser features.",
	},
}

// CheckSecurityHeaders verifies presence and values of security headers
func (s *Scanner) CheckSecurityHeaders() []Finding {
	var findings []Finding

	req, err := http.NewRequest("GET", s.Target, nil)
	if err != nil {
		findings = append(findings, Finding{
			Check:       string(CheckSecurityHeaders),
			Severity:    SeverityHigh,
			Title:       "Request Construction Failed",
			Description: "Could not create request to check security headers: " + err.Error(),
		})
		return findings
	}

	if s.AuthToken != "" {
		req.Header.Set("Authorization", "Bearer "+s.AuthToken)
	}

	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		findings = append(findings, Finding{
			Check:       string(CheckSecurityHeaders),
			Severity:    SeverityHigh,
			Title:       "Connection Failed",
			Description: "Could not connect to target to check security headers: " + err.Error(),
			Remediation: "Verify the target URL is correct and the server is reachable.",
		})
		return findings
	}
	defer resp.Body.Close()

	for _, header := range securityHeaders {
		// Skip if this specific header check is disabled
		if s.ShouldSkip(header.CheckID) {
			continue
		}

		value := resp.Header.Get(header.Name)

		if value == "" {
			findings = append(findings, Finding{
				Check:       string(header.CheckID),
				Severity:    header.Severity,
				Title:       "Missing " + header.Name,
				Description: header.Description,
				Remediation: header.Remediation,
			})
		} else if header.Validator != nil && !header.Validator(value) {
			findings = append(findings, Finding{
				Check:       string(header.CheckID),
				Severity:    header.Severity,
				Title:       "Invalid " + header.Name,
				Description: header.Name + " header has invalid value: " + value,
				Remediation: header.Remediation,
			})
		}
	}

	return findings
}
