# 8gent User Personas

## Primary Persona: The Cap-Frustrated Power User

**Name:** Alex Rivera
**Age:** 28
**Location:** Remote (Bali)
**Occupation:** Full-stack indie hacker, SaaS builder
**Tech Stack:** Next.js, Tailwind, Supabase, Bun
**Current Tools:** Claude Code (primary), Cursor (secondary)

**Pain Points:**
- **Hits Claude Code usage caps daily** — gets throttled mid-task during heavy coding sessions, breaking flow
- Paying $20/mo for Claude Pro + API overages, costs unpredictable
- Uncomfortable sending client code to Anthropic's servers
- Wants agentic capabilities but resents the subscription treadmill
- Tried Aider with local models but found it too basic and conversational

**Trigger Moment:**
Gets throttled by Claude Code at 2am while shipping a feature. Sees "you've reached your usage limit" for the third time this week. Rage-searches "Claude Code alternative unlimited."

**Goals:**
- Unlimited AI coding without caps or throttling
- Keep client code local and private
- Same agentic power as Claude Code but on their terms
- A tool that feels good to use, not just functional

**How 8gent Wins:**
- Runs via Ollama — unlimited, $0, no throttling, ever
- Code never leaves their machine
- BMAD methodology provides structure Claude Code lacks
- Rich TUI makes the terminal experience genuinely enjoyable
- Can still use Claude/GPT via OpenRouter when they want cloud model quality

**Quote:** "I love what Claude Code does. I hate that Anthropic decides when I've had enough."

---

## Secondary Persona: The Air-Gapped Enterprise Dev

**Name:** Priya Sharma
**Age:** 35
**Location:** San Francisco, CA
**Occupation:** Senior Software Engineer, Fortune 500 (defense/finance/healthcare)
**Tech Stack:** Java/Spring, Kubernetes, on-prem infra
**Current Tools:** None (blocked by security policy)

**Pain Points:**
- **Cannot use Claude Code, Copilot, or any cloud AI tool** — security policy forbids sending code to external servers
- Watches indie dev friends 10x their productivity with AI while she's stuck
- IT approved Ollama for local use but there's no good agentic interface for it
- Needs something that can pass a security audit and run fully air-gapped

**Trigger Moment:**
IT finally approves local LLM usage. She needs an agent that runs 100% on-prem with zero external calls. Claude Code is disqualified immediately. 8gent is the only real option.

**Goals:**
- AI coding assistance that works behind the firewall
- Must be auditable (MIT license, open source, no telemetry)
- Structured, predictable outputs (not creative hallucination)
- Integrates with existing CI/CD and tooling

**How 8gent Wins:**
- 100% local execution — passes any security audit
- MIT license — legal can review every line of code
- BMAD methodology — predictable, documented, auditable workflows
- No telemetry, no phone-home, no external dependencies in local mode

**Quote:** "Claude Code is great — if you're allowed to use it. I'm not."

---

## Tertiary Persona: The Open Source True Believer

**Name:** Jordan Lee
**Age:** 26
**Location:** Berlin, Germany
**Occupation:** OSS devtools maintainer
**Tech Stack:** Rust, TypeScript, WebAssembly
**Current Tools:** Aider + local models, occasionally Claude Code

**Pain Points:**
- Philosophically opposed to closed-source AI tools controlling the dev workflow
- Uses Aider but finds it limited — wants real agentic capabilities
- Claude Code is powerful but it's closed-source, cloud-locked, and Anthropic controls the roadmap
- Wants to contribute to the tool they use daily

**Trigger Moment:**
Anthropic changes Claude Code pricing/terms. Realizes they've built their entire workflow on a tool they can't modify, fork, or self-host. Decides to switch to something open.

**Goals:**
- Fully open-source AI coding agent they can contribute to
- Model-agnostic (not locked to one vendor's API)
- Community-driven roadmap, not corporate-driven
- Can customize and extend for their specific workflow

**How 8gent Wins:**
- MIT license, fully open, community-driven
- 15+ modular packages — easy to contribute to and extend
- Model-agnostic by design
- MCP + toolshed for custom integrations
- The autoresearch system means community contributions improve the agent for everyone

**Quote:** "I don't trust any tool I can't fork."

---

## Anti-Persona: The Happy Claude Code User

**Name:** Taylor Chen
**Age:** 32
**Location:** NYC
**Occupation:** Staff engineer at a well-funded startup
**Current Tools:** Claude Code Max ($200/mo), loves it

**Why NOT a Fit (right now):**
- Budget is not a concern — company pays for Claude Code Max
- Never hits caps on the Max plan
- Doesn't care about local execution — trusts Anthropic
- Values raw model quality above all else and Claude Opus is the best
- Finds the terminal just fine as-is, doesn't need a rich TUI

**Conversion Path:**
This persona is NOT our target today. But they become a target when:
- They leave the well-funded startup and go indie (Alex persona)
- Their company tightens AI spending and downgrades their plan
- They start working on sensitive code and privacy suddenly matters
- Anthropic changes terms/pricing in ways they don't like
- A local model closes the quality gap enough that freedom > marginal model quality

**Key Insight:** Don't waste marketing dollars on happy high-tier Claude Code users. Target the frustrated mid-tier users who feel the caps and costs.