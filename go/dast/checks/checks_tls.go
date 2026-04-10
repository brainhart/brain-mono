package checks

import (
	"crypto/tls"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"
)

// CheckTLS verifies TLS configuration and certificate validity
func (s *Scanner) CheckTLS() []Finding {
	var findings []Finding

	parsedURL, err := url.Parse(s.Target)
	if err != nil {
		findings = append(findings, Finding{
			Check:       string(CheckTLS),
			Severity:    SeverityHigh,
			Title:       "Invalid Target URL",
			Description: "Could not parse target URL: " + err.Error(),
		})
		return findings
	}

	if parsedURL.Scheme != "https" {
		findings = append(findings, Finding{
			Check:       string(CheckTLS),
			Severity:    SeverityHigh,
			Title:       "Not Using HTTPS",
			Description: "Target is not using HTTPS. All traffic is unencrypted.",
			Remediation: "Configure the server to use HTTPS.",
		})
		return findings
	}

	host := parsedURL.Host
	if !strings.Contains(host, ":") {
		host = host + ":443"
	}

	// Use scanner's timeout setting
	tlsTimeout := s.TLSTimeout
	if tlsTimeout == 0 {
		tlsTimeout = 10 * time.Second
	}

	// Connect with TLS to check certificate and protocol (with proper verification)
	conn, err := tls.DialWithDialer(
		&net.Dialer{Timeout: tlsTimeout},
		"tcp",
		host,
		&tls.Config{
			InsecureSkipVerify: false,
		},
	)
	if err != nil {
		// Record the certificate validation failure
		findings = append(findings, Finding{
			Check:       string(CheckTLS),
			Severity:    SeverityHigh,
			Title:       "Certificate Validation Failed",
			Description: "TLS certificate validation failed: " + err.Error(),
			Remediation: "Ensure the certificate is valid, not expired, and properly configured with a trusted CA.",
		})

		// Try again with InsecureSkipVerify to gather additional info about the TLS config
		// Note: we clearly mark that these are observations from an unverified connection
		conn2, err2 := tls.DialWithDialer(
			&net.Dialer{Timeout: tlsTimeout},
			"tcp",
			host,
			&tls.Config{
				InsecureSkipVerify: true,
			},
		)
		if err2 != nil {
			// Complete TLS failure - can't connect at all
			findings = append(findings, Finding{
				Check:       string(CheckTLS),
				Severity:    SeverityHigh,
				Title:       "TLS Connection Failed",
				Description: "Could not establish TLS connection even with verification disabled: " + err2.Error(),
				Remediation: "Verify the server is reachable and TLS is properly configured.",
			})
			return findings
		}
		defer conn2.Close()

		// Analyze the connection but mark findings as from unverified connection
		return s.analyzeTLSConnectionUnverified(conn2, findings)
	}
	defer conn.Close()

	return s.analyzeTLSConnection(conn, findings)
}

func (s *Scanner) analyzeTLSConnection(conn *tls.Conn, findings []Finding) []Finding {
	state := conn.ConnectionState()

	// Check TLS version
	if !s.ShouldSkip(CheckTLSVersion) {
		switch state.Version {
		case tls.VersionTLS10:
			findings = append(findings, Finding{
				Check:       string(CheckTLSVersion),
				Severity:    SeverityHigh,
				Title:       "TLS 1.0 In Use",
				Description: "Server supports TLS 1.0 which is deprecated and insecure.",
				Remediation: "Disable TLS 1.0 and require TLS 1.2 or higher.",
			})
		case tls.VersionTLS11:
			findings = append(findings, Finding{
				Check:       string(CheckTLSVersion),
				Severity:    SeverityHigh,
				Title:       "TLS 1.1 In Use",
				Description: "Server supports TLS 1.1 which is deprecated and insecure.",
				Remediation: "Disable TLS 1.1 and require TLS 1.2 or higher.",
			})
		case tls.VersionTLS12:
			// TLS 1.2 is acceptable
		case tls.VersionTLS13:
			// TLS 1.3 is preferred
		}
	}

	// Check certificate expiration
	if !s.ShouldSkip(CheckTLSCertificate) && len(state.PeerCertificates) > 0 {
		cert := state.PeerCertificates[0]

		now := time.Now()
		if now.After(cert.NotAfter) {
			findings = append(findings, Finding{
				Check:       string(CheckTLSCertificate),
				Severity:    SeverityHigh,
				Title:       "Certificate Expired",
				Description: fmt.Sprintf("Certificate expired on %s", cert.NotAfter.Format("2006-01-02")),
				Remediation: "Renew the SSL/TLS certificate.",
			})
		} else if now.Before(cert.NotBefore) {
			findings = append(findings, Finding{
				Check:       string(CheckTLSCertificate),
				Severity:    SeverityHigh,
				Title:       "Certificate Not Yet Valid",
				Description: fmt.Sprintf("Certificate is not valid until %s", cert.NotBefore.Format("2006-01-02")),
				Remediation: "Check server time configuration or wait until certificate becomes valid.",
			})
		} else {
			// Check if expiring soon (within 30 days)
			daysUntilExpiry := int(cert.NotAfter.Sub(now).Hours() / 24)
			if daysUntilExpiry <= 30 {
				findings = append(findings, Finding{
					Check:       string(CheckTLSCertificate),
					Severity:    SeverityMedium,
					Title:       "Certificate Expiring Soon",
					Description: fmt.Sprintf("Certificate expires in %d days on %s", daysUntilExpiry, cert.NotAfter.Format("2006-01-02")),
					Remediation: "Plan to renew the certificate before expiration.",
				})
			}
		}
	}

	return findings
}

// analyzeTLSConnectionUnverified analyzes a TLS connection made with InsecureSkipVerify=true.
// Findings from this analysis are clearly marked as observations that should be interpreted
// carefully since the certificate validation already failed.
func (s *Scanner) analyzeTLSConnectionUnverified(conn *tls.Conn, findings []Finding) []Finding {
	state := conn.ConnectionState()

	// Check TLS version - this is still relevant even with invalid certs
	if !s.ShouldSkip(CheckTLSVersion) {
		switch state.Version {
		case tls.VersionTLS10:
			findings = append(findings, Finding{
				Check:       string(CheckTLSVersion),
				Severity:    SeverityHigh,
				Title:       "TLS 1.0 In Use (Unverified Connection)",
				Description: "Server supports TLS 1.0 which is deprecated and insecure. Note: observed via unverified connection due to certificate issues.",
				Remediation: "Disable TLS 1.0 and require TLS 1.2 or higher.",
			})
		case tls.VersionTLS11:
			findings = append(findings, Finding{
				Check:       string(CheckTLSVersion),
				Severity:    SeverityHigh,
				Title:       "TLS 1.1 In Use (Unverified Connection)",
				Description: "Server supports TLS 1.1 which is deprecated and insecure. Note: observed via unverified connection due to certificate issues.",
				Remediation: "Disable TLS 1.1 and require TLS 1.2 or higher.",
			})
		case tls.VersionTLS12, tls.VersionTLS13:
			// TLS version is acceptable, but note we're on an unverified connection
		}
	}

	// Check certificate dates - still useful info even if cert validation failed
	// (could be self-signed but not expired, or expired which compounds the issue)
	if !s.ShouldSkip(CheckTLSCertificate) && len(state.PeerCertificates) > 0 {
		cert := state.PeerCertificates[0]
		now := time.Now()

		if now.After(cert.NotAfter) {
			findings = append(findings, Finding{
				Check:       string(CheckTLSCertificate),
				Severity:    SeverityHigh,
				Title:       "Certificate Expired (Unverified Connection)",
				Description: fmt.Sprintf("Certificate expired on %s. Note: observed via unverified connection.", cert.NotAfter.Format("2006-01-02")),
				Remediation: "Renew the SSL/TLS certificate with a trusted CA.",
			})
		} else if now.Before(cert.NotBefore) {
			findings = append(findings, Finding{
				Check:       string(CheckTLSCertificate),
				Severity:    SeverityHigh,
				Title:       "Certificate Not Yet Valid (Unverified Connection)",
				Description: fmt.Sprintf("Certificate is not valid until %s. Note: observed via unverified connection.", cert.NotBefore.Format("2006-01-02")),
				Remediation: "Check server time configuration or wait until certificate becomes valid.",
			})
		} else {
			daysUntilExpiry := int(cert.NotAfter.Sub(now).Hours() / 24)
			if daysUntilExpiry <= 30 {
				findings = append(findings, Finding{
					Check:       string(CheckTLSCertificate),
					Severity:    SeverityMedium,
					Title:       "Certificate Expiring Soon (Unverified Connection)",
					Description: fmt.Sprintf("Certificate expires in %d days on %s. Note: observed via unverified connection due to certificate validation issues.", daysUntilExpiry, cert.NotAfter.Format("2006-01-02")),
					Remediation: "Plan to renew the certificate before expiration with a trusted CA.",
				})
			}
		}
	}

	return findings
}
