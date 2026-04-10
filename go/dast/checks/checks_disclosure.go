package checks

import (
	"io"
	"net/http"
	"regexp"
	"strings"
)

// verboseHeaders are headers that may leak server information
var verboseHeaders = []struct {
	Name        string
	Description string
}{
	{"Server", "Server header exposes web server software and version"},
	{"X-Powered-By", "X-Powered-By header exposes application framework"},
	{"X-AspNet-Version", "X-AspNet-Version header exposes ASP.NET version"},
	{"X-AspNetMvc-Version", "X-AspNetMvc-Version header exposes ASP.NET MVC version"},
	{"X-Generator", "X-Generator header exposes site generator"},
}

// errorPatterns to look for in response bodies
var errorPatterns = []struct {
	Pattern     *regexp.Regexp
	Description string
}{
	{regexp.MustCompile(`(?i)stack\s*trace`), "Response may contain stack trace"},
	{regexp.MustCompile(`(?i)exception\s+in`), "Response may contain exception details"},
	{regexp.MustCompile(`(?i)fatal\s+error`), "Response may contain fatal error details"},
	{regexp.MustCompile(`(?i)sql\s+syntax`), "Response may expose SQL syntax errors"},
	{regexp.MustCompile(`(?i)at\s+\w+\.\w+\([^)]*\)\s+in\s+`), "Response may contain .NET stack trace"},
	{regexp.MustCompile(`(?i)at\s+[\w.$]+\([\w.$:]+\)`), "Response may contain Java stack trace"},
	{regexp.MustCompile(`File\s+"[^"]+",\s+line\s+\d+`), "Response may contain Python traceback"},
}

// CheckInfoDisclosure looks for information disclosure in headers and responses
func (s *Scanner) CheckInfoDisclosure() []Finding {
	var findings []Finding

	req, err := http.NewRequest("GET", s.Target, nil)
	if err != nil {
		findings = append(findings, Finding{
			Check:       string(CheckInfoDisclosure),
			Severity:    SeverityHigh,
			Title:       "Request Construction Failed",
			Description: "Could not create request to check info disclosure: " + err.Error(),
		})
		return findings
	}

	if s.AuthToken != "" {
		req.Header.Set("Authorization", "Bearer "+s.AuthToken)
	}

	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		findings = append(findings, Finding{
			Check:       string(CheckInfoDisclosure),
			Severity:    SeverityHigh,
			Title:       "Connection Failed",
			Description: "Could not connect to target to check info disclosure: " + err.Error(),
			Remediation: "Verify the target URL is correct and the server is reachable.",
		})
		return findings
	}
	defer resp.Body.Close()

	// Check for verbose headers
	if !s.ShouldSkip(CheckInfoDisclosureHeaders) {
		for _, vh := range verboseHeaders {
			value := resp.Header.Get(vh.Name)
			if value != "" {
				findings = append(findings, Finding{
					Check:       string(CheckInfoDisclosureHeaders),
					Severity:    SeverityLow,
					Title:       "Verbose Header: " + vh.Name,
					Description: vh.Description + ". Value: " + value,
					Remediation: "Remove or sanitize the " + vh.Name + " header.",
				})
			}
		}
	}

	// Read a limited amount of the body to check for error patterns
	bodyBytes, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024)) // 64KB limit
	if err != nil {
		return findings
	}
	body := string(bodyBytes)

	// Check for error patterns in body
	if !s.ShouldSkip(CheckInfoDisclosureErrors) {
		for _, ep := range errorPatterns {
			if ep.Pattern.MatchString(body) {
				findings = append(findings, Finding{
					Check:       string(CheckInfoDisclosureErrors),
					Severity:    SeverityMedium,
					Title:       "Potential Error Disclosure",
					Description: ep.Description,
					Remediation: "Configure custom error pages and disable detailed error output in production.",
				})
				break // Only report once per page
			}
		}
	}

	// Check for common sensitive paths in HTML comments
	if !s.ShouldSkip(CheckInfoDisclosureComments) && strings.Contains(body, "<!--") {
		commentPattern := regexp.MustCompile(`<!--[\s\S]*?-->`)
		comments := commentPattern.FindAllString(body, -1)
		for _, comment := range comments {
			lowerComment := strings.ToLower(comment)
			if strings.Contains(lowerComment, "password") ||
				strings.Contains(lowerComment, "api_key") ||
				strings.Contains(lowerComment, "secret") ||
				strings.Contains(lowerComment, "todo") ||
				strings.Contains(lowerComment, "fixme") ||
				strings.Contains(lowerComment, "hack") {
				findings = append(findings, Finding{
					Check:       string(CheckInfoDisclosureComments),
					Severity:    SeverityLow,
					Title:       "Sensitive HTML Comment",
					Description: "HTML comments may contain sensitive information or developer notes.",
					Remediation: "Remove HTML comments containing sensitive information before deployment.",
				})
				break
			}
		}
	}

	return findings
}
