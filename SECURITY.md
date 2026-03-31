# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.x.x   | Yes       |
| 1.x.x   | No        |
| < 1.0   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in 8gent Code, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

### How to Report

1. **Email:** security@8gent.dev
2. **Subject line:** `[SECURITY] Brief description of the vulnerability`
3. **Include:**
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if you have one)

### What to Expect

- **Acknowledgment:** Within 48 hours of your report
- **Assessment:** Within 7 days, we will confirm the vulnerability and its severity
- **Fix timeline:** Critical issues within 72 hours, high within 2 weeks, medium/low within 30 days
- **Disclosure:** We will coordinate with you on public disclosure timing

### Scope

The following are in scope:
- `packages/permissions/` - NemoClaw policy engine
- `packages/daemon/` - Vessel daemon (WebSocket, auth, sessions)
- `packages/kernel/` - RL training pipeline
- `packages/memory/` - SQLite memory store (data leakage, injection)
- `bin/8gent.ts` - CLI entry point
- Any tool execution that bypasses the permission system

The following are out of scope:
- Ollama or OpenRouter upstream vulnerabilities (report to those projects)
- Social engineering attacks
- Denial of service against local installations

## Security Framework

For the full 8GI Security Framework covering governance, threat models, and compliance, see the canonical document in the [8gi-governance repository](https://github.com/8gi-foundation/8gi-governance/blob/main/docs/8GI-SECURITY.md).

## License

8gent Code is licensed under Apache 2.0. See [LICENSE](LICENSE).
