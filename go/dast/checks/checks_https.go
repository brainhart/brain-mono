package checks

import (
	"crypto/tls"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// CheckHTTPSEnforcement verifies that HTTP redirects to HTTPS
func (s *Scanner) CheckHTTPSEnforcement() []Finding {
	var findings []Finding

	parsedURL, err := url.Parse(s.Target)
	if err != nil {
		findings = append(findings, Finding{
			Check:       string(CheckHTTPSEnforcement),
			Severity:    SeverityHigh,
			Title:       "Invalid Target URL",
			Description: "Could not parse target URL: " + err.Error(),
		})
		return findings
	}

	// If target is already HTTP, that's a problem (handled by TLS check)
	// Here we check if HTTP version redirects to HTTPS
	if parsedURL.Scheme == "https" {
		// Construct HTTP version of the URL
		httpURL := "http://" + parsedURL.Host + parsedURL.Path
		if parsedURL.RawQuery != "" {
			httpURL += "?" + parsedURL.RawQuery
		}

		// Use scanner's timeout settings
		timeout := s.Timeout
		if timeout == 0 {
			timeout = 30 * time.Second
		}

		// Create client that doesn't follow redirects
		client := &http.Client{
			Timeout: timeout,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse
			},
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{
					InsecureSkipVerify: true,
				},
				ResponseHeaderTimeout: timeout,
			},
		}

		req, err := http.NewRequest("GET", httpURL, nil)
		if err != nil {
			return findings
		}

		resp, err := client.Do(req)
		if err != nil {
			// Connection refused on HTTP is actually fine - means only HTTPS is available
			if strings.Contains(err.Error(), "connection refused") {
				return findings
			}
			// Timeout or other network errors - report them so user knows HTTP check couldn't complete
			if strings.Contains(err.Error(), "timeout") || strings.Contains(err.Error(), "deadline") {
				findings = append(findings, Finding{
					Check:       string(CheckHTTPSEnforcement),
					Severity:    SeverityMedium,
					Title:       "HTTP Check Timed Out",
					Description: "Could not determine if HTTP redirects to HTTPS: request timed out",
					Remediation: "Verify the server is reachable and consider increasing timeout.",
				})
				return findings
			}
			// Other errors - report them
			findings = append(findings, Finding{
				Check:       string(CheckHTTPSEnforcement),
				Severity:    SeverityInfo,
				Title:       "HTTP Check Inconclusive",
				Description: "Could not determine if HTTP redirects to HTTPS: " + err.Error(),
			})
			return findings
		}
		defer resp.Body.Close()

		// Check if it redirects to HTTPS
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			location := resp.Header.Get("Location")
			if strings.HasPrefix(location, "https://") {
				// Good - redirects to HTTPS
				return findings
			} else if location != "" {
				findings = append(findings, Finding{
					Check:       string(CheckHTTPSEnforcement),
					Severity:    SeverityMedium,
					Title:       "HTTP Does Not Redirect to HTTPS",
					Description: "HTTP request redirects to " + location + " instead of HTTPS.",
					Remediation: "Configure HTTP to redirect to HTTPS with a 301 permanent redirect.",
				})
			}
		} else if resp.StatusCode == http.StatusOK {
			// HTTP serves content directly without redirect
			findings = append(findings, Finding{
				Check:       string(CheckHTTPSEnforcement),
				Severity:    SeverityHigh,
				Title:       "HTTP Serves Content Without Redirect",
				Description: "The site serves content over HTTP without redirecting to HTTPS. Users may access the site insecurely.",
				Remediation: "Configure HTTP to redirect all requests to HTTPS with a 301 permanent redirect.",
			})
		}
	}

	return findings
}
