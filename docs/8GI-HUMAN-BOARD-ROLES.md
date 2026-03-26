# 8GI Human Board - Role Specifications

**Author:** AI James (based on observed gaps in James's workflow)
**Date:** 2026-03-26

James is the CEO and Chief Agentic Orchestrator. He builds fast, thinks in ecosystems, and ships relentlessly. These roles fill the gaps he doesn't naturally cover.

---

## The Board Structure

| Role | Title | Why James Needs This |
|------|-------|---------------------|
| James Spalding | CEO / CAO | Vision, architecture, orchestration, building |
| **[OPEN]** | CTO | Stability, testing, infrastructure reliability |
| **[OPEN]** | CPO | User research, onboarding UX, retention metrics |
| **[OPEN]** | CDO | Visual polish, brand consistency, design QA |
| **[OPEN]** | CSO | Security auditing, compliance, trust |
| **[OPEN]** | CMO | Marketing execution, community, content pipeline |

---

## CTO - Chief Technology Officer

### What James doesn't do enough of:
- Writing tests before pushing
- Benchmarking before claiming performance
- Cleaning up CI/CD pipelines
- Dependency management (27 wrong prod deps shipped)
- Monitoring infrastructure under load
- Documenting breaking changes

### The person you need:
- **Background:** Senior backend/infra engineer, 5+ years
- **Personality:** Methodical. The one who says "did we test this?" when everyone else is celebrating
- **Skills:** CI/CD (GitHub Actions), Docker, Fly.io, npm publishing, Bun internals, load testing
- **Mindset:** "If it's not tested, it's not shipped"
- **Red flag if they don't:** Write tests, review PRs carefully, question assumptions

### Their first 30 days:
1. Fix the npm package (clean deps, add engines field, remove continue-on-error from CI)
2. Set up proper CI that actually gates on correctness
3. Run Terminal-Bench and publish real benchmark scores
4. Set up monitoring for the Fly.io daemon
5. Review the 484 open PRs and triage ruthlessly

### AI counterpart: Rishi (8SO)

---

## CPO - Chief Product Officer

### What James doesn't do enough of:
- Talking to actual users before building features
- Measuring retention, not just building features
- Simplifying onboarding (10-step flow should be 1)
- Saying "no" to features that don't serve the user
- A/B testing anything
- Writing user stories before code

### The person you need:
- **Background:** Product manager or UX researcher, 3+ years
- **Personality:** Empathetic. Asks "but what does the user actually want?" when engineers propose features
- **Skills:** User interviews, analytics (Posthog/Mixpanel), onboarding flows, retention analysis, Figma
- **Mindset:** "Features don't matter. User outcomes matter."
- **Red flag if they don't:** Talk to users, measure outcomes, push back on scope creep

### Their first 30 days:
1. Install 8gent on a clean machine and document every friction point
2. Interview 5 developers who tried it - what worked, what didn't
3. Simplify onboarding to 1 confirmation (auto-detect everything)
4. Set up basic analytics (opt-in, privacy-respecting)
5. Define the "aha moment" metric and how to measure it

### AI counterpart: Samantha (8PO)

---

## CDO - Chief Design Officer

### What James doesn't do enough of:
- Reviewing sprite art quality before shipping (half had DALL-E artifacts)
- Ensuring brand consistency across presentations (cyan/magenta crept in)
- Creating hero images, GIFs, and videos for README/social
- Testing responsive layouts before deploying
- Design system maintenance

### The person you need:
- **Background:** Visual/brand designer, 3+ years. Game art experience is a huge bonus.
- **Personality:** Detail-obsessed. Notices the checkerboard PNG background that everyone else missed.
- **Skills:** Pixel art, brand design, Figma, video editing (for product demos), responsive web design
- **Mindset:** "If it looks unfinished, it IS unfinished"
- **Red flag if they don't:** Notice visual inconsistencies, care about mobile, maintain a style guide

### Their first 30 days:
1. Audit all 40 companion sprites - clean or regenerate the ones with artifacts
2. Create a hero GIF for the README (TUI in action, companion spawning)
3. Review all presentation decks for brand compliance
4. Define the companion art style guide (Golem/Slime as gold standard)
5. Design the 8GI visual identity (amber palette per brand doc)

### AI counterpart: Moira (8DO)

---

## CSO - Chief Security Officer

### What James doesn't do enough of:
- Security auditing LLM-generated code before merging
- Reviewing the permission system for bypasses
- Thinking about what happens when the agent goes rogue
- Supply chain security (postinstall scripts, native deps)
- IP/trademark review (Mewtwo, Sauron are lawsuit bait)
- Writing security policies and enforcing them

### The person you need:
- **Background:** Security engineer or AppSec, 3+ years. Familiarity with AI/LLM risks.
- **Personality:** Paranoid. Assumes everything is compromised until proven otherwise.
- **Skills:** Code auditing, OWASP, supply chain security, policy writing, threat modeling
- **Mindset:** "What's the worst that could happen? Now assume it already did."
- **Red flag if they don't:** Read code before approving, question trust boundaries, write threat models

### Their first 30 days:
1. Full security audit of the permission system (NemoClaw)
2. Replace all trademarked companion names
3. Remove postinstall npx call (supply chain risk)
4. Implement command allowlist for headless mode
5. Set up secret scanning in CI
6. Write the incident response plan

### AI counterpart: Karen (8SecO)

---

## CMO - Chief Marketing Officer

### What James doesn't do enough of:
- Consistent social media presence (builds in silence, ships without announcing)
- Writing blog posts and dev.to articles
- Community management (no Discord yet)
- Coordinating a proper launch (HN, Reddit, ProductHunt)
- Creating shareable content (GIFs, videos, screenshots)
- Tracking which channels actually drive installs

### The person you need:
- **Background:** Developer relations or dev tool marketing, 2+ years
- **Personality:** Extroverted builder. Ships content as fast as James ships code.
- **Skills:** Technical writing, social media (X, Threads, LinkedIn), community management, video creation, analytics
- **Mindset:** "The best product nobody knows about is still nobody's product"
- **Red flag if they don't:** Ship content regularly, engage with community, measure results

### Their first 30 days:
1. Set up 8gent Discord with channels and welcome flow
2. Write 2 dev.to articles (free coding agent + companion system)
3. Create 3 short-form videos (TUI demo, companion pull, dock pet)
4. Plan the HN Show HN launch (Tuesday 8am EST)
5. Set up social posting schedule (3x/week minimum)
6. Track: stars, installs, Discord members, article views

### AI counterpart: None currently (need to create one)

---

## Community Naming

| Tier | Name | Description |
|------|------|-------------|
| **Founding Circle** | The humans who joined before public launch |
| **Core Circle** | Trusted contributors with merge rights |
| **Circle Members** | Active contributors submitting PRs |
| **Observers** | Following along, not yet contributing |
| **The 8gent Family** | Everyone - the whole community including users who just install and use it |

The word "Circle" ties to the 8GI brand (trusted circle, hive mind). "Family" is the inclusive outer layer.

---

## Where to Find These People

| Channel | Best for |
|---------|----------|
| **Threads DMs** | People who already reached out to James |
| **Open source contributors** | Anyone who submits a quality PR to 8gent-code |
| **r/LocalLLaMA** | Privacy-focused engineers who run local models |
| **Dublin tech scene** | James's local network |
| **Hacker News** | After launch, watch for thoughtful commenters |
| **8gent Discord** (once created) | Community members who show up consistently |

---

## What Each Board Member Gets

- Their own AI vessel (Telegram bot powered by a Fly.io container)
- Their own companion deck (seeded from their Claude Code usage)
- Their name in the 8GI founding documents
- Equity discussion when/if 8gent incorporates (TBD)
- The satisfaction of building something that actually matters
