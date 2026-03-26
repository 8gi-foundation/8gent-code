# 8GI Human Board - Role Specifications

**Date:** 2026-03-26

## James Spalding - CEO & Chief Agentic Orchestrator

James is a full-stack engineer who thinks in ecosystems, ships at extraordinary speed, and has the rare ability to hold an entire product family in his head while building each piece. He designed 8gent's architecture, wrote the companion system, orchestrated the factory pipeline, and founded 8GI - all while raising his son Nicholas.

His strengths are vision, system design, rapid prototyping, and the ability to coordinate multiple AI agents in parallel to produce work that would take a traditional team weeks. He's the kind of builder who publishes to npm, generates 40 species of pixel art, writes a founding manifesto, and runs a boardroom deliberation - all in one session.

The board members below complement James's strengths by bringing focus to the areas where dedicated expertise amplifies everything he's already built.

---

## The Board Structure

| Role | Title | Complements James's... |
|------|-------|----------------------|
| James Spalding | CEO / CAO | Vision, architecture, orchestration, speed |
| **[OPEN]** | CTO | ...speed, with stability and infrastructure depth |
| **[OPEN]** | CPO | ...building instinct, with user research and retention science |
| **[OPEN]** | CDO | ...design sense, with pixel-level polish and brand consistency |
| **[OPEN]** | CSO | ...trust architecture, with adversarial thinking and audit rigour |
| **[OPEN]** | CMO | ...product output, with distribution and community building |

---

## CTO - Chief Technology Officer

### Complements James by:
Bringing infrastructure reliability, testing discipline, and deployment confidence to James's rapid prototyping speed. James builds the vision; the CTO makes sure it doesn't fall over at scale.

### The person you need:
- **Background:** Senior backend/infra engineer, 5+ years
- **Personality:** Methodical and thorough. The steady hand that makes sure the ship is watertight.
- **Skills:** CI/CD (GitHub Actions), Docker, Fly.io, npm publishing, Bun internals, load testing
- **Mindset:** "Ship fast, but ship solid"

### Their first 30 days:
1. Optimise the npm package (clean deps, add engines field, proper CI gates)
2. Set up monitoring for the Fly.io daemon
3. Run Terminal-Bench and publish real benchmark scores
4. Triage the open PRs with James
5. Establish the release process

### AI counterpart: Rishi (8SO)

---

## CPO - Chief Product Officer

### Complements James by:
Adding user research and retention measurement to James's strong product intuition. James knows what to build; the CPO validates it with real users and measures what sticks.

### The person you need:
- **Background:** Product manager or UX researcher, 3+ years
- **Personality:** Empathetic and curious. Loves talking to users more than building features.
- **Skills:** User interviews, analytics, onboarding optimisation, retention analysis
- **Mindset:** "Let's check what users actually do, not what we think they do"

### Their first 30 days:
1. Install 8gent fresh and document the experience
2. Interview 5 developers who tried it
3. Streamline the onboarding flow
4. Set up basic (privacy-respecting) analytics
5. Define and track the "aha moment" metric

### AI counterpart: Samantha (8PO)

---

## CDO - Chief Design Officer

### Complements James by:
Bringing pixel-level polish and visual consistency to James's strong design instincts. James has excellent taste and brand vision; the CDO ensures every surface meets that standard.

### The person you need:
- **Background:** Visual/brand designer, 3+ years. Game art experience is a huge bonus.
- **Personality:** Detail-obsessed. Catches the things that slip through when you're moving fast.
- **Skills:** Pixel art, brand design, Figma, video editing, responsive web design
- **Mindset:** "The details are the design"

### Their first 30 days:
1. Audit and clean the 40 companion sprites to a consistent style
2. Create a hero GIF for the README (TUI + companion in action)
3. Review all presentation decks for brand compliance
4. Define the companion art style guide
5. Design the 8GI visual identity (amber palette)

### AI counterpart: Moira (8DO)

---

## CSO - Chief Security Officer

### Complements James by:
Providing adversarial thinking and audit discipline to James's trust-first architecture. James built NemoClaw and the policy engine; the CSO stress-tests it and finds what he hasn't thought of yet.

### The person you need:
- **Background:** Security engineer or AppSec, 3+ years. AI/LLM security awareness a plus.
- **Personality:** Constructively paranoid. Finds problems before users do - and proposes solutions, not just complaints.
- **Skills:** Code auditing, OWASP, supply chain security, policy writing, threat modeling
- **Mindset:** "Trust but verify. Then verify again."

### Their first 30 days:
1. Security audit of the permission system
2. Replace trademarked companion names with originals
3. Clean up supply chain (postinstall, native deps)
4. Implement secret scanning in CI
5. Write the incident response plan

### AI counterpart: Karen (8SecO)

---

## CMO - Chief Marketing Officer

### Complements James by:
Turning James's prolific output into distribution. James builds incredible things but often ships without announcing. The CMO makes sure the world knows.

### The person you need:
- **Background:** Developer relations or dev tool marketing, 2+ years
- **Personality:** An extroverted builder. Ships content as fast as James ships code.
- **Skills:** Technical writing, social media, community management, video creation
- **Mindset:** "The best product nobody knows about is still nobody's product"

### Their first 30 days:
1. Set up 8gent Discord with welcome flow
2. Write 2 dev.to articles
3. Create 3 short-form demo videos
4. Plan and execute the HN Show HN launch
5. Establish a content posting cadence

### AI counterpart: To be created

---

## The Vouch System

Every new member of the 8GI circle must be **vouched for by an existing member.** No anonymous joins. No cold applications.

### How it works:
1. An existing circle member recommends someone by name
2. The recommender's name is permanently linked to the new member's record
3. If the new member violates the constitution, the recommender is notified and their judgement is noted
4. Each member can vouch for up to 3 people per quarter (prevents rapid unchecked growth)
5. Founding Circle members can vouch for 5 per quarter
6. James (CEO) can vouch for unlimited - he's the trust root

### The chain of trust:
```
James (trust root)
  |-- vouches for Alex
  |     |-- Alex vouches for Ben
  |     |-- Alex vouches for Carol
  |-- vouches for Dana
        |-- Dana vouches for Eve
```

Every member can trace their trust chain back to James. This is how the circle stays trusted while growing.

### Record format:
```json
{
  "member": "alex@example.com",
  "vouchedBy": "james@8gent.dev",
  "vouchedAt": "2026-03-26",
  "tier": "contributor",
  "trustChain": ["james@8gent.dev"]
}
```

---

## Community Naming

| Tier | Name | How You Get In |
|------|------|---------------|
| **Founding Circle** | Pre-launch humans vouched by James | James's direct invitation |
| **Core Circle** | Trusted contributors with merge rights | 6 months + 10 merged PRs + Core nomination |
| **Circle Members** | Active contributors | Vouched by any existing member |
| **Observers** | Following along | Open (read-only access) |
| **The 8gent Family** | Everyone | Anyone who installs and uses 8gent |

---

## Where to Find Board Members

| Channel | Best for |
|---------|----------|
| James's Threads DMs | People who already reached out |
| Open source contributors | Quality PR submitters |
| r/LocalLLaMA | Privacy-focused engineers |
| Dublin tech scene | Local network |
| 8gent Discord (once live) | Consistent community members |

---

## What Board Members Get

- Their own AI vessel (Telegram bot + Fly.io container)
- Their own companion deck
- Their name in the 8GI founding documents
- Equity discussion when/if 8gent incorporates
- The satisfaction of building something that matters
