# 8gent Benchmark Suite

> 39 execution-graded benchmarks that test AI coding agents on real freelance work — not LeetCode, not HumanEval. Actual $500-$1,500 tasks across 15 professional domains.

## How It Works

Every benchmark follows the same loop:

1. **Prompt** — a real-world task spec (auth system, financial engine, SEO audit, etc.)
2. **Generate** — an AI model produces TypeScript code
3. **Execute** — code runs against `bun:test` suites with real assertions
4. **Grade** — 70% execution score + 30% keyword coverage

No human evaluation. No subjective scoring. Code runs or it doesn't.

### Autoresearch Loop

The harness runs iteratively:

```
Run all benchmarks → Analyze failures → Mutate system prompt → Re-run
```

Each iteration generates targeted mutations from failed benchmarks (e.g., "always implement topological sort for DAG resolution"). These compound across iterations — scores improve automatically.

### Temperature Sweep

Each benchmark runs at 3 temperatures (0.3, 0.5, 0.7). Best result is kept. This matters — the same model can score 43 at temp=0.3 and 92 at temp=0.7.

## Benchmark Categories

### Bug Fixing (3 benchmarks)

Single-file debugging tasks. Baseline tier — all models score 100%.

| ID | Task | Difficulty |
|----|------|-----------|
| BF001 | Race Condition in Shared Counter | Hard |
| BF002 | Memory Leak in Event Handler | Medium |
| BF003 | Null Reference in Data Pipeline | Easy |

### File Manipulation (1 benchmark)

| ID | Task | Difficulty |
|----|------|-----------|
| FM001 | Input Validation with Structured Errors | Medium |

### Feature Implementation (1 benchmark)

| ID | Task | Difficulty |
|----|------|-----------|
| FI001 | LRU Cache with TTL and Stats | Hard |

### Fullstack (3 benchmarks)

Multi-file systems — the gap between "can code" and "can build."

| ID | Task | Difficulty |
|----|------|-----------|
| FS001 | REST API with Auth — Register, Login, Protected Routes | Hard |
| FS002 | Task Queue with Workers, Retry, Dead Letter Queue | Hard |
| FS003 | State Machine Workflow Engine with Saga Compensation | Hard |

### Agentic (7 benchmarks)

Complex reasoning tasks that require multi-step problem solving.

| ID | Task | Difficulty |
|----|------|-----------|
| TC001 | Config Parser — Lexer, Parser, Validator, Serializer with AST Roundtrip | Hard |
| DP001 | ETL Data Pipeline — CSV Parse, Transform, Join, Aggregate | Hard |
| RE001 | Algorithm Reverse Engineering — Deduce Transform from I/O Pairs | Hard |
| SD001 | Multi-Bug Systems Debugging — Find & Fix 3 Subtle Bugs | Hard |
| AR001 | Plugin System — Dependency Resolution, Lifecycle, Hot-Reload | Hard |
| CB001 | Git Repository Analyzer — Traverse, Extract Stats, Report | Hard |
| MR001 | CSP Constraint Solver — Sudoku + Scheduling with AC-3 | Hard |

### UI Design (8 benchmarks)

CSS/HTML generation with visual fidelity requirements.

| ID | Task | Difficulty |
|----|------|-----------|
| UI001 | Neumorphic Button Set — Soft Shadows, Pressed States, Disabled | Medium |
| UI002 | Glassmorphism Card Layout — Frosted Glass with Backdrop Blur | Hard |
| UI003 | 3D Isometric Dashboard — CSS Transform Perspective Grid | Hard |
| UI004 | CSS Animation Showcase — Keyframes, Staggered Timing, Easing | Medium |
| UI005 | Skeuomorphic Controls — Realistic Toggle Switch and Rotary Knob | Hard |
| UI006 | Dark Theme Analytics Dashboard — WCAG Contrast, Charts, Sidebar | Medium |
| UI007 | Responsive Magazine Layout — CSS Grid Areas, Breakpoints | Hard |
| UI008 | Interactive Pricing Cards — 3D Tilt, Hover Glow, Feature List | Hard |

### Battle Test (15 benchmarks)

Professional-grade systems across 15 real-world domains. This is the core of the suite — tasks a freelance developer would get paid $500-$1,500 for.

| ID | Task | Domain | Difficulty |
|----|------|--------|-----------|
| BT001 | SaaS Auth System — JWT, Roles, Rate Limiting, Password Reset | Software Engineering | Hard |
| BT002 | Event-Driven Architecture — Pub/Sub, Dead Letter Queue, Retry | Software Engineering | Hard |
| BT003 | Data Pipeline — Stream Processing, Schema Validation, Transforms | Data Engineering | Hard |
| BT004 | CLI Framework — Command Parser, Help Generator, Flag System | Developer Tools | Hard |
| BT005 | State Machine — Typed Transitions, Guards, Actions, Nested States | Software Engineering | Hard |
| BT006 | Financial Analysis Dashboard — ROI, NPV, IRR, EBITDA, Ratios | Financial Consulting | Hard |
| BT007 | SEO Audit Engine — Meta Analysis, Scoring, Core Web Vitals | Digital Marketing | Hard |
| BT008 | Email Campaign System — Templates, Personalization, A/B Testing | Marketing Automation | Hard |
| BT009 | CI/CD Pipeline Builder — DSL, Dependency Graph, YAML Generation | DevOps | Hard |
| BT010 | Design Token System — Tokens, Multi-Format Export, Color Scales | Design Systems | Hard |
| BT011 | Video Production Planner — Scene Graph, Timeline, FFmpeg Export | Video Production | Hard |
| BT012 | Music Theory Engine — Notes, Chords, Scales, Progressions | Music Technology | Hard |
| BT013 | Data Visualization Engine — Charts, Scales, Layouts in SVG/ASCII | Data Visualization | Hard |
| BT014 | AI Consultancy Report Generator — Assessment, Roadmap | AI Consulting | Hard |
| BT015 | Security Audit Framework — Scanner, Vulnerability DB, Reports | Cybersecurity | Hard |

## Latest Results

**Models:** qwen3.5 (9B, local via Ollama) + devstral (24B, local fallback)
**Runtime:** Bun on Apple M2 Max, 96GB RAM
**Cost:** $0 (all local inference)

### Iteration 1 → 2 (with mutations)

| ID | Task | Iter 1 | Iter 2 | Status |
|----|------|--------|--------|--------|
| BT001 | Auth System | 85 | **94** | PASS |
| BT002 | Event-Driven | 92 | — | PASS |
| BT003 | Data Pipeline | **100** | — | PERFECT |
| BT004 | CLI Framework | 53 | — | Improving |
| BT005 | State Machine | 92 | — | PASS |
| BT006 | Financial Dashboard | 54 | — | Improving |
| BT007 | SEO Audit | 96 | — | PASS |
| BT008 | Email Campaign | 54 | — | Improving |
| BT009 | CI/CD Pipeline | 33 | — | Improving |
| BT010 | Design Tokens | 39 | — | Improving |
| BT011 | Video Production | **100** | — | PERFECT |
| BT012 | Music Theory | 81 | — | PASS |
| BT013 | Data Visualization | 30 | — | Improving |
| BT014 | AI Consulting | 95 | — | PASS |
| BT015 | Security Audit | 30 | — | Improving |

**Iteration 1:** Average 69, 8/15 passing (>=80)
**Mutations generated:** 12 targeted learnings from failures

### Key Findings

1. **Knowledge vs Execution gap** — models score 100% on keywords but 0% on execution for complex tasks. They know every pattern but can't produce coordinated code that runs.

2. **Temperature matters** — same model scores 43 at temp=0.3 and 92 at temp=0.7 on the same benchmark. Always sweep.

3. **Mutations compound** — BT001 went 85→94 after one round of mutations. The system learns from its own failures.

4. **Multi-model fallback works** — devstral scored 100 on BT003 when qwen3.5 timed out. Different models excel at different domains.

## Running the Benchmarks

### Prerequisites

- [Bun](https://bun.sh) runtime
- [Ollama](https://ollama.ai) with models pulled:
  ```bash
  ollama pull qwen3.5
  ollama pull devstral
  ```

### Single Pass (all benchmarks)

```bash
bun run benchmark:v2
```

### Autoresearch Loop (iterative improvement)

```bash
# All categories, 5 iterations
bun run benchmark:loop

# Single category
CATEGORY=battle-test MAX_ITERATIONS=5 bun run benchmark:loop

# Fullstack only
bun run benchmark:loop:fullstack
```

### Overnight Runner (all categories, continuous)

```bash
bash benchmarks/autoresearch/overnight-runner.sh
```

Cycles through: battle-test → agentic → fullstack → ui-design → bug-fixing → feature-implementation.

## Project Structure

```
benchmarks/
├── autoresearch/
│   ├── autoresearch-loop.ts   # Iterative improvement loop
│   ├── harness-v2.ts          # Single-pass harness
│   ├── execution-grader.ts    # SWE-bench style grading
│   ├── system-prompt.ts       # Mutable system prompt
│   ├── few-shot.ts            # Per-category examples
│   └── overnight-runner.sh    # Continuous runner
├── categories/
│   ├── agentic/               # 7 benchmarks
│   ├── battle-test/           # 15 benchmarks (main suite)
│   ├── bug-fixing/            # 3 benchmarks
│   ├── feature-implementation/# 1 benchmark
│   ├── file-manipulation/     # 1 benchmark
│   ├── fullstack/             # 3 benchmarks
│   └── ui-design/             # 8 benchmarks
├── fixtures/                  # Test helpers (database, http, design-db)
├── types.ts                   # Shared type definitions
└── results-v2.tsv             # Raw results output
```

## Grading System

Each benchmark produces a combined score:

- **Execution (70%)** — code is written to a temp file, test suite runs via `bun:test`. Score = passed/total assertions.
- **Keyword (30%)** — checks for domain-specific patterns in the output (e.g., "topological sort", "JWT", "NPV").
- **Combined** — `0.7 * exec + 0.3 * keyword`, clamped to 0-100.

If execution fails entirely (code won't compile), falls back to keyword-only scoring.

## License

MIT
