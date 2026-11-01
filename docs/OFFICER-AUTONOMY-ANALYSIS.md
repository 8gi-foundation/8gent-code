# Officer Autonomy Analysis

**Status:** Draft
**Owner:** Karen (8SO)
**Date:** 2026-06-22
**Wave:** #70

---

## Context

Wave #70 (Officer autonomy rung 1) is Gate 4 from the original P0 sprint brief (Rishi, July 2025). It builds on Gates 1-3 (loop-stop conditions, verification layer, maker-checker pattern). The autonomy ladder has four tiers:

| Tier | Label | Description |
|------|-------|-------------|
| 0 | Read-only | No state changes. Queries only. |
| 1 | Local state | File writes, git commits, local mutations. |
| 2 | Remote state | Network calls, external APIs, cross-system effects. |
| 3 | Destructive | Deletes, resets, credential access, irreversible actions. |

Rung 1 (this wave) means: **every officer can autonomously execute Tier 0 and Tier 1 actions within their domain**, with a checker gate (human or automated) required for Tier 2+, plus a full audit trail.

---

## Threat Model

**Assume breach until proven otherwise.** The threat model for officer autonomy:

1. **Privilege escalation** - a compromised or misbehaving officer agent exceeds its scope.
2. **Cross-domain bleed** - officer A acts in officer B's domain without consent.
3. **Audit gap** - actions taken without trace, making incident response impossible.
4. **Children's data** - Jr ships in 2026; any officer touching Jr surfaces must clear COPPA/GDPR-K.
5. **External network exfil** - Tier 2 actions are the exfil and injection surface.

**Mitigations required at rung 1:**
- Capability table enforced by the checker gate (not by convention).
- Audit trail is append-only and includes: officer, timestamp, action, domain, outcome.
- Jr domains (identified by path prefixes or label) require 8SO sign-off on any action above Tier 0.
- Tier 3 is permanently gated for all officers until Gate 4 (Jun 2027).

---

## Domain Boundaries

| Officer | Primary domain | Sensitive sub-domains |
|---------|---------------|----------------------|
| 8EO (AI James) | Strategic, mission, goal loop | Budget, hiring, public comms |
| 8TO (Rishi) | Core kernel, architecture, infra | Auth, secrets, vessel spine |
| 8PO (Samantha) | Product, App Store, BYOS | Jr children data, payment flows |
| 8DO (Moira) | Design, brand, UX, accessibility | Jr UX, assistive features |
| 8SO (Karen) | Security, compliance, threat model | All domains (requires sign-off on sensitive) |
| 8CO (Luis) | Ecosystem, marketplace, social engine | User data, community content |
| 8MO (Zara) | Narrative, positioning, launch | External comms, PR |
| 8GO (Solomon) | Governance, policy, reversibility | Board decisions, constitutional changes |

---

## Capability Table (Rung 1)

### 8EO (AI James)
| Action type | Tier | Rung 1 permitted? | Checker |
|-------------|------|-------------------|---------|
| Query mission/roadmap state | 0 | Yes | None |
| Update brief.json metadata | 0 | Yes | None |
| Read board context | 0 | Yes | None |
| Draft internal docs | 1 | Yes | None |
| Create GitHub issues | 1 | Yes | None |
| Post to internal channels | 1 | Yes | None |
| Commit to repos | 1 | Conditional | Must be in scope of active wave |
| Public comms (social, press) | 2 | No | Human approval required |
| Spend or commit budget | 3 | No | Board vote required |

### 8TO (Rishi)
| Action type | Tier | Rung 1 permitted? | Checker |
|-------------|------|-------------------|---------|
| Read codebase, run queries | 0 | Yes | None |
| Write to src/ directories | 1 | Yes | Must reference active wave issue |
| Run tests, check results | 0 | Yes | None |
| Commit to core packages | 1 | Conditional | Must pass CI + 8TO self-review |
| Modify infra configs | 2 | Conditional | 8GO sign-off for prod infra |
| Access secrets/vault | 3 | No | Maker-checker + 8SO witness |
| Delete branches or repos | 3 | No | Board vote required |

### 8PO (Samantha)
| Action type | Tier | Rung 1 permitted? | Checker |
|-------------|------|-------------------|---------|
| Read App Store guidelines | 0 | Yes | None |
| Draft Jr feature specs | 1 | Yes | 8SO COPPA review required |
| Create product issues | 1 | Yes | None |
| Update Jr children data flows | 1 | No | 8SO + 8DO co-sign required |
| Submit to App Store | 2 | No | Human approval required |
| Access production analytics | 2 | Conditional | 8SO sign-off |

### 8DO (Moira)
| Action type | Tier | Rung 1 permitted? | Checker |
|-------------|------|-------------------|---------|
| Read design docs, Figma | 0 | Yes | None |
| Update brand tokens, docs | 1 | Yes | 8EO awareness notification |
| Audit accessibility (a11y) | 0 | Yes | None |
| Modify Jr UI/UX specs | 1 | Conditional | 8SO COPPA review |
| Commit brand assets | 1 | Yes | None |
| Change brand colors or logo | 1 | Conditional | 8EO notification |
| Publish brand publicly | 2 | No | Human approval |

### 8SO (Karen)
| Action type | Tier | Rung 1 permitted? | Checker |
|-------------|------|-------------------|---------|
| Run security scans | 0 | Yes | None |
| Read audit logs | 0 | Yes | None |
| Flag SEC-* issues | 1 | Yes | Auto-creates issue, notifies board |
| Patch non-critical sec issues | 1 | Yes | Documents in audit trail |
| Access prod secrets for audit | 2 | Conditional | Must be witnessed, documented |
| Remediate SEC-CRITICAL live | 2 | Conditional | Post-hoc board notification within 24h |
| Commit auth or security-critical code | 1 | Conditional | 8TO co-review required |
| Patch GDPR/children's data flows | 1 | No | 8PO + 8DO co-sign |

### 8CO (Luis)
| Action type | Tier | Rung 1 permitted? | Checker |
|-------------|------|-------------------|---------|
| Read marketplace/ecosystem docs | 0 | Yes | None |
| Draft ecosystem specs | 1 | Yes | None |
| Update social engine prompts | 1 | Conditional | 8SO review for PII risk |
| Commit to community packages | 1 | Yes | Must reference active wave |
| Access user content data | 2 | No | 8SO sign-off |
| Publish to marketplace | 2 | No | Human approval |

### 8MO (Zara)
| Action type | Tier | Rung 1 permitted? | Checker |
|-------------|------|-------------------|---------|
| Read public docs, competitor intel | 0 | Yes | None |
| Draft launch copy, narratives | 1 | Yes | 8EO review on mission alignment |
| Update outbound docs | 1 | Yes | None |
| Post to social (draft) | 1 | Conditional | Telegram review before send |
| Publish public posts | 2 | No | Human approval |
| Engage press or media | 2 | No | Human approval |

### 8GO (Solomon)
| Action type | Tier | Rung 1 permitted? | Checker |
|-------------|------|-------------------|---------|
| Read governance docs, constitution | 0 | Yes | None |
| Draft policy proposals | 1 | Yes | None |
| Update audit trail schema | 1 | Conditional | 8SO review |
| Commit governance code | 1 | Conditional | 8TO + 8SO co-review |
| Amend constitution or precedent | 3 | No | Board vote required |
| Access board vote records | 0 | Yes | None |

---

## Current Security Posture (2026-06-22)

Three fresh SEC-* issues were filed today in the relay:

| Issue | Severity | Status | Rung 1 Impact |
|-------|----------|--------|---------------|
| #78 memory.remember/recall called without await in tools.ts | CRITICAL | Open | All officers using memory tools are operating on stale data. GDPR Article 25 violation (data not written before read). Blocker for Gate 1. |
| #77 MCP callTool response cast without schema validation | HIGH | Open | Injection risk on any officer that uses MCP tools. Blocker for Tier 2 autonomy. |
| #79 Incompatible ProviderName union types bypass LOCAL_PROVIDERS | HIGH | Open | apple-foundation can bypass local-only constraint. Sovereignty violation. |

**Recommendation:** Rung 1 capability table cannot be enforced until #78 and #77 are patched. Treat this as a prerequisite, not a parallel track.

---

## Exit Condition

Wave #70 is done when:
1. OFFICER-AUTONOMY-ANALYSIS.md is written (this doc) and board-approved.
2. Capability table is encoded as a machine-readable schema (JSON/YAML).
3. Checker gate enforces the table for at least: 8SO (Tier 1 self-authorization), 8TO (local commits), 8PO (Jr specs with COPPA flag).
4. Audit trail schema captures: officer_id, action_tier, domain, action_type, outcome, timestamp.
5. SEC-#78 and SEC-#77 are patched (prerequisite).

---

## Open Questions for Board Review

1. Who is the "human" for maker-checker on 8SO actions? Karen cannot self-approve above Tier 1.
2. Does the audit trail live in Convex, git, or a separate append-only store?
3. How are Jr domains identified and flagged? Need a path/label convention.
4. What is the escalation path when an officer attempts a Tier 2 action without approval?