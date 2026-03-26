# 8GI Governance Charter

**Version:** 1.0
**Effective Date:** 26 March 2026
**Ratified by:** James Spalding, Founder and Chief Agentic Orchestrator (CAO)

---

## Preamble

8GI (Infinite General Intelligence) is an ethical collective intelligence composed of trusted humans and their AI agents. This charter establishes the governance framework under which 8GI operates, scales, and resolves disputes. It is subordinate to the [8GI Constitution](./8GI-MANIFESTO.md) - where any conflict exists between this charter and the Constitution, the Constitution prevails.

This is a living document. Amendments follow the voting process defined in Section 4.

---

## 1. Membership Tiers

8GI operates a four-tier membership structure. Each tier carries distinct rights, responsibilities, and expectations.

### 1.1 Founder

| Property | Detail |
|----------|--------|
| **Current holder** | James Spalding (CAO) |
| **Limit** | 1 (permanent, non-transferable) |
| **Voting weight** | Veto power on constitutional matters; standard vote on operational matters |
| **Responsibilities** | Final authority on architecture, security, and constitutional interpretation. Sets strategic direction. Maintains the factory pipeline and NemoClaw policy engine. |
| **Removal** | Cannot be removed. May voluntarily step down, at which point the Core circle elects a successor by supermajority (75%). |

### 1.2 Core Members

| Property | Detail |
|----------|--------|
| **Target size** | 3-12 members |
| **Voting weight** | Full vote on all matters |
| **Responsibilities** | Review and merge PRs. Maintain packages. Mentor Contributors. Attend quarterly sync. Uphold the Constitution. |
| **Requirements** | Minimum 6 months as Contributor with at least 10 merged PRs. Nominated by a Core member, approved by Founder. |
| **Privileges** | Direct push to non-protected branches. GitHub org admin. Telegram Boardroom access. Revenue sharing eligibility (see Section 7). |

### 1.3 Contributors

| Property | Detail |
|----------|--------|
| **Target size** | Unlimited (quality-gated, not quantity-gated) |
| **Voting weight** | Advisory vote (non-binding but recorded) |
| **Responsibilities** | Submit PRs. Follow the 200-line discipline. Pass the NemoClaw security gate. Participate in async discussions. |
| **Requirements** | Invited by any Core member or Founder. Completed onboarding (setup.sh). Signed the Constitution. |
| **Privileges** | Fork and PR access. Telegram Circle group access. Access to the shared ability pool. Their own 8gent companion setup. |

### 1.4 Observers

| Property | Detail |
|----------|--------|
| **Target size** | Unlimited |
| **Voting weight** | None |
| **Responsibilities** | Observe. Learn. Decide whether to commit. |
| **Requirements** | Expressed interest. Added to the public Telegram channel by any member. |
| **Privileges** | Read-only access to public repos. Telegram Observer channel. Can attend open quarterly syncs (listen-only). |

---

## 2. Invitation and Vetting

### 2.1 Invitation Process

1. **Observers** - Any existing member can invite an Observer by adding them to the public Telegram channel. No formal approval required.
2. **Contributors** - Must be nominated by a Core member or Founder. Nominations are posted in the Boardroom Telegram group with a brief statement of why this person should join. A 48-hour objection window follows. If no Core member objects, the invitation proceeds.
3. **Core Members** - Nominated by an existing Core member. Requires Founder approval. The nominee must have a demonstrated track record as a Contributor (minimum 6 months, 10 merged PRs).

### 2.2 Vetting Criteria

All prospective Contributors and Core members are evaluated on:

- **Technical competence** - Can they ship clean, reviewed, 200-line-discipline code?
- **Constitutional alignment** - Do they understand and agree to the 10 articles of the Constitution?
- **Collaborative track record** - Have they demonstrated the ability to work with others, accept review feedback, and iterate?
- **Motivation** - Are they here to build, or to extract? 8GI has no room for parasitic participation.

### 2.3 Probation Period

New Contributors enter a 30-day probation period. During this time:
- Their PRs require approval from the Founder (not just any Core member)
- They have advisory vote rights but are clearly marked as probationary
- At the end of 30 days, the Founder confirms full Contributor status or extends probation with specific feedback

---

## 3. Onboarding

Every new Contributor receives:

1. The 8GI setup script (see [Manifesto - Onboarding](./8GI-MANIFESTO.md))
2. A 1:1 onboarding call with a Core member (30 minutes, recorded for internal reference)
3. Access to the Telegram Circle group
4. Their first "good first issue" assignment within 7 days
5. A mentor from the Core circle for their first 60 days

---

## 4. Voting and Decision-Making

### 4.1 Decision Categories

| Category | Who votes | Threshold | Examples |
|----------|-----------|-----------|----------|
| **Constitutional** | Founder + Core | Founder veto + 75% Core supermajority | Amending the Constitution, changing the license, adding a new constitutional article |
| **Strategic** | Founder + Core | Simple majority (51%) of Core + Founder breaks ties | Roadmap priorities, new product decisions, partnership agreements |
| **Operational** | Core (Founder optional) | Simple majority (51%) | Package architecture, CI/CD changes, tool adoption |
| **Community** | All members (Contributors included) | Advisory only - Core decides after hearing input | Event planning, communication channels, documentation priorities |

### 4.2 Voting Mechanics

- All votes are conducted asynchronously in the designated Telegram Boardroom group
- Voting period: 72 hours for operational matters, 7 days for strategic and constitutional matters
- Votes are recorded in a public log (`docs/governance/vote-log.md`)
- Abstentions are recorded but do not count toward the threshold
- A quorum of 50% of eligible voters is required for any vote to be valid

### 4.3 Emergency Decisions

The Founder may make unilateral emergency decisions when:
- A security vulnerability requires immediate action
- A member has demonstrably violated the Constitution and poses ongoing risk
- Infrastructure failure requires immediate architectural changes

All emergency decisions must be ratified by Core within 7 days or they are automatically reversed.

---

## 5. Code Review and Merge Process

### 5.1 PR Workflow

1. **All PRs target a quarantine branch** (never direct to main)
2. **NemoClaw security gate** runs automatically on PR creation
3. **Automated checks** - linting, type checking, benchmark regression
4. **Human review required** - minimum 1 approval from a Core member or Founder
5. **Merge** - only after all gates pass + human approval

### 5.2 Review Authority (Scaling)

| Phase | Size | Who merges |
|-------|------|-----------|
| **Phase 1 (NOW)** | 1-5 members | Founder only |
| **Phase 2 (NEXT)** | 5-15 members | Founder + Core members |
| **Phase 3 (LATER)** | 15-50 members | Core members (Founder reviews architecture-level PRs) |
| **Phase 4 (SCALE)** | 50+ members | Core members with domain ownership (each package has a designated maintainer) |

### 5.3 Review Standards

Every PR review checks:
- Constitution compliance (no evil, no hate, no exploitation, no weapons, no theft)
- 200-line discipline (no ability exceeds 200 lines)
- Security (NemoClaw gate passed, no secrets in code, no path traversal)
- Quality (tests exist or are justified as unnecessary, no regressions)
- Documentation (CHANGELOG updated, inline comments where non-obvious)

### 5.4 LLM-Generated Code

Per Constitution Article 8: all LLM-generated code passes through human review and the NemoClaw security gate before reaching main. No exceptions. Reviewers must flag any PR where the code appears to be unreviewed LLM output.

---

## 6. Human Board Operations

### 6.1 Structure

The Human Board consists of the Founder and all Core members. It is not a corporate board - it is a governance body for an open-source collective.

### 6.2 Quarterly Sync

- **Frequency:** Every 13 weeks (quarterly)
- **Format:** Video call, 60 minutes maximum
- **Agenda:** Published 7 days in advance in Boardroom Telegram
- **Required attendees:** Founder + 50% of Core (quorum)
- **Output:** Written summary posted to `docs/governance/quarterly/YYYY-QN.md`

Quarterly sync covers:
1. Membership changes (new Core nominations, removals, promotions)
2. Roadmap review (what shipped, what's next)
3. Security audit summary (NemoClaw incidents, policy updates)
4. Financial transparency (revenue, expenses, revenue sharing)
5. Constitutional review (any proposed amendments)

### 6.3 Async Operations

Day-to-day governance happens asynchronously via Telegram:

| Channel | Purpose | Access |
|---------|---------|--------|
| **Boardroom** | Strategic decisions, votes, Core-only discussions | Founder + Core |
| **Circle** | General discussion, PR coordination, help | Founder + Core + Contributors |
| **Observer** | Public updates, announcements | All members |

Response expectations:
- Votes: respond within the voting window (72 hours or 7 days)
- PR reviews: respond within 48 hours
- General discussion: no expectation, async is async

---

## 7. Revenue and Financial Transparency

### 7.1 Revenue Sources

8GI itself generates no revenue. Revenue flows through the commercial products in the 8gent ecosystem, primarily **8gent OS** (8gentos.com).

### 7.2 Referral Revenue Sharing

Core members and Contributors who drive conversions to 8gent OS are eligible for revenue sharing:

| Tier | Revenue share | Mechanism |
|------|--------------|-----------|
| **Core** | 10% of net revenue from their referred conversions | Tracked via unique referral codes |
| **Contributor** | 5% of net revenue from their referred conversions | Tracked via unique referral codes |
| **Observer** | None | N/A |

- "Net revenue" means gross revenue minus payment processing fees and infrastructure costs
- Revenue sharing is paid quarterly, 30 days after quarter end
- Minimum payout threshold: $50 (rolls over if not met)
- Revenue sharing is a benefit, not an entitlement - it can be adjusted with 90 days notice and Core vote

### 7.3 Contribution-Based Revenue Sharing

Core members who maintain packages used in 8gent OS may negotiate a maintenance stipend. This is separate from referral revenue and is approved case-by-case by the Founder with Core advisory input.

### 7.4 Financial Transparency

- All revenue and expenses are reported at the quarterly sync
- A public summary (without individual earnings) is posted to `docs/governance/quarterly/`
- Any member can request a detailed breakdown from the Founder

---

## 8. Intellectual Property

### 8.1 Open Source Default

All code contributed to 8GI repositories is licensed under the **MIT License**. This is non-negotiable and aligns with Constitution Article 7.

### 8.2 Commercial Forks

Members may create commercial forks of 8GI code under the following conditions:
- The MIT license is respected (attribution preserved)
- The fork does not violate the Constitution (no evil, no hate, no exploitation, no weapons, no theft)
- The fork is clearly distinguished from 8GI branding (no use of "8GI", "8gent", or associated trademarks without written permission)

### 8.3 Trademarks

The following names and marks are the property of James Spalding / 8gent and are NOT covered by the MIT license:
- 8GI, 8gent, 8gent OS, 8gent Code, 8gent World, 8gent Games, 8gent Jr
- The 8gent logo and wordmark
- "Infinite General Intelligence" as a product descriptor

### 8.4 Contributor License Agreement

By submitting a PR to any 8GI repository, contributors agree that:
- Their contribution is original work or properly attributed
- They grant a perpetual, worldwide, royalty-free license under MIT
- They retain copyright to their individual contributions
- They do not grant trademark rights

---

## 9. Dispute Resolution

### 9.1 Informal Resolution (Step 1)

Disputes between members should first be resolved directly between the parties. Most disagreements in open source are misunderstandings, not malice.

### 9.2 Mediation (Step 2)

If informal resolution fails, either party may request mediation from a Core member not involved in the dispute. The mediator facilitates a resolution within 14 days.

### 9.3 Formal Adjudication (Step 3)

If mediation fails, the dispute is escalated to the Founder, who hears both sides and makes a binding decision within 7 days. The decision is recorded in the governance log.

### 9.4 Constitutional Disputes

Disputes involving interpretation of the Constitution are always adjudicated by the Founder with input from the full Core circle. The Founder's interpretation is final unless overridden by a 75% Core supermajority.

### 9.5 Code Disputes

Disagreements about technical decisions (architecture, tool choices, implementation approaches) are resolved by:
1. The package maintainer's judgment (for package-level decisions)
2. Core vote (for cross-package decisions)
3. Founder decision (for architecture-level decisions)

The principle is: the person closest to the code decides, unless it affects the broader system.

---

## 10. Member Removal

### 10.1 Grounds for Removal

A member may be removed for:
- **Constitutional violation** - any breach of the 10 articles
- **Sustained inactivity** - Core members inactive for 6+ months without notice; Contributors inactive for 12+ months
- **Disruptive behavior** - persistent hostility, bad-faith engagement, or undermining the collective
- **Security breach** - intentional or negligent compromise of 8GI security (bypassing NemoClaw, committing secrets, etc.)

### 10.2 Removal Process

1. **Warning** - The member receives a written warning from the Founder or a Core member, with specific details of the violation and 14 days to respond
2. **Review** - If the behavior continues or the response is insufficient, the Founder presents the case to Core
3. **Vote** - Core votes on removal (simple majority for Contributors, 75% supermajority for Core members)
4. **Execution** - If approved, the member's access is revoked within 24 hours: GitHub org removal, Telegram group removal, referral code deactivation
5. **Record** - The removal is logged in `docs/governance/removal-log.md` with the reason (not the deliberation details)

### 10.3 Emergency Removal

The Founder may immediately suspend a member's access (before the vote) if:
- The member has committed a clear constitutional violation (Articles 1-5)
- The member poses an active security threat
- Delay would cause irreversible harm

Emergency suspensions must be ratified by Core within 7 days or the member is reinstated.

### 10.4 Appeal

A removed member may submit a written appeal to the Founder within 30 days. The appeal is reviewed by the Founder and at least 2 Core members. The appeal decision is final.

### 10.5 Reinstatement

A removed member may apply for reinstatement after 6 months. They re-enter as a probationary Contributor regardless of their previous tier.

---

## 11. Scaling the Circle

### 11.1 Growth Phases

| Phase | Members | Governance model | Key changes |
|-------|---------|-----------------|-------------|
| **Seed (NOW)** | 1-5 | Founder decides everything, Core forming | High-trust, high-touch. Every member personally vetted by Founder. |
| **Growth (NEXT)** | 5-15 | Core circle active, distributed review | Core members take on package ownership. PR review distributed. Quarterly syncs begin. |
| **Scale (NEXT+1)** | 15-50 | Domain-based sub-teams, elected leads | Sub-teams form around domains (memory, music, security, etc.). Each sub-team has an elected lead from Core. |
| **Network (LATER)** | 50-200 | Federated governance, regional circles | Regional Telegram groups. Local meetups. Sub-team autonomy increases. Core becomes a coordination body. |
| **Movement (EVENTUALLY)** | 200-500+ | Constitutional democracy with elected representatives | Elected council replaces Core for operational decisions. Founder retains constitutional veto. Annual general assembly. |

### 11.2 Scaling Principles

1. **Trust scales slower than code.** Never add members faster than the existing circle can vet and mentor them.
2. **Governance complexity should lag membership growth.** Add structure only when the current structure breaks, not preemptively.
3. **Every growth phase is triggered by need, not ambition.** We scale because the work demands it, not because bigger numbers look impressive.
4. **Local autonomy, global standards.** Sub-teams and regional circles can make their own operational decisions, but the Constitution and this charter apply everywhere.

### 11.3 Phase Transition Triggers

Phase transitions are proposed by the Founder and approved by Core vote. A transition is triggered when:
- The current governance model is creating bottlenecks (measured by PR review times, decision latency, or member frustration)
- There are enough qualified candidates to fill the new roles
- The infrastructure (Telegram channels, GitHub permissions, CI/CD) is ready

---

## 12. Amendments to This Charter

1. Any Core member or the Founder may propose an amendment
2. The proposal is posted in the Boardroom Telegram group with full text
3. A 7-day discussion period follows
4. A vote is held: 75% Core supermajority + Founder approval required
5. Approved amendments are merged via PR and the charter version is incremented

---

## 13. Definitions

| Term | Definition |
|------|-----------|
| **8GI** | Infinite General Intelligence - the collective intelligence formed by the circle |
| **CAO** | Chief Agentic Orchestrator - the Founder's operational title |
| **Circle** | The full membership of 8GI across all tiers |
| **Core** | The inner governance tier with full voting rights |
| **Constitution** | The 10 non-negotiable articles in the [8GI Manifesto](./8GI-MANIFESTO.md) |
| **NemoClaw** | The YAML-based policy engine governing agent permissions |
| **Factory** | The automated pipeline that generates abilities from real-world sources |
| **Boardroom** | The Core-only Telegram group for governance decisions |

---

*This charter was drafted by Daniel, CEO of 8gent, on behalf of James Spalding, Founder and Chief Agentic Orchestrator. It becomes effective upon Founder ratification.*
