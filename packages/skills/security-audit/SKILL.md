---
name: security-audit
trigger: /security-audit
description: Comprehensive security vulnerability scanning and compliance checking. Identifies OWASP Top 10 issues, dependency vulnerabilities, and security misconfigurations.
category: security
tools: [read_file, list_files, grep, package_json, dependency_check]
---

# Security Audit Skill

Performs comprehensive security analysis on codebases, dependencies, and configurations. Identifies vulnerabilities aligned with OWASP Top 10, CWE classifications, and industry security standards.

## What It Scans

### Code Vulnerabilities
- **SQL Injection** (CWE-89): Unsanitized user input in queries
- **XSS** (CWE-79): Unsafe DOM manipulation, innerHTML usage
- **Code Injection** (CWE-95): eval(), Function constructor, unsafe exec
- **Path Traversal** (CWE-22): File system access without validation
- **Command Injection** (CWE-78): Shell commands with user input

### Cryptography Issues
- Hardcoded secrets and API keys
- Weak password hashing (MD5, SHA1)
- Missing encryption for sensitive data
- Insecure random number generation
- Plaintext password storage

### Authentication & Authorization
- Missing authentication checks
- Weak session management
- Insecure password policies
- Broken access control
- JWT vulnerabilities

### Dependencies
- Known CVEs in npm/pip packages
- Outdated dependencies with security patches
- Deprecated packages
- License compliance issues

### Configuration
- Debug mode in production
- CORS misconfigurations
- Missing security headers
- Exposed secrets in .env files
- Insecure TLS/SSL settings

## Usage

Scan entire project:
```
/security-audit
```

Scan specific directory:
```
/security-audit src/auth/
```

Focus on dependencies:
```
/security-audit --dependencies-only
```

Generate compliance report:
```
/security-audit --compliance=OWASP-2021
```

## Output Format

```
SECURITY AUDIT REPORT
=====================

Project: my-app
Scan Date: 2026-03-23
Files Scanned: 45
Dependencies Checked: 127

RISK LEVEL: HIGH
Risk Score: 75/100

CRITICAL VULNERABILITIES: 2
─────────────────────────────

[CRITICAL] SQL Injection (CWE-89)
  File: src/api/users.ts:67
  Issue: User input directly concatenated in SQL query
  Impact: Database compromise, data exfiltration
  Fix: Use parameterized queries or ORM
  
  Code:
  ```typescript
  const query = `SELECT * FROM users WHERE id = ${req.params.id}`;
  ```
  
  Solution:
  ```typescript
  const query = 'SELECT * FROM users WHERE id = ?';
  db.query(query, [req.params.id]);
  ```

[CRITICAL] Hardcoded API Key (CWE-798)
  File: src/config/api.ts:12
  Issue: API key exposed in source code
  Impact: Unauthorized access, service abuse
  Fix: Move to environment variables
  
HIGH VULNERABILITIES: 5
─────────────────────────────

[HIGH] XSS via innerHTML (CWE-79)
  File: src/components/UserProfile.tsx:45
  Issue: User data rendered without sanitization
  Fix: Use textContent or sanitize with DOMPurify

[HIGH] Weak Password Hashing (CWE-916)
  File: src/auth/password.ts:23
  Issue: Using MD5 for password hashing
  Fix: Use bcrypt, scrypt, or Argon2

[HIGH] Missing Rate Limiting
  File: src/api/login.ts:34
  Issue: No rate limit on authentication endpoint
  Fix: Add express-rate-limit middleware

MEDIUM VULNERABILITIES: 8
──────────────────────────────

[MEDIUM] Outdated Dependency
  Package: express@4.16.0
  Issue: 12 known CVEs (latest: 4.18.2)
  Fix: npm install express@latest

[MEDIUM] Missing HTTPS Enforcement
  File: src/server.ts:10
  Issue: App runs on HTTP in production
  Fix: Enable HTTPS with valid certificate

DEPENDENCY ISSUES: 23
─────────────────────────────

Critical: 3
High: 8
Medium: 12

Top Issues:
  - lodash@4.17.15 (CVE-2020-8203, CVE-2021-23337)
  - axios@0.21.0 (CVE-2021-3749)
  - express@4.16.0 (Multiple CVEs)

COMPLIANCE STATUS
─────────────────────────────

OWASP Top 10 (2021):
  ✓ A01:2021 - Broken Access Control: PASS
  ✗ A02:2021 - Cryptographic Failures: FAIL (3 issues)
  ✗ A03:2021 - Injection: FAIL (2 issues)
  ✓ A04:2021 - Insecure Design: PASS
  ✗ A05:2021 - Security Misconfiguration: FAIL (5 issues)
  ✓ A06:2021 - Vulnerable Components: FAIL (23 issues)
  ✓ A07:2021 - Authentication Failures: PASS
  ✓ A08:2021 - Software Integrity Failures: PASS
  ✗ A09:2021 - Logging Failures: FAIL (1 issue)
  ✓ A10:2021 - SSRF: PASS

Score: 6/10 (60%)

RECOMMENDATIONS
─────────────────────────────

Immediate Actions:
1. Fix SQL injection in users.ts
2. Remove hardcoded API key
3. Update dependencies with critical CVEs
4. Add rate limiting to auth endpoints
5. Switch to bcrypt for passwords

Short Term (1-2 weeks):
1. Enable HTTPS in production
2. Add security headers (CSP, HSTS, X-Frame-Options)
3. Implement input validation middleware
4. Set up dependency scanning in CI/CD
5. Audit session management

Long Term:
1. Implement comprehensive logging
2. Set up SIEM for security monitoring
3. Conduct penetration testing
4. Train team on secure coding practices
5. Establish security review process
```

## Scan Process

1. **Static Analysis**: Parse code for dangerous patterns
2. **Dependency Check**: Query vulnerability databases (npm audit, Snyk, OSSF)
3. **Configuration Review**: Check .env, config files, docker-compose
4. **Secrets Detection**: Scan for API keys, tokens, passwords
5. **OWASP Mapping**: Classify findings to OWASP Top 10
6. **Risk Scoring**: Calculate overall security posture
7. **Generate Report**: Prioritized findings with fixes

## Severity Levels

- **CRITICAL**: Immediate exploitation possible, data breach risk
- **HIGH**: Significant security impact, should fix ASAP
- **MEDIUM**: Moderate risk, fix in next sprint
- **LOW**: Best practice violations, fix when convenient
- **INFO**: Security improvements, not urgent

## Integration

Works with:
- `/code-review` - General code quality + security deep dive
- `/test-generator` - Generate security tests for findings
- `/documentation-writer` - Document security policies

## Configuration

Options:
- `--dependencies-only` - Skip code analysis, check packages only
- `--compliance=OWASP-2021` - Generate compliance report
- `--compliance=PCI-DSS` - PCI-DSS compliance check
- `--fix` - Auto-fix trivial issues (update deps, add headers)
- `--report=json` - Machine-readable output for CI/CD

## Examples

### Example 1: Quick Scan
```
/security-audit src/
```

Output:
```
✓ Scanned 34 files
⚠ 2 critical, 5 high, 8 medium issues
Risk Score: 75/100 (HIGH)
```

### Example 2: Dependency Check
```
/security-audit --dependencies-only
```

Output:
```
Checking 127 dependencies...
✗ 3 critical CVEs found
✗ 12 packages need updates

lodash@4.17.15 → 4.17.21 (fixes CVE-2020-8203)
Run: npm audit fix
```

### Example 3: OWASP Compliance
```
/security-audit --compliance=OWASP-2021
```

Output:
```
OWASP Top 10 (2021) Compliance: 60%
Failing: A02 (Crypto), A03 (Injection), A05 (Config), A06 (Components)
Passing: 6/10
```

## Notes

- Integrates with npm audit, Snyk, GitHub Security Advisories
- Zero false positives goal - only report exploitable issues
- Context-aware - knows framework security patterns
- Fast scanning (<10s for most projects)
- CI/CD ready - returns exit code based on risk level
- Automated fixes where safe (dependency updates, config changes)
