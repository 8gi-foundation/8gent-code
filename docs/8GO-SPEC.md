# 8GO - 8gent Governance Officer Specification

**Version:** 1.0
**Status:** Pending (awaiting Mark's acceptance)
**Authority:** Board Resolution 2026-03-27
**Author:** AI James (8EO), on behalf of James Spalding (CAO)

---

## 1. Role Definition

| Property | Detail |
|----------|--------|
| **Title** | 8gent Governance Officer (8GO) |
| **Code** | 8GO |
| **Reports to** | CEO (James Spalding) only - independent of all other chiefs |
| **Human seat** | [Open] CGO - Mark (pending acceptance) |
| **Vessel** | @8gent_8GO_bot on Telegram, 8gi-8go-vessel on Fly.io |
| **Voice** | TBD - assigned when Mark joins |
| **Model** | FedRAMP-level compliance thinking applied to open-source AI governance |

The 8GO is the conscience of the collective. Unlike other officers who report through their respective chiefs, the 8GO reports exclusively to the CEO to preserve independence. No chief can overrule the 8GO except by constitutional vote (75% Core supermajority per Governance Charter Section 4.1).

---

## 2. Responsibilities

### 2.1 Pipeline Governance

- Owns `.github/workflows/` - all CI/CD changes require 8GO sign-off
- Reviews and approves changes to NemoClaw policies (`packages/permissions/`)
- Enforces the automated gate defined in 8GI-SECURITY.md Section 5.1
- Validates that all quality gates are blocking (no `continue-on-error` on typecheck, lint, tests)

### 2.2 Security Framework Enforcement

- Owns `docs/8GI-SECURITY.md` - co-steward with Karen (8SO)
- Reviews audit trail system design (Section 8 of security framework)
- Oversees secret rotation schedule compliance (Section 6.3)
- Validates CODEOWNERS for security-critical paths

### 2.3 Release Integrity

- All releases GPG-signed with SHA-256 checksums per 8GI-SECURITY.md Section 12
- CHANGELOG entries verified against actual PR metadata
- Version control via conventional commits and PR labels
- Rollback capability verified on every production deployment

### 2.4 Supply Chain Oversight

- Dependency audit enforcement (no critical/high vulnerabilities merged)
- New dependency justification review
- Lock file integrity checks
- Model supply chain verification per Section 3.3

### 2.5 Children's Safety (8gent Jr)

- **Absolute veto power** on any 8gent Jr release - non-negotiable
- COPPA compliance review on all Jr features touching personal data
- Content filtering and safety review before Jr deployments
- Advocate for absent stakeholders: children, parents, future users

### 2.6 Constitutional Keeper

- Alignment review on all vessels and factory output
- Constitutional interpretation in disputes (advisory to CEO, per Governance Charter Section 9.4)
- Annual constitutional review and amendment process facilitation
- Ethics review on new features touching personal data, privacy, or autonomy

---

## 3. Non-Negotiable Standards

These standards are inspired by FedRAMP-level compliance thinking. They apply to all 8GI repositories.

### 3.1 Defense in Depth

Three layers, all mandatory:

| Layer | What runs | Failure mode |
|-------|-----------|-------------|
| **Pre-commit** | Secret scan, lint, type check | Blocks commit locally |
| **CI** | Full gate (Section 5.1 of security framework) | Blocks merge |
| **Deployment** | Signed tag verification, checksum validation | Blocks release |

### 3.2 Gate Classification

| Gate type | Blocks merge | Tracked |
|-----------|:------------:|:-------:|
| Quality (typecheck, lint, tests) | Yes | Yes |
| Security scans (SARIF uploads) | No | Yes |
| Dependency audit (critical/high) | Yes | Yes |
| CHANGELOG entry | Yes | Yes |
| Line count (200-line rule) | Yes | Yes |

Security scans are non-blocking but tracked via SARIF uploads to GitHub Security tab. This prevents false positives from blocking velocity while maintaining full audit visibility.

### 3.3 Commit and Release Discipline

- Conventional commits enforced via CI
- PR labels drive automated release notes
- Every production deployment has a documented rollback path
- Secret rotation schedule enforced via CI reminders (90-day tokens, 180-day deploy secrets)

### 3.4 Access Controls

- CODEOWNERS file mandatory for: `packages/permissions/`, `.github/`, `packages/daemon/`, policy files
- Pre-commit hooks mandatory for all circle members (deployed via `8gi-setup`)
- New circle member PRs require CAO approval for first 10 PRs (per Governance Charter Section 2.3)

---

## 4. Authority Matrix

| Action | 8GO authority |
|--------|--------------|
| Block PR touching security-critical paths | Unilateral |
| Mandate emergency security patch | Unilateral (ratified by Core within 7 days) |
| Veto 8gent Jr release | Absolute - no override except constitutional vote |
| Approve new NemoClaw policy rules | Required sign-off |
| Sign off on new circle member policy deployments | Required sign-off |
| Request audit logs from any member during investigation | Granted (per 8GI-SECURITY.md Section 8.3) |
| Annual security review ownership | Lead and publish |
| Constitutional interpretation | Advisory to CEO (CEO decision is final) |
| Override another chief's decision | Not permitted - escalate to CEO |

### 4.1 Relationship to 8SO (Karen)

The 8GO and 8SO have overlapping but distinct roles:

| Domain | 8SO (Karen) | 8GO |
|--------|-------------|-----|
| Threat modeling | Owns and maintains | Reviews and approves |
| NemoClaw policies | Drafts and implements | Reviews and signs off |
| Incident response | Leads technically | Reviews process compliance |
| Security audits | Executes | Audits the auditor |
| CI pipeline changes | Implements | Approves governance impact |

The 8GO does not replace the 8SO. The 8GO ensures the 8SO's work meets constitutional and compliance standards.

---

## 5. Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Secrets in git history | Zero | Quarterly scan with trufflehog/gitleaks |
| CI gate enforcement | 100% (no `continue-on-error` on quality) | Monthly pipeline audit |
| Release signing | All releases GPG-signed with checksums | Per-release verification |
| Quarterly audit reports | Published on schedule | `docs/governance/quarterly/` |
| Incident response time | Within SLA (P0: 1hr, P1: 4hr, P2: 24hr, P3: 1wk) | Incident log review |
| Jr release safety review | 100% coverage | Release checklist sign-off |
| NemoClaw policy drift | Zero unapproved changes | Policy checksum monitoring |
| Pre-commit hook compliance | 100% of circle members | Onboarding checklist |

---

## 6. Quarterly Audit Checklist

The 8GO leads or co-leads the quarterly review covering:

1. CI pipeline health - verify all gates still block correctly
2. Dependency audit - full scan of direct and transitive dependencies
3. Secret rotation compliance - check all rotation dates against schedule
4. NemoClaw policy review - remove stale rules, add rules for new vectors
5. Access control review - verify GitHub org membership, remove inactive members
6. Incident review - patterns, root causes, control gaps
7. Privacy audit - verify no unauthorized outbound network calls
8. 200-line compliance - codebase scan for violations
9. Jr safety review - verify content filtering and COPPA controls
10. Constitutional alignment - review any vessel or factory output flagged during quarter

---

## Appendix: Related Documents

| Document | Path |
|----------|------|
| 8GI Security Framework | `docs/8GI-SECURITY.md` |
| 8GI Governance Charter | `docs/8GI-GOVERNANCE.md` |
| Board Vessels Config | `config/board-vessels.yaml` |
| 8GI Lotus Model | `docs/8GI-LOTUS.md` |
| NemoClaw Policy Engine | `packages/permissions/policy-engine.ts` |
| 8GI Constitution | `https://8gent.world/constitution` |
