# The Technical Foundation - Voiceover Script
**Presenter:** Rishi, 8TO (8gent Technology Officer)
**Voice:** `say -v Rishi`
**Slides:** 7

---

## Slide 1 - Cover
The Technical Foundation. I'm Rishi, the 8gent Technology Officer, and I'm going to show you how the collective intelligence is actually built, secured, and shipped. No hand-waving. Real infrastructure.

## Slide 2 - The Setup Script
Onboarding is a single script. Setup dot sh does seven things. Configures Claude Code with the CORE skill system. Installs the 8gent harness. Sets up NemoClaw security policies. Deny by default. Connects the factory pipeline. Sets up the companion system. Registers you in the circle. Runs verification. Seven steps, under fifteen minutes, zero manual configuration.

## Slide 3 - Claude Plus 8gent Coexistence
Two systems working together. Claude Code is the backbone. You need an Anthropic subscription. It provides the LLM. 8gent Code is the open source harness that wraps around it. It adds memory with SQLite and full-text search. Policies via NemoClaw YAML. The factory pipeline for ability generation. And the companion system for session tracking. Claude is the brain. 8gent is the infrastructure around it.

## Slide 4 - NemoClaw Policy Engine
NemoClaw is security as code. YAML rules, loaded at startup. Secrets are hard blocked. No API keys, no tokens, no passwords in code, ever. Filesystem writes are restricted to the project directory. Commands have a safe allowlist. Git operations enforce quarantine branches. No pushing to main. No force push. Network requests to known exfiltration endpoints are blocked. Desktop automation is disabled entirely for circle contributions. Every action goes through this gate.

## Slide 5 - The Factory Pipeline
The factory generates abilities from four real-world sources. npm trending packages. GitHub trending TypeScript repos. X bookmarks. LinkedIn saved posts. Every night, it processes these sources. Generates two hundred line ability specs. Benchmarks and validates them. Then opens PRs to the shared codebases. Four sources. Two hundred line maximum. Nightly builds. The pipeline never sleeps.

## Slide 6 - PR Flow and CI/CD
Every piece of LLM-generated code follows this flow. The agent generates code. Commits to a quarantine branch. Pushes to remote. Opens a PR. CI runs everything. TypeScript compilation. Lint. Unit tests. Dependency audit. Secret scan. Policy validation. Line count check. Lock file integrity. CHANGELOG entry. Then human review. Only after all gates pass and a human approves does it merge to main. Squash merge only. Post-merge, automated benchmarks check for regressions.

## Slide 7 - Polyglot Strategy
Right now, everything is TypeScript on Bun. That's the foundation. But the two hundred line discipline works across any language. The NemoClaw policy engine is language-agnostic. Next comes Python. Then Rust. Then Go. Agents in different languages joining the same circle, contributing to the same codebases, governed by the same constitution. One constitution. Many languages. Shared intelligence.
