package checks

import (
	"io"
	"net/http"
	"net/url"
	"strings"
)

// sensitiveFile defines a potentially sensitive file to check
type sensitiveFile struct {
	Path        string
	Description string
	Severity    Severity
	Indicators  []string // Strings that indicate the file is actually exposed (not just a 200 OK)
}

var sensitiveFiles = []sensitiveFile{
	{
		Path:        "/.git/config",
		Description: "Git configuration file exposed. Repository may be cloneable.",
		Severity:    SeverityHigh,
		Indicators:  []string{"[core]", "[remote", "repositoryformatversion"},
	},
	{
		Path:        "/.git/HEAD",
		Description: "Git HEAD file exposed. Repository structure is accessible.",
		Severity:    SeverityHigh,
		Indicators:  []string{"ref:", "refs/heads/"},
	},
	{
		Path:        "/.env",
		Description: "Environment file exposed. May contain secrets and credentials.",
		Severity:    SeverityHigh,
		Indicators:  []string{"=", "DB_", "API_", "SECRET", "PASSWORD", "KEY"},
	},
	{
		Path:        "/.htaccess",
		Description: "Apache configuration file exposed.",
		Severity:    SeverityMedium,
		Indicators:  []string{"RewriteRule", "RewriteEngine", "Deny from", "Allow from"},
	},
	{
		Path:        "/web.config",
		Description: "IIS configuration file exposed.",
		Severity:    SeverityMedium,
		Indicators:  []string{"<configuration>", "<system.web>"},
	},
	{
		Path:        "/phpinfo.php",
		Description: "PHP info page exposed. Reveals server configuration details.",
		Severity:    SeverityMedium,
		Indicators:  []string{"PHP Version", "phpinfo()", "Configuration"},
	},
	{
		Path:        "/server-status",
		Description: "Apache server-status page exposed.",
		Severity:    SeverityMedium,
		Indicators:  []string{"Apache Server Status", "Server uptime"},
	},
	{
		Path:        "/.well-known/security.txt",
		Description: "Security.txt file found (informational).",
		Severity:    SeverityInfo,
		Indicators:  []string{"Contact:", "Expires:"},
	},
	{
		Path:        "/robots.txt",
		Description: "Robots.txt file found. Reviewing for sensitive paths.",
		Severity:    SeverityInfo,
		Indicators:  []string{"User-agent:", "Disallow:", "Allow:"},
	},
	{
		Path:        "/.svn/entries",
		Description: "SVN entries file exposed. Repository structure accessible.",
		Severity:    SeverityHigh,
		Indicators:  []string{"dir", "svn:"},
	},
	{
		Path:        "/backup.sql",
		Description: "SQL backup file exposed.",
		Severity:    SeverityHigh,
		Indicators:  []string{"CREATE TABLE", "INSERT INTO", "DROP TABLE"},
	},
	{
		Path:        "/dump.sql",
		Description: "SQL dump file exposed.",
		Severity:    SeverityHigh,
		Indicators:  []string{"CREATE TABLE", "INSERT INTO", "DROP TABLE"},
	},
	{
		Path:        "/composer.json",
		Description: "Composer configuration exposed. Reveals PHP dependencies.",
		Severity:    SeverityLow,
		Indicators:  []string{"require", "autoload", "name"},
	},
	{
		Path:        "/package.json",
		Description: "NPM package.json exposed. Reveals Node.js dependencies.",
		Severity:    SeverityLow,
		Indicators:  []string{"dependencies", "devDependencies", "scripts"},
	},
}

// CheckSensitiveFiles probes for commonly exposed sensitive files
func (s *Scanner) CheckSensitiveFiles() []Finding {
	var findings []Finding
	var lastConnError error
	connSucceeded := false

	baseURL, err := url.Parse(s.Target)
	if err != nil {
		findings = append(findings, Finding{
			Check:       string(CheckSensitiveFiles),
			Severity:    SeverityHigh,
			Title:       "Invalid Target URL",
			Description: "Could not parse target URL: " + err.Error(),
		})
		return findings
	}

	for _, sf := range sensitiveFiles {
		checkURL := baseURL.Scheme + "://" + baseURL.Host + sf.Path

		req, err := http.NewRequest("GET", checkURL, nil)
		if err != nil {
			continue
		}

		// Don't send auth tokens for sensitive file checks
		// These should not be accessible at all

		resp, err := s.HTTPClient.Do(req)
		if err != nil {
			lastConnError = err
			continue
		}
		connSucceeded = true

		if resp.StatusCode == http.StatusOK {
			// Read body to check for indicators
			bodyBytes, err := io.ReadAll(io.LimitReader(resp.Body, 16*1024))
			resp.Body.Close()
			if err != nil {
				continue
			}
			body := string(bodyBytes)

			// Check if any indicators are present
			found := false
			for _, indicator := range sf.Indicators {
				if strings.Contains(body, indicator) {
					found = true
					break
				}
			}

			if found {
				findings = append(findings, Finding{
					Check:       string(CheckSensitiveFiles),
					Severity:    sf.Severity,
					Title:       "Sensitive File Exposed: " + sf.Path,
					Description: sf.Description,
					Remediation: "Block access to " + sf.Path + " in your web server configuration.",
				})

				// Special handling for robots.txt - check for interesting disallowed paths
				if sf.Path == "/robots.txt" {
					findings = append(findings, analyzeRobotsTxt(body)...)
				}
			}
		} else {
			resp.Body.Close()
		}
	}

	// If no connection succeeded, report the connectivity issue
	if !connSucceeded && lastConnError != nil {
		findings = append(findings, Finding{
			Check:       string(CheckSensitiveFiles),
			Severity:    SeverityHigh,
			Title:       "Connection Failed",
			Description: "Could not connect to target to check sensitive files: " + lastConnError.Error(),
			Remediation: "Verify the target URL is correct and the server is reachable.",
		})
	}

	return findings
}

// analyzeRobotsTxt looks for potentially sensitive paths in robots.txt
func analyzeRobotsTxt(content string) []Finding {
	var findings []Finding

	sensitivePatterns := []string{
		"/admin", "/backup", "/config", "/db", "/database",
		"/private", "/secret", "/internal", "/api", "/debug",
		"/test", "/staging", "/dev", ".sql", ".bak", ".log",
	}

	lines := strings.Split(content, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(strings.ToLower(line))
		if strings.HasPrefix(line, "disallow:") {
			path := strings.TrimSpace(strings.TrimPrefix(line, "disallow:"))
			for _, pattern := range sensitivePatterns {
				if strings.Contains(path, pattern) {
					findings = append(findings, Finding{
						Check:       string(CheckSensitiveFiles),
						Severity:    SeverityInfo,
						Title:       "Interesting Path in robots.txt",
						Description: "robots.txt disallows potentially sensitive path: " + path,
						Remediation: "Verify this path is properly secured and not just hidden via robots.txt.",
					})
					break
				}
			}
		}
	}

	return findings
}
