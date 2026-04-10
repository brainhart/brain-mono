package checks

import (
	"net/http"
	"strings"
)

// CheckCookies analyzes Set-Cookie headers for security flags
func (s *Scanner) CheckCookies() []Finding {
	var findings []Finding

	req, err := http.NewRequest("GET", s.Target, nil)
	if err != nil {
		findings = append(findings, Finding{
			Check:       string(CheckCookies),
			Severity:    SeverityHigh,
			Title:       "Request Construction Failed",
			Description: "Could not create request to check cookies: " + err.Error(),
		})
		return findings
	}

	if s.AuthToken != "" {
		req.Header.Set("Authorization", "Bearer "+s.AuthToken)
	}

	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		findings = append(findings, Finding{
			Check:       string(CheckCookies),
			Severity:    SeverityHigh,
			Title:       "Connection Failed",
			Description: "Could not connect to target to check cookies: " + err.Error(),
			Remediation: "Verify the target URL is correct and the server is reachable.",
		})
		return findings
	}
	defer resp.Body.Close()

	cookies := resp.Cookies()
	if len(cookies) == 0 {
		findings = append(findings, Finding{
			Check:       string(CheckCookies),
			Severity:    SeverityInfo,
			Title:       "No Cookies Set",
			Description: "No cookies were set on this response. Run with auth token to check session cookies.",
		})
		return findings
	}

	isHTTPS := strings.HasPrefix(s.Target, "https://")

	for _, cookie := range cookies {
		// Check Secure flag
		if !s.ShouldSkip(CheckCookieSecure) && isHTTPS && !cookie.Secure {
			findings = append(findings, Finding{
				Check:       string(CheckCookieSecure),
				Severity:    SeverityHigh,
				Title:       "Cookie Missing Secure Flag",
				Description: "Cookie '" + cookie.Name + "' is missing the Secure flag. It may be transmitted over HTTP.",
				Remediation: "Add the Secure flag to this cookie.",
			})
		}

		// Check HttpOnly flag (especially important for session-like cookies)
		if !s.ShouldSkip(CheckCookieHttpOnly) && !cookie.HttpOnly {
			severity := SeverityMedium
			// Session-related cookies should definitely have HttpOnly
			if isSessionCookie(cookie.Name) {
				severity = SeverityHigh
			}
			findings = append(findings, Finding{
				Check:       string(CheckCookieHttpOnly),
				Severity:    severity,
				Title:       "Cookie Missing HttpOnly Flag",
				Description: "Cookie '" + cookie.Name + "' is missing the HttpOnly flag. It can be accessed via JavaScript.",
				Remediation: "Add the HttpOnly flag to this cookie if it doesn't need client-side access.",
			})
		}

		// Check SameSite attribute
		if !s.ShouldSkip(CheckCookieSameSite) {
			if cookie.SameSite == http.SameSiteDefaultMode || cookie.SameSite == 0 {
				findings = append(findings, Finding{
					Check:       string(CheckCookieSameSite),
					Severity:    SeverityMedium,
					Title:       "Cookie Missing SameSite Attribute",
					Description: "Cookie '" + cookie.Name + "' is missing explicit SameSite attribute. CSRF protection may be weakened.",
					Remediation: "Add 'SameSite=Lax' or 'SameSite=Strict' attribute to this cookie.",
				})
			} else if cookie.SameSite == http.SameSiteNoneMode && !cookie.Secure {
				findings = append(findings, Finding{
					Check:       string(CheckCookieSameSite),
					Severity:    SeverityHigh,
					Title:       "SameSite=None Without Secure",
					Description: "Cookie '" + cookie.Name + "' has SameSite=None but is missing Secure flag. This is invalid in modern browsers.",
					Remediation: "Add the Secure flag when using SameSite=None.",
				})
			}
		}
	}

	return findings
}

// isSessionCookie checks if a cookie name suggests it's a session identifier
func isSessionCookie(name string) bool {
	name = strings.ToLower(name)
	sessionIndicators := []string{
		"session", "sess", "sid", "token", "auth", "jwt",
		"access", "refresh", "login", "credential",
	}
	for _, indicator := range sessionIndicators {
		if strings.Contains(name, indicator) {
			return true
		}
	}
	return false
}
