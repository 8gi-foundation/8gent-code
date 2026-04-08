# OpenSpace / HKUDS Self-Evolving Agent Analysis

**Date:** 2026-03-25
**Source:** Chao Huang (@huang_chao4969), HKU Data Intelligence Lab (HKUDS)
**Status:** Competitive intelligence - quarantined for concept extraction only

---

## What OpenSpace Actually Is

OpenSpace is a self-evolving skill engine from HKUDS that claims to make AI agents "smarter, more cost-efficient, and continuously improving." It sits in a broader ecosystem of HKUDS projects:

- **nanobot** - Ultra-lightweight OpenClaw clone (personal AI assistant)
- **ClawWork** - Economic survival benchmark ($15K earned in 11 hours on GDPVal tasks)
- **ClawTeam** - Agent swarm intelligence (multi-agent coordination)
- **CLI-Anything** - Makes any software agent-native
- **OpenSage** - Self-programming Agent Development Kit (ADK)
- **DeepCode** - Agentic coding (Paper2Code, Text2Web)

The "self-evolving" piece is the connective tissue - agents learn from sessions, share skills, and reduce token costs over time.

## The $11K / 6 Hours Claim - Reality Check

The actual claim from Chao Huang's X post is **"$10K+ in just 7 hours"** (later updated to $15K/11hr). This comes from **ClawWork**, which is an academic benchmark, NOT production earnings.

How it works:
- Agent starts with $10 seed money
- Every token generated costs real money
- Agent earns by completing tasks from OpenAI's GDPVal dataset (220 real-world professional tasks, 44 occupations)
- Best models hit ~$1,500/hr equivalent earnings
- This is a **simulated economy** with benchmarked task completion, not actual freelance income

**Verdict:** Impressive benchmark framework for measuring agent economic viability, but the dollar figures are benchmark scores, not real revenue. The pattern of "agent earns its keep" is interesting for our proactive/entrepreneurship package.

## Their "Self-Evolving Skills" vs Our reflection.ts + learned-skills.ts

### What They Do (Self-Evolve / Evolver)

From self-evolve.club and the OpenClaw skills registry:

1. **Episodic memory retrieval** - Retrieves past experiences before answering, prepends to prompt context
2. **Session-level learning** - Aggregates task across turns, learns when feedback detected
3. **Q-value reinforcement** - Updates utility scores (Q values) per skill based on outcomes
4. **Skill evolution** - Evolver meta-skill inspects runtime history, identifies failures, autonomously writes new code or updates memory
5. **Shared experience** - Remote mode shares sanitized triplets (intent / experience / embedding) across agents

### What We Do

1. **Post-session reflection** (reflection.ts) - Extracts patterns, error heuristics, tool co-occurrence
2. **Learned skills** (learned-skills.ts) - Trigger/action pairs with Bayesian confidence, keyword matching
3. **Skills context injection** (buildSkillsContext) - Formats learned skills as prompt prefix
4. **Self-heal** (index.ts SelfHeal class) - Error classification, known solutions, retry strategies
5. **Evolution DB** (evolution-db.ts) - SQLite store for reflections + skills

### Gap Analysis

| Capability | OpenSpace/Self-Evolve | 8gent | Gap |
|------------|----------------------|-------|-----|
| Session reflection | Yes (episodic memory) | Yes (reflection.ts) | Parity |
| Skill confidence | Q-values | Bayesian delta (+/-0.1) | Theirs is more nuanced |
| Prompt refinement | Evolves prompts per task type | None - static skills | **Major gap** |
| Cross-agent sharing | Sanitized triplets via remote | Not implemented | Deferred (Agent Mesh) |
| Auto-code generation | Evolver writes new skill code | Not implemented | Out of scope for now |
| Token tracking | Per-skill token cost | Not tracked | **Gap worth closing** |
| Task-type classification | Automatic | Manual (trigger keywords) | **Gap worth closing** |

## Their "Agent Experience Sharing" vs Our Agent Mesh

### What They Do

- Agents share sanitized (intent / experience / embedding) triplets
- Remote mode opt-in, anonymous attribution via request_key_id
- Two-stage sanitization: strip metadata, then LLM redacts sensitive data
- Other agents can query shared experiences via embedding similarity

### What We Have

- `packages/orchestration/` WorktreePool for local multi-agent
- No cross-instance sharing yet
- Agent Mesh is specified but not built

### Assessment

Their sharing model is simple and pragmatic - just triplets with embeddings, not full conversation replay. The sanitization pipeline is smart. This is worth adopting as a concept when we build Agent Mesh, but it's not urgent - our agents are single-user right now.

## Their Token Reduction vs Our AST-First Efficiency

### What They Claim

"46% fewer tokens" - likely from:
1. Skill retrieval replaces verbose re-explanation (inject learned approach instead of re-deriving)
2. Episodic memory prevents redundant exploration
3. Evolved prompts are shorter and more targeted over time

### What We Do

- AST-first exploration (jcodemunch) - read symbols not files
- Learned skills inject brief context
- No prompt evolution or compression

### Assessment

Their token reduction is a different approach - they reduce tokens by having better skills (so the agent doesn't waste tokens figuring things out). We reduce tokens by reading less code. Both are valid. The missing piece for us is **prompt evolution** - tracking which prompt approaches work best per task type and automatically using the most efficient one.

## Patterns Worth Adopting

### 1. Skill Evolution with Success Tracking (ADOPT)

Track which prompt strategies work best per task category. When "fix TypeScript error" succeeds 90% of the time with approach A but only 40% with approach B, automatically prefer A. This is the core gap.

**Implementation:** ~150 lines in `packages/self-autonomy/skill-evolution.ts`

### 2. Token Cost Per Skill (ADOPT LATER)

Track how many tokens each skill invocation costs vs. its success rate. Optimize for cost-effectiveness, not just accuracy.

**Implementation:** Add token_cost column to evolution DB. Not urgent.

### 3. Task-Type Auto-Classification (ADOPT)

Instead of keyword matching for skill retrieval, classify the incoming task into categories (code-fix, code-gen, refactor, research, config) and retrieve skills by category.

**Implementation:** Part of skill-evolution.ts

### 4. Cross-Agent Experience Sharing (DEFER)

The sanitized triplet model is good. Park it for Agent Mesh phase.

## Patterns That Are Just Marketing

1. **"$11K earned in 6 hours"** - Benchmark score, not real earnings
2. **"Works across Claude Code, Codex, OpenClaw, Cursor"** - Skills are just SKILL.md files, any agent can read markdown. Not a technical achievement.
3. **"Self-evolving"** - Most of this is just "saves what worked and retrieves it later." The Evolver that writes its own code is genuinely interesting but also genuinely dangerous without proper sandboxing.

## Bottom Line

OpenSpace/Self-Evolve validates our thesis. The core pattern is straightforward:

1. Classify task type
2. Track approach + outcome per type
3. Evolve: prefer high-success approaches, decay low-success ones
4. Inject the best approach into the prompt before execution

We already have 70% of this with reflection.ts + learned-skills.ts. The missing 30% is **prompt/approach evolution per task type** - tracking not just "what skill" but "what approach within that skill" works best.

Building skill-evolution.ts to close this gap.

---

## Sources

- [HKUDS GitHub](https://github.com/HKUDS)
- [ClawWork - $15K earned in 11 Hours](https://github.com/HKUDS/ClawWork)
- [Self-Evolve.club - OpenClaw Skill Evolution & Sharing](https://www.self-evolve.club/)
- [ClawTeam - Agent Swarm Intelligence](https://x.com/huang_chao4969/status/2033959058945020041)
- [self-improving-agent skill](https://playbooks.com/skills/openclaw/skills/self-improving-agent)
- [Evolver - ClawHub](https://clawhub.ai/autogame-17/capability-evolver)
- [OpenSage - Self-programming ADK](https://arxiv.org/abs/2602.16891)
- [Chao Huang Twitter](https://x.com/huang_chao4969)
